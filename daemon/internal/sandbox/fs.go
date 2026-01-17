package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type FS struct {
	rootAbs string
}

func NewFS(root string) (*FS, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("sandbox root is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &FS{rootAbs: filepath.Clean(abs)}, nil
}

func (f *FS) Root() string { return f.rootAbs }

// Resolve joins a user-supplied path under the sandbox root.
// It rejects any path that escapes the sandbox root after cleaning.
func (f *FS) Resolve(rel string) (string, error) {
	cleanRel := filepath.Clean(rel)
	if cleanRel == "." {
		return f.rootAbs, nil
	}

	abs := filepath.Join(f.rootAbs, cleanRel)
	abs = filepath.Clean(abs)

	if !hasPathPrefix(abs, f.rootAbs) {
		return "", errors.New("path escapes sandbox root")
	}
	return abs, nil
}

func hasPathPrefix(path, root string) bool {
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

