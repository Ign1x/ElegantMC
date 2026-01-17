package commands

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"hash"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"elegantmc/daemon/internal/sandbox"
)

const (
	maxUploadSessions    = 4
	maxUploadTotalBytes  = 512 * 1024 * 1024 // 512MB
	maxUploadChunkBytes  = 512 * 1024        // 512KB per chunk (decoded)
	uploadSessionTimeout = 30 * time.Minute
)

type uploadManager struct {
	fs *sandbox.FS

	mu       sync.Mutex
	sessions map[string]*uploadSession
}

type uploadSession struct {
	id      string
	relPath string
	destAbs string
	tmpAbs  string

	started time.Time
	lastAt  time.Time

	mu     sync.Mutex
	file   *os.File
	hasher hash.Hash
	bytes  int64
}

type uploadBeginResult struct {
	UploadID string `json:"upload_id"`
	Path     string `json:"path"`
}

type uploadCommitResult struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func newUploadManager(fs *sandbox.FS) *uploadManager {
	return &uploadManager{
		fs:       fs,
		sessions: make(map[string]*uploadSession),
	}
}

func (m *uploadManager) Begin(_ context.Context, relPath string) (uploadBeginResult, error) {
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return uploadBeginResult{}, errors.New("path is required")
	}

	// Normalize the returned path so the Panel can safely reuse it.
	relPath = filepath.ToSlash(filepath.Clean(relPath))
	relPath = strings.TrimPrefix(relPath, "/")
	if relPath == "." || relPath == "" {
		return uploadBeginResult{}, errors.New("path is required")
	}

	destAbs, err := m.fs.Resolve(relPath)
	if err != nil {
		return uploadBeginResult{}, err
	}
	if destAbs == m.fs.Root() {
		return uploadBeginResult{}, errors.New("path must be a file, not the sandbox root")
	}

	expired := m.cleanupExpired(time.Now())

	m.mu.Lock()
	if len(m.sessions) >= maxUploadSessions {
		m.mu.Unlock()
		for _, sess := range expired {
			_ = abortSession(sess)
		}
		return uploadBeginResult{}, errors.New("too many concurrent uploads")
	}
	m.mu.Unlock()

	id, err := randomID()
	if err != nil {
		return uploadBeginResult{}, err
	}

	if err := os.MkdirAll(filepath.Dir(destAbs), 0o755); err != nil {
		return uploadBeginResult{}, err
	}

	tmpAbs := filepath.Join(filepath.Dir(destAbs), "."+filepath.Base(destAbs)+".upload-"+id+".partial")
	_ = os.Remove(tmpAbs)

	f, err := os.OpenFile(tmpAbs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return uploadBeginResult{}, err
	}

	sess := &uploadSession{
		id:      id,
		relPath: relPath,
		destAbs: destAbs,
		tmpAbs:  tmpAbs,
		started: time.Now(),
		lastAt:  time.Now(),
		file:    f,
		hasher:  sha256.New(),
		bytes:   0,
	}

	m.mu.Lock()
	if len(m.sessions) >= maxUploadSessions {
		m.mu.Unlock()
		_ = abortSession(sess)
		for _, ex := range expired {
			_ = abortSession(ex)
		}
		return uploadBeginResult{}, errors.New("too many concurrent uploads")
	}
	m.sessions[id] = sess
	m.mu.Unlock()

	for _, ex := range expired {
		_ = abortSession(ex)
	}
	return uploadBeginResult{UploadID: id, Path: relPath}, nil
}

