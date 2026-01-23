package backup

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type ArchiveProgress struct {
	Files int
	Bytes int64
}

type ArchiveProgressFunc func(p ArchiveProgress)

// TarGzDir archives srcDir into destTarGzPath as a .tar.gz.
// The archive contains relative paths (no leading slash) and refuses to follow symlinks.
func TarGzDir(srcDir string, destTarGzPath string, onProgress ArchiveProgressFunc) (int, int64, error) {
	srcAbs, err := filepath.Abs(srcDir)
	if err != nil {
		return 0, 0, err
	}
	info, err := os.Stat(srcAbs)
	if err != nil {
		return 0, 0, err
	}
	if !info.IsDir() {
		return 0, 0, errors.New("srcDir is not a directory")
	}
	if strings.TrimSpace(destTarGzPath) == "" {
		return 0, 0, errors.New("destTarGzPath is empty")
	}

	tmp := destTarGzPath + ".partial"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, 0, err
	}
	committed := false
	defer func() {
		_ = f.Close()
		if !committed {
			_ = os.Remove(tmp)
		}
	}()

	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)
	defer func() {
		_ = tw.Close()
		_ = gw.Close()
	}()

	files := 0
	var bytes int64
	lastEmit := time.Now()

	walkErr := filepath.WalkDir(srcAbs, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(srcAbs, p)
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
			return errors.New("refuse to tar symlink")
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		if info.IsDir() {
			hdr.Name = rel + "/"
		} else {
			hdr.Name = rel
		}
		hdr.Name = path.Clean(strings.TrimPrefix(strings.ReplaceAll(hdr.Name, "\\", "/"), "/"))
		if hdr.Name == "." || hdr.Name == "/" || strings.HasPrefix(hdr.Name, "../") || strings.HasPrefix(hdr.Name, "/") {
			return errors.New("tar entry escapes source")
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}

		src, err := os.Open(p)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(tw, src)
		_ = src.Close()
		if copyErr != nil {
			return copyErr
		}
		bytes += n
		files++
		if onProgress != nil && time.Since(lastEmit) >= 1*time.Second {
			onProgress(ArchiveProgress{Files: files, Bytes: bytes})
			lastEmit = time.Now()
		}
		return nil
	})
	if walkErr != nil {
		return 0, 0, walkErr
	}

	if onProgress != nil {
		onProgress(ArchiveProgress{Files: files, Bytes: bytes})
	}

	if err := tw.Close(); err != nil {
		return 0, 0, err
	}
	if err := gw.Close(); err != nil {
		return 0, 0, err
	}
	if err := f.Close(); err != nil {
		return 0, 0, err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		return 0, 0, err
	}
	if err := os.Rename(tmp, destTarGzPath); err != nil {
		return 0, 0, err
	}
	committed = true
	return files, bytes, nil
}

// UntarGzToDir extracts tar.gz into destDir.
// It refuses symlinks and rejects any entry that escapes destDir.
func UntarGzToDir(tarGzPath string, destDir string) (int, error) {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	gr, err := gzip.NewReader(f)
	if err != nil {
		return 0, err
	}
	defer gr.Close()

	tr := tar.NewReader(gr)

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(destAbs, 0o755); err != nil {
		return 0, err
	}

	files := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		if hdr == nil {
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return 0, errors.New("tar contains symlink (refuse)")
		}
		name := strings.ReplaceAll(hdr.Name, "\\", "/")
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}
		clean := path.Clean(name)
		if clean == "." || clean == "/" {
			continue
		}
		if strings.HasPrefix(clean, "../") || clean == ".." || strings.HasPrefix(clean, "/") {
			return 0, errors.New("tar entry escapes destination")
		}

		outAbs := filepath.Join(destAbs, filepath.FromSlash(clean))
		outAbs = filepath.Clean(outAbs)
		if !hasPathPrefix(outAbs, destAbs) {
			return 0, errors.New("tar entry escapes destination")
		}

		if hdr.Typeflag == tar.TypeDir || strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(outAbs, 0o755); err != nil {
				return 0, err
			}
			continue
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			return 0, errors.New("unsupported tar entry type")
		}

		if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
			return 0, err
		}
		dst, err := os.OpenFile(outAbs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			return 0, err
		}
		_, copyErr := io.CopyN(dst, tr, hdr.Size)
		_ = dst.Close()
		if copyErr != nil {
			return 0, copyErr
		}
		files++
	}
	return files, nil
}
