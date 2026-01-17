package sandbox

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFS_Resolve_AllowsInsideRoot(t *testing.T) {
	root := t.TempDir()
	fs, err := NewFS(root)
	if err != nil {
		t.Fatalf("NewFS(): %v", err)
	}
	got, err := fs.Resolve("a/b/c.txt")
	if err != nil {
		t.Fatalf("Resolve(): %v", err)
	}
	want := filepath.Join(root, "a/b/c.txt")
	if filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestFS_Resolve_RejectsEscape(t *testing.T) {
	root := t.TempDir()
	fs, err := NewFS(root)
	if err != nil {
		t.Fatalf("NewFS(): %v", err)
	}
	if _, err := fs.Resolve("../outside"); err == nil {
		t.Fatalf("expected error for escape path")
	}
}

func TestFS_Resolve_RejectsAbsolute(t *testing.T) {
	root := t.TempDir()
	fs, err := NewFS(root)
	if err != nil {
		t.Fatalf("NewFS(): %v", err)
	}

	var abs string
	if runtime.GOOS == "windows" {
		wd, _ := os.Getwd()
		abs = filepath.Join(wd, "abs.txt")
	} else {
		abs = "/etc/passwd"
	}

	if _, err := fs.Resolve(abs); err == nil {
		t.Fatalf("expected error for absolute path")
	}
}

