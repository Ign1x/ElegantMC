package mc

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"elegantmc/daemon/internal/download"
)

type JavaRuntimeManagerConfig struct {
	CacheDir             string
	AdoptiumAPIBaseURL   string
	Log                  *log.Logger
}

type JavaRuntimeManager struct {
	cfg JavaRuntimeManagerConfig

	mu       sync.Mutex
	inflight map[string]*javaEnsureState
}

type javaEnsureState struct {
	done      chan struct{}
	javaPath  string
	javaMajor int
	err       error
}

type javaCacheInfo struct {
	JavaRel         string `json:"java_rel"`
	Major           int    `json:"major"`
	SHA256          string `json:"sha256"`
	InstalledAtUnix int64  `json:"installed_at_unix"`
}

func NewJavaRuntimeManager(cfg JavaRuntimeManagerConfig) *JavaRuntimeManager {
	if strings.TrimSpace(cfg.AdoptiumAPIBaseURL) == "" {
		cfg.AdoptiumAPIBaseURL = "https://api.adoptium.net"
	}
	return &JavaRuntimeManager{
		cfg:      cfg,
		inflight: make(map[string]*javaEnsureState),
	}
}

func (m *JavaRuntimeManager) EnsureTemurinJRE(ctx context.Context, major int) (string, int, error) {
	if major <= 0 {
		return "", 0, errors.New("invalid java major")
	}
	if strings.TrimSpace(m.cfg.CacheDir) == "" {
		return "", 0, errors.New("java cache dir not configured")
	}
	osID, archID, err := adoptiumOSArch()
	if err != nil {
		return "", 0, err
	}

	key := fmt.Sprintf("temurin-jre-%d-%s-%s", major, osID, archID)

	if javaPath, javaMajor, ok := m.tryLoadCached(major, osID, archID); ok {
		return javaPath, javaMajor, nil
	}

	m.mu.Lock()
	if st, ok := m.inflight[key]; ok {
		done := st.done
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", 0, ctx.Err()
		case <-done:
			return st.javaPath, st.javaMajor, st.err
		}
	}
	st := &javaEnsureState{done: make(chan struct{})}
	m.inflight[key] = st
	m.mu.Unlock()

	javaPath, javaMajor, err := m.installTemurinJRE(ctx, major, osID, archID)

	m.mu.Lock()
	st.javaPath = javaPath
	st.javaMajor = javaMajor
	st.err = err
	close(st.done)
	delete(m.inflight, key)
	m.mu.Unlock()

	return javaPath, javaMajor, err
}

func (m *JavaRuntimeManager) runtimeDir(major int, osID, archID string) string {
	return filepath.Join(m.cfg.CacheDir, fmt.Sprintf("temurin-jre-%d-%s-%s", major, osID, archID))
}

func (m *JavaRuntimeManager) infoPath(major int, osID, archID string) string {
	return filepath.Join(m.runtimeDir(major, osID, archID), "elegantmc-java.json")
}

func (m *JavaRuntimeManager) tryLoadCached(major int, osID, archID string) (string, int, bool) {
	infoPath := m.infoPath(major, osID, archID)
	b, err := os.ReadFile(infoPath)
	if err != nil {
		return "", 0, false
	}
	var info javaCacheInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return "", 0, false
	}
	if info.Major <= 0 || strings.TrimSpace(info.JavaRel) == "" {
		return "", 0, false
	}
	javaAbs := filepath.Join(filepath.Dir(infoPath), filepath.FromSlash(info.JavaRel))
	st, err := os.Stat(javaAbs)
	if err != nil || st.IsDir() {
		return "", 0, false
	}
	return javaAbs, info.Major, true
}

