package download

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Result struct {
	Bytes  int64
	SHA256 string
	SHA1   string
}

type Progress struct {
	Bytes int64
	Total int64 // -1 if unknown
}

type ProgressFunc func(p Progress)

func DownloadFile(ctx context.Context, url string, destPath string, expectedSHA256 string) (Result, error) {
	return DownloadFileWithChecksums(ctx, url, destPath, expectedSHA256, "")
}

func DownloadFileWithChecksums(ctx context.Context, url string, destPath string, expectedSHA256 string, expectedSHA1 string) (Result, error) {
	return DownloadFileWithChecksumsProgress(ctx, url, destPath, expectedSHA256, expectedSHA1, nil)
}

func DownloadFileWithChecksumsProgress(ctx context.Context, url string, destPath string, expectedSHA256 string, expectedSHA1 string, onProgress ProgressFunc) (Result, error) {
	url = strings.TrimSpace(url)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return Result{}, errors.New("only http/https URLs are supported")
	}
	if strings.TrimSpace(destPath) == "" {
		return Result{}, errors.New("destPath is empty")
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return Result{}, err
	}

	tmpPath := destPath + ".partial"
	_ = os.Remove(tmpPath)

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return Result{}, err
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(tmpPath)
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("User-Agent", "ElegantMC-Daemon/0.1.0")

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("download failed: status=%d", resp.StatusCode)
	}

	total := resp.ContentLength

	hasher := sha256.New()
	hasher1 := sha1.New()
	w := io.MultiWriter(f, hasher, hasher1)
	buf := make([]byte, 32*1024)
	var n int64
	lastEmit := time.Now()
	for {
		nr, er := resp.Body.Read(buf)
		if nr > 0 {
			nw, ew := w.Write(buf[:nr])
			if ew != nil {
				return Result{}, ew
			}
			if nw != nr {
				return Result{}, errors.New("short write")
			}
			n += int64(nr)

			if onProgress != nil && time.Since(lastEmit) >= 1*time.Second {
				onProgress(Progress{Bytes: n, Total: total})
				lastEmit = time.Now()
			}
		}
		if er == io.EOF {
			break
		}
		if er != nil {
			return Result{}, er
		}
	}
	if onProgress != nil {
		onProgress(Progress{Bytes: n, Total: total})
	}

	if err := f.Close(); err != nil {
		return Result{}, err
	}

	sum256 := hex.EncodeToString(hasher.Sum(nil))
	sum1 := hex.EncodeToString(hasher1.Sum(nil))
	if expectedSHA256 != "" && !strings.EqualFold(sum256, strings.TrimSpace(expectedSHA256)) {
		return Result{}, errors.New("sha256 mismatch")
	}
	if expectedSHA1 != "" && !strings.EqualFold(sum1, strings.TrimSpace(expectedSHA1)) {
		return Result{}, errors.New("sha1 mismatch")
	}

	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return Result{}, err
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		return Result{}, err
	}

	return Result{Bytes: n, SHA256: sum256, SHA1: sum1}, nil
}