func (m *uploadManager) Chunk(_ context.Context, uploadID string, b64 string) (int64, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return 0, errors.New("upload_id is required")
	}
	b64 = strings.TrimSpace(b64)
	if b64 == "" {
		return 0, errors.New("b64 is required")
	}

	buf, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return 0, errors.New("invalid b64")
	}
	if len(buf) > maxUploadChunkBytes {
		return 0, errors.New("chunk too large")
	}

	sess := m.getSession(uploadID)
	if sess == nil {
		return 0, errors.New("unknown upload_id")
	}

	now := time.Now()

	sess.mu.Lock()
	if now.Sub(sess.lastAt) > uploadSessionTimeout {
		sess.mu.Unlock()
		_ = m.Abort(context.Background(), uploadID)
		return 0, errors.New("upload expired")
	}
	if sess.file == nil {
		sess.mu.Unlock()
		return 0, errors.New("upload not active")
	}
	if sess.bytes+int64(len(buf)) > maxUploadTotalBytes {
		sess.mu.Unlock()
		_ = m.Abort(context.Background(), uploadID)
		return 0, errors.New("file too large")
	}

	if _, err := sess.file.Write(buf); err != nil {
		sess.mu.Unlock()
		_ = m.Abort(context.Background(), uploadID)
		return 0, err
	}
	_, _ = sess.hasher.Write(buf) // sha256.Write never returns error
	sess.bytes += int64(len(buf))
	sess.lastAt = now
	total := sess.bytes
	sess.mu.Unlock()

	return total, nil
}

func (m *uploadManager) Commit(_ context.Context, uploadID string, expectedSHA256 string) (uploadCommitResult, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return uploadCommitResult{}, errors.New("upload_id is required")
	}
	expectedSHA256 = strings.TrimSpace(expectedSHA256)

	m.mu.Lock()
	sess := m.sessions[uploadID]
	if sess == nil {
		m.mu.Unlock()
		return uploadCommitResult{}, errors.New("unknown upload_id")
	}
	delete(m.sessions, uploadID)
	m.mu.Unlock()

	sess.mu.Lock()
	defer sess.mu.Unlock()

	if time.Since(sess.lastAt) > uploadSessionTimeout {
		_ = abortSession(sess)
		return uploadCommitResult{}, errors.New("upload expired")
	}
	if sess.file == nil {
		return uploadCommitResult{}, errors.New("upload not active")
	}
	if err := sess.file.Close(); err != nil {
		_ = abortSession(sess)
		return uploadCommitResult{}, err
	}
	sess.file = nil

	sum := hex.EncodeToString(sess.hasher.Sum(nil))
	if expectedSHA256 != "" && !strings.EqualFold(sum, expectedSHA256) {
		_ = abortSession(sess)
		return uploadCommitResult{}, errors.New("sha256 mismatch")
	}

	if err := os.Chmod(sess.tmpAbs, 0o644); err != nil {
		_ = abortSession(sess)
		return uploadCommitResult{}, err
	}
	if err := os.Rename(sess.tmpAbs, sess.destAbs); err != nil {
		// best-effort replace on platforms that don't allow overwrite.
		_ = os.Remove(sess.destAbs)
		if err2 := os.Rename(sess.tmpAbs, sess.destAbs); err2 != nil {
			_ = abortSession(sess)
			return uploadCommitResult{}, err2
		}
	}

	return uploadCommitResult{
		Path:   sess.relPath,
		Bytes:  sess.bytes,
		SHA256: sum,
	}, nil
}

func (m *uploadManager) Abort(_ context.Context, uploadID string) error {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return errors.New("upload_id is required")
	}

	m.mu.Lock()
	sess := m.sessions[uploadID]
	if sess == nil {
		m.mu.Unlock()
		return errors.New("unknown upload_id")
	}
	delete(m.sessions, uploadID)
	m.mu.Unlock()

	return abortSession(sess)
}

func (m *uploadManager) getSession(uploadID string) *uploadSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[uploadID]
}

func (m *uploadManager) cleanupExpired(now time.Time) []*uploadSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []*uploadSession
	for id, sess := range m.sessions {
		if now.Sub(sess.lastAt) > uploadSessionTimeout {
			delete(m.sessions, id)
			expired = append(expired, sess)
		}
	}
	return expired
}

func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func abortSession(sess *uploadSession) error {
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if sess.file != nil {
		_ = sess.file.Close()
		sess.file = nil
	}
	_ = os.Remove(sess.tmpAbs)
	return nil
}