func (m *JavaRuntimeManager) installTemurinJRE(ctx context.Context, major int, osID, archID string) (string, int, error) {
	if err := os.MkdirAll(m.cfg.CacheDir, 0o755); err != nil {
		return "", 0, err
	}

	dir := m.runtimeDir(major, osID, archID)
	if javaPath, javaMajor, ok := m.tryLoadCached(major, osID, archID); ok {
		return javaPath, javaMajor, nil
	}

	tmpDir, err := os.MkdirTemp(m.cfg.CacheDir, fmt.Sprintf("temurin-jre-%d-", major))
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	archiveExt := ".tar.gz"
	if runtime.GOOS == "windows" {
		archiveExt = ".zip"
	}
	archivePath := filepath.Join(tmpDir, "temurin"+archiveExt)

	checksumURL := strings.TrimRight(m.cfg.AdoptiumAPIBaseURL, "/") + fmt.Sprintf(
		"/v3/checksum/latest/%d/ga/%s/%s/jre/hotspot/normal/eclipse",
		major,
		osID,
		archID,
	)
	sha256, err := fetchChecksumSHA256(ctx, checksumURL)
	if err != nil {
		return "", 0, err
	}

	binaryURL := strings.TrimRight(m.cfg.AdoptiumAPIBaseURL, "/") + fmt.Sprintf(
		"/v3/binary/latest/%d/ga/%s/%s/jre/hotspot/normal/eclipse",
		major,
		osID,
		archID,
	)
	if m.cfg.Log != nil {
		m.cfg.Log.Printf("java: downloading temurin jre %d (%s/%s)", major, osID, archID)
	}
	if _, err := download.DownloadFile(ctx, binaryURL, archivePath, sha256); err != nil {
		return "", 0, err
	}

	unpackDir := filepath.Join(tmpDir, "runtime")
	if err := os.MkdirAll(unpackDir, 0o755); err != nil {
		return "", 0, err
	}

	var topDir string
	if strings.HasSuffix(archivePath, ".zip") {
		topDir, err = extractZip(archivePath, unpackDir)
	} else {
		topDir, err = extractTarGz(archivePath, unpackDir)
	}
	if err != nil {
		return "", 0, err
	}

	javaRel, err := discoverJavaRel(unpackDir, topDir)
	if err != nil {
		return "", 0, err
	}
	javaAbs := filepath.Join(unpackDir, filepath.FromSlash(javaRel))
	gotMajor, err := probeJavaMajor(ctx, javaAbs)
	if err != nil {
		return "", 0, err
	}
	if gotMajor != major {
		return "", 0, fmt.Errorf("downloaded java major mismatch: want=%d got=%d", major, gotMajor)
	}

	info := javaCacheInfo{
		JavaRel:         filepath.ToSlash(javaRel),
		Major:           gotMajor,
		SHA256:          sha256,
		InstalledAtUnix: time.Now().Unix(),
	}
	infoPath := filepath.Join(unpackDir, "elegantmc-java.json")
	if err := writeJSONFileAtomic(infoPath, info); err != nil {
		return "", 0, err
	}

	// Replace existing install (if any) after we have a valid runtime.
	_ = os.RemoveAll(dir)
	if err := os.Rename(unpackDir, dir); err != nil {
		return "", 0, err
	}

	return filepath.Join(dir, filepath.FromSlash(javaRel)), gotMajor, nil
}

func writeJSONFileAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func fetchChecksumSHA256(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ElegantMC-Daemon/0.1.0")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksum fetch failed: status=%d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if err != nil {
		return "", err
	}
	sum := strings.TrimSpace(string(b))
	if len(sum) != 64 {
		return "", errors.New("invalid checksum response")
	}
	for _, c := range sum {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			continue
		}
		return "", errors.New("invalid checksum response")
	}
	return strings.ToLower(sum), nil
}

func adoptiumOSArch() (string, string, error) {
	var osID string
	switch runtime.GOOS {
	case "linux":
		osID = "linux"
	case "windows":
		osID = "windows"
	case "darwin":
		osID = "mac"
	default:
		return "", "", fmt.Errorf("unsupported os: %s", runtime.GOOS)
	}

	var archID string
	switch runtime.GOARCH {
	case "amd64":
		archID = "x64"
	case "arm64":
		archID = "aarch64"
	case "386":
		archID = "x86"
	default:
		return "", "", fmt.Errorf("unsupported arch: %s", runtime.GOARCH)
	}
	return osID, archID, nil
}

