package commands

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"elegantmc/daemon/internal/frp"
	"elegantmc/daemon/internal/mc"
	"elegantmc/daemon/internal/protocol"
	"elegantmc/daemon/internal/sandbox"
)

func newTestExecutor(t *testing.T) (*Executor, *sandbox.FS, string) {
	t.Helper()

	base := t.TempDir()
	serversRoot := filepath.Join(base, "servers")
	if err := os.MkdirAll(serversRoot, 0o755); err != nil {
		t.Fatalf("mkdir servers: %v", err)
	}
	fs, err := sandbox.NewFS(serversRoot)
	if err != nil {
		t.Fatalf("sandbox.NewFS: %v", err)
	}

	frpMgr := frp.NewManager(frp.ManagerConfig{
		FRPCPath: "/bin/true",
		WorkDir:  filepath.Join(base, "frp"),
		Log:      nil,
	})
	mcMgr := mc.NewManager(mc.ManagerConfig{
		ServersFS:       fs,
		Log:             nil,
		JavaCandidates:  []string{"java"},
		JavaAutoDownload: false,
	})

	ex := NewExecutor(ExecutorDeps{
		FS:   fs,
		FRP:  frpMgr,
		MC:   mcMgr,
		FRPC: filepath.Join(base, "bin", "frpc"),
		Mojang: MojangConfig{
			MetaBaseURL: "https://example.invalid",
			DataBaseURL: "https://example.invalid",
		},
		Paper: PaperConfig{
			APIBaseURL: "https://example.invalid",
		},
	})
	return ex, fs, serversRoot
}

func TestExecutor_FSReadWrite(t *testing.T) {
	ex, _, _ := newTestExecutor(t)
	ctx := context.Background()

	want := []byte("hello world\n")
	writeRes := ex.Execute(ctx, protocol.Command{
		Name: "fs_write",
		Args: map[string]any{
			"path": "server1/hello.txt",
			"b64":  base64.StdEncoding.EncodeToString(want),
		},
	})
	if !writeRes.OK {
		t.Fatalf("fs_write failed: %s", writeRes.Error)
	}

	readRes := ex.Execute(ctx, protocol.Command{
		Name: "fs_read",
		Args: map[string]any{"path": "server1/hello.txt"},
	})
	if !readRes.OK {
		t.Fatalf("fs_read failed: %s", readRes.Error)
	}
	gotB64, _ := readRes.Output["b64"].(string)
	got, err := base64.StdEncoding.DecodeString(gotB64)
	if err != nil {
		t.Fatalf("decode b64: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("unexpected contents: %q", string(got))
	}
}

func TestExecutor_FSRead_RejectsEscape(t *testing.T) {
	ex, _, _ := newTestExecutor(t)
	ctx := context.Background()

	res := ex.Execute(ctx, protocol.Command{
		Name: "fs_read",
		Args: map[string]any{"path": "../oops.txt"},
	})
	if res.OK {
		t.Fatalf("expected failure")
	}
	if res.Error == "" {
		t.Fatalf("expected error message")
	}
}

func TestExecutor_FSUnzip_RejectsSymlink(t *testing.T) {
	ex, fs, serversRoot := newTestExecutor(t)
	ctx := context.Background()

	zipAbs := filepath.Join(serversRoot, "test.zip")
	f, err := os.Create(zipAbs)
	if err != nil {
		t.Fatalf("create zip: %v", err)
	}
	zw := zip.NewWriter(f)
	hdr := &zip.FileHeader{Name: "link"}
	hdr.SetMode(os.ModeSymlink | 0o777)
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		t.Fatalf("zip header: %v", err)
	}
	_, _ = w.Write([]byte("target"))
	_ = zw.Close()
	_ = f.Close()

	// Ensure zip is visible under the sandbox root.
	if _, err := fs.Resolve("test.zip"); err != nil {
		t.Fatalf("resolve zip: %v", err)
	}

	res := ex.Execute(ctx, protocol.Command{
		Name: "fs_unzip",
		Args: map[string]any{
			"zip_path":    "test.zip",
			"dest_dir":    "server1",
			"instance_id": "server1",
		},
	})
	if res.OK {
		t.Fatalf("expected failure")
	}
	if res.Error == "" {
		t.Fatalf("expected error message")
	}
}

func TestExecutor_MCBackupRestore_Roundtrip(t *testing.T) {
	ex, _, serversRoot := newTestExecutor(t)
	ctx := context.Background()

	// Seed an instance folder.
	instDir := filepath.Join(serversRoot, "server1")
	if err := os.MkdirAll(filepath.Join(instDir, "world"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(instDir, "server.properties"), []byte("server-port=25565\n"), 0o644); err != nil {
		t.Fatalf("write props: %v", err)
	}
	if err := os.WriteFile(filepath.Join(instDir, "world", "level.dat"), []byte("data"), 0o644); err != nil {
		t.Fatalf("write world: %v", err)
	}

	backupRes := ex.Execute(ctx, protocol.Command{
		Name: "mc_backup",
		Args: map[string]any{
			"instance_id":  "server1",
			"backup_name":  "b1.zip",
			"stop":         false,
		},
	})
	if !backupRes.OK {
		t.Fatalf("mc_backup failed: %s", backupRes.Error)
	}
	zipRel, _ := backupRes.Output["path"].(string)
	if zipRel == "" {
		t.Fatalf("expected backup path")
	}

	// Destroy instance, then restore.
	_ = os.RemoveAll(instDir)
	if err := os.MkdirAll(instDir, 0o755); err != nil {
		t.Fatalf("mkdir after delete: %v", err)
	}
	if err := os.WriteFile(filepath.Join(instDir, "server.properties"), []byte("server-port=25566\n"), 0o644); err != nil {
		t.Fatalf("write modified props: %v", err)
	}

	restoreRes := ex.Execute(ctx, protocol.Command{
		Name: "mc_restore",
		Args: map[string]any{
			"instance_id": "server1",
			"zip_path":    zipRel,
		},
	})
	if !restoreRes.OK {
		t.Fatalf("mc_restore failed: %s", restoreRes.Error)
	}

	b, err := os.ReadFile(filepath.Join(instDir, "server.properties"))
	if err != nil {
		t.Fatalf("read restored props: %v", err)
	}
	if string(b) != "server-port=25565\n" {
		t.Fatalf("unexpected restored props: %q", string(b))
	}
}

func TestExecutor_MCTemplates(t *testing.T) {
	ex, _, _ := newTestExecutor(t)
	ctx := context.Background()

	res := ex.Execute(ctx, protocol.Command{Name: "mc_templates"})
	if !res.OK {
		t.Fatalf("mc_templates failed: %s", res.Error)
	}
	if res.Output == nil {
		t.Fatalf("expected output")
	}
	if _, ok := res.Output["templates"]; !ok {
		t.Fatalf("expected templates key")
	}
}

