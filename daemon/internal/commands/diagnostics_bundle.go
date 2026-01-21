package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"elegantmc/daemon/internal/backup"
	"elegantmc/daemon/internal/protocol"
)

func (e *Executor) diagnosticsBundle(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	instanceID, _ := asString(cmd.Args["instance_id"])
	instanceID = strings.TrimSpace(instanceID)
	if instanceID != "" {
		if err := validateInstanceID(instanceID); err != nil {
			return fail(err.Error())
		}
	}

	maxLogBytes := int64(200 * 1024)
	if raw, exists := cmd.Args["max_log_bytes"]; exists {
		v, err := asInt(raw)
		if err != nil {
			return fail("max_log_bytes invalid")
		}
		n := int64(v)
		if n < 0 {
			return fail("max_log_bytes invalid")
		}
		if n > 5*1024*1024 {
			n = 5 * 1024 * 1024
		}
		maxLogBytes = n
	}

	nowUnix := time.Now().Unix()
	daemonID := strings.TrimSpace(e.deps.Daemon)
	if daemonID == "" {
		daemonID = "daemon"
	}

	zipRel, _ := asString(cmd.Args["zip_path"])
	zipRel = strings.TrimSpace(zipRel)
	if zipRel == "" {
		zipRel = filepath.ToSlash(filepath.Join("_diagnostics", fmt.Sprintf("diagnostics-%s-%d.zip", sanitizeFileComponent(daemonID), nowUnix)))
	}
	if !strings.HasSuffix(strings.ToLower(zipRel), ".zip") {
		return fail("zip_path must end with .zip")
	}

	zipAbs, err := e.deps.FS.Resolve(zipRel)
	if err != nil {
		return fail(err.Error())
	}
	if _, err := os.Stat(zipAbs); err == nil {
		return fail("destination exists")
	}
	if err := os.MkdirAll(filepath.Dir(zipAbs), 0o755); err != nil {
		return fail(err.Error())
	}

	tmpDir, err := os.MkdirTemp("", "elegantmc-diag-*")
	if err != nil {
		return fail(err.Error())
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	select {
	case <-ctx.Done():
		return fail(ctx.Err().Error())
	default:
	}

	meta := map[string]any{
		"created_at_unix": nowUnix,
		"daemon_id":       daemonID,
		"os":             runtime.GOOS,
		"arch":           runtime.GOARCH,
		"schedule_file":  strings.TrimSpace(e.deps.ScheduleFile),
		"servers_root":   e.deps.FS.Root(),
		"frpc_path":      strings.TrimSpace(e.deps.FRPC),
		"preferred_connect_addrs": e.deps.PreferredConnectAddrs,
		"limits": map[string]any{
			"max_log_bytes": maxLogBytes,
		},
	}
	if err := writeJSONFile(filepath.Join(tmpDir, "meta.json"), meta); err != nil {
		return fail(err.Error())
	}

	env := gatherSanitizedEnv()
	if err := writeJSONFile(filepath.Join(tmpDir, "env.json"), env); err != nil {
		return fail(err.Error())
	}

	baseDirGuess := ""
	if fp := strings.TrimSpace(e.deps.ScheduleFile); fp != "" {
		baseDirGuess = filepath.Dir(fp)
	}
	if baseDirGuess != "" {
		_ = tryCopyFile(filepath.Join(baseDirGuess, "panel_binding.json"), filepath.Join(tmpDir, "daemon", "panel_binding.json"), 128*1024)
		_ = tryCopyFile(filepath.Join(baseDirGuess, "healthz.txt"), filepath.Join(tmpDir, "daemon", "healthz.txt"), 64*1024)
	}

	if fp := strings.TrimSpace(e.deps.ScheduleFile); fp != "" {
		if err := tryCopyFile(fp, filepath.Join(tmpDir, "scheduler", "schedule.json"), 1*1024*1024); err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = writeTextFile(filepath.Join(tmpDir, "scheduler", "schedule.error.txt"), []byte(err.Error()+"\n"))
		}
	}

	var insts []string
	if instanceID != "" {
		insts = []string{instanceID}
	} else {
		list, err := listInstanceDirs(e.deps.FS.Root())
		if err == nil {
			insts = list
		}
	}
	if err := writeJSONFile(filepath.Join(tmpDir, "instances", "list.json"), map[string]any{"instances": insts}); err != nil {
		return fail(err.Error())
	}
	if e.deps.MC != nil {
		_ = writeJSONFile(filepath.Join(tmpDir, "instances", "status.json"), e.deps.MC.List())
	}

	for _, id := range insts {
		select {
		case <-ctx.Done():
			return fail(ctx.Err().Error())
		default:
		}

		// instance config
		if abs, err := e.deps.FS.Resolve(filepath.Join(id, ".elegantmc.json")); err == nil {
			_ = tryCopyFile(abs, filepath.Join(tmpDir, "instances", id, ".elegantmc.json"), 256*1024)
		}

		// latest.log tail
		if maxLogBytes > 0 {
			if abs, err := e.deps.FS.Resolve(filepath.Join(id, "logs", "latest.log")); err == nil {
				_ = copyTail(abs, filepath.Join(tmpDir, "instances", id, "logs", "latest.log.tail"), maxLogBytes)
			}
		}
	}

	files, err := backup.ZipDir(tmpDir, zipAbs)
	if err != nil {
		return fail(err.Error())
	}
	_ = os.Chmod(zipAbs, 0o600)

	return ok(map[string]any{
		"zip_path":        zipRel,
		"files":           files,
		"created_at_unix": nowUnix,
	})
}

func sanitizeFileComponent(s string) string {
	in := strings.TrimSpace(s)
	if in == "" {
		return "daemon"
	}
	var b strings.Builder
	b.Grow(len(in))
	for _, r := range in {
		if r >= 'A' && r <= 'Z' {
			r = r - 'A' + 'a'
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('-')
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		out = "daemon"
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func gatherSanitizedEnv() map[string]string {
	out := make(map[string]string)
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if !strings.HasPrefix(k, "ELEGANTMC_") {
			continue
		}
		out[k] = redactEnvValue(k, v)
	}
	return out
}

func redactEnvValue(key string, value string) string {
	k := strings.ToUpper(strings.TrimSpace(key))
	if strings.Contains(k, "TOKEN") || strings.Contains(k, "PASSWORD") || strings.Contains(k, "SECRET") || strings.Contains(k, "API_KEY") {
		if strings.TrimSpace(value) == "" {
			return ""
		}
		return "REDACTED"
	}
	return value
}

func listInstanceDirs(serversRoot string) ([]string, error) {
	ents, err := os.ReadDir(serversRoot)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, ent := range ents {
		if !ent.IsDir() {
			continue
		}
		name := strings.TrimSpace(ent.Name())
		if name == "" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
			continue
		}
		if err := validateInstanceID(name); err != nil {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return writeTextFile(path, b)
}

func writeTextFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func tryCopyFile(src string, dst string, maxBytes int64) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("refuse to copy dir")
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return copyTail(src, dst, maxBytes)
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeTextFile(dst, b)
}

func copyTail(src string, dst string, maxBytes int64) error {
	if maxBytes <= 0 {
		return nil
	}
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	start := int64(0)
	if size > maxBytes {
		start = size - maxBytes
	}
	if start > 0 {
		if _, err := f.Seek(start, io.SeekStart); err != nil {
			return err
		}
	}

	r := io.LimitReader(f, maxBytes)
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	return writeTextFile(dst, b)
}