func discoverJavaRel(rootDir string, topDir string) (string, error) {
	topDir = strings.TrimSpace(topDir)
	if topDir == "" {
		return "", errors.New("cannot determine java root dir")
	}
	candidates := []string{
		path.Join(topDir, "bin", "java"),
		path.Join(topDir, "Contents", "Home", "bin", "java"),
		path.Join(topDir, "bin", "java.exe"),
		path.Join(topDir, "Contents", "Home", "bin", "java.exe"),
	}
	for _, rel := range candidates {
		abs := filepath.Join(rootDir, filepath.FromSlash(rel))
		st, err := os.Stat(abs)
		if err == nil && !st.IsDir() {
			return rel, nil
		}
	}
	return "", errors.New("java binary not found in extracted runtime")
}

func extractTarGz(archivePath string, destDir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return "", err
	}
	topDir := ""

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}
		clean := path.Clean(name)
		if clean == "." || clean == "/" {
			continue
		}
		if strings.HasPrefix(clean, "../") || clean == ".." || strings.HasPrefix(clean, "/") {
			return "", errors.New("tar entry escapes destination")
		}
		if topDir == "" {
			topDir = strings.SplitN(clean, "/", 2)[0]
		}

		outAbs := filepath.Join(destAbs, filepath.FromSlash(clean))
		if !isWithinDir(destAbs, outAbs) {
			return "", errors.New("tar entry escapes destination")
		}

		mode := os.FileMode(hdr.Mode) & 0o777

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(outAbs, mode|0o700); err != nil {
				return "", err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
				return "", err
			}
			dst, err := os.OpenFile(outAbs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(dst, tr); err != nil {
				_ = dst.Close()
				return "", err
			}
			if err := dst.Close(); err != nil {
				return "", err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
				return "", err
			}
			link := hdr.Linkname
			if strings.HasPrefix(link, "/") {
				return "", errors.New("tar symlink is absolute")
			}
			linkClean := filepath.Clean(filepath.FromSlash(link))
			targetAbs := filepath.Clean(filepath.Join(filepath.Dir(outAbs), linkClean))
			if !isWithinDir(destAbs, targetAbs) {
				return "", errors.New("tar symlink escapes destination")
			}
			_ = os.RemoveAll(outAbs)
			if err := os.Symlink(link, outAbs); err != nil {
				return "", err
			}
		default:
			// ignore other entry types
		}
	}

	if topDir == "" {
		return "", errors.New("empty archive")
	}
	return topDir, nil
}

func extractZip(archivePath string, destDir string) (string, error) {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer zr.Close()

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return "", err
	}
	topDir := ""

	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}
		clean := path.Clean(name)
		if clean == "." || clean == "/" {
			continue
		}
		if strings.HasPrefix(clean, "../") || clean == ".." || strings.HasPrefix(clean, "/") {
			return "", errors.New("zip entry escapes destination")
		}
		if topDir == "" {
			topDir = strings.SplitN(clean, "/", 2)[0]
		}

		outAbs := filepath.Join(destAbs, filepath.FromSlash(clean))
		if !isWithinDir(destAbs, outAbs) {
			return "", errors.New("zip entry escapes destination")
		}

		if f.FileInfo().IsDir() || strings.HasSuffix(clean, "/") {
			if err := os.MkdirAll(outAbs, 0o755); err != nil {
				return "", err
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
			return "", err
		}

		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		dst, err := os.OpenFile(outAbs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			_ = rc.Close()
			return "", err
		}
		_, copyErr := io.Copy(dst, rc)
		_ = dst.Close()
		_ = rc.Close()
		if copyErr != nil {
			return "", copyErr
		}
	}

	if topDir == "" {
		return "", errors.New("empty archive")
	}
	return topDir, nil
}

func isWithinDir(rootAbs string, childAbs string) bool {
	rootAbs = filepath.Clean(rootAbs)
	childAbs = filepath.Clean(childAbs)
	if rootAbs == childAbs {
		return true
	}
	if !strings.HasSuffix(rootAbs, string(os.PathSeparator)) {
		rootAbs += string(os.PathSeparator)
	}
	return strings.HasPrefix(childAbs, rootAbs)
}

