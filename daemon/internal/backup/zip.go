package backup

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// ZipDir zips srcDir into destZipPath.
// The archive contains relative paths (no leading slash) and refuses to follow symlinks.
func ZipDir(srcDir string, destZipPath string) (int, error) {
	srcAbs, err := filepath.Abs(srcDir)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(srcAbs)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, errors.New("srcDir is not a directory")
	}
	if strings.TrimSpace(destZipPath) == "" {
		return 0, errors.New("destZipPath is empty")
	}

	tmp := destZipPath + ".partial"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	zw := zip.NewWriter(f)
	committed := false
	defer func() {
		if zw != nil {
			_ = zw.Close()
		}
		if f != nil {
			_ = f.Close()
		}
		if !committed {
			_ = os.Remove(tmp)
		}
	}()

	files := 0
	walkErr := filepath.WalkDir(srcAbs, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcAbs, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(rel, "/") || strings.Contains(rel, "../") || strings.HasPrefix(rel, "../") {
			return errors.New("path escapes source")
		}

		// Refuse symlinks.
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("refuse to zip symlink")
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		if info.IsDir() {
			// Add a directory entry for nicer tools (optional).
			hdr, err := zip.FileInfoHeader(info)
			if err != nil {
				return err
			}
			hdr.Name = rel + "/"
			hdr.Method = zip.Store
			_, err = zw.CreateHeader(hdr)
			return err
		}

		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Method = zip.Deflate

		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}

		src, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(w, src)
		_ = src.Close()
		if copyErr != nil {
			return copyErr
		}
		files++
		return nil
	})
	if walkErr != nil {
		return 0, walkErr
	}

	if err := zw.Close(); err != nil {
		return 0, err
	}
	zw = nil
	if err := f.Close(); err != nil {
		return 0, err
	}
	f = nil
	if err := os.Chmod(tmp, 0o644); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp, destZipPath); err != nil {
		return 0, err
	}
	committed = true
	return files, nil
}

// UnzipToDir extracts zipPath into destDir.
// It refuses symlinks and rejects any entry that escapes destDir.
func UnzipToDir(zipPath string, destDir string) (int, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, err
	}
	defer zr.Close()

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(destAbs, 0o755); err != nil {
		return 0, err
	}

	files := 0
	for _, f := range zr.File {
		if f == nil {
			continue
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			return 0, errors.New("zip contains symlink (refuse)")
		}
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
			return 0, errors.New("zip entry escapes destination")
		}

		outAbs := filepath.Join(destAbs, filepath.FromSlash(clean))
		outAbs = filepath.Clean(outAbs)
		if !hasPathPrefix(outAbs, destAbs) {
			return 0, errors.New("zip entry escapes destination")
		}

		if f.FileInfo().IsDir() || strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(outAbs, 0o755); err != nil {
				return 0, err
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
			return 0, err
		}

		rc, err := f.Open()
		if err != nil {
			return 0, err
		}
		dst, err := os.OpenFile(outAbs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			_ = rc.Close()
			return 0, err
		}
		_, copyErr := io.Copy(dst, rc)
		_ = dst.Close()
		_ = rc.Close()
		if copyErr != nil {
			return 0, copyErr
		}
		files++
	}
	return files, nil
}

func hasPathPrefix(path string, root string) bool {
	path = filepath.Clean(path)
	root = filepath.Clean(root)

	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
		root = strings.ToLower(root)
	}

	if path == root {
		return true
	}
	if !strings.HasSuffix(root, string(os.PathSeparator)) {
		root += string(os.PathSeparator)
	}
	return strings.HasPrefix(path, root)
}
