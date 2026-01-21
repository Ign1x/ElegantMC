package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"elegantmc/daemon/internal/backup"
	"elegantmc/daemon/internal/mc"
	"elegantmc/daemon/internal/sandbox"
)

type Config struct {
	Enabled   bool
	FilePath  string
	PollEvery time.Duration
}

type Deps struct {
	ServersFS *sandbox.FS
	MC        *mc.Manager
	Log       *log.Logger
}

type Manager struct {
	cfg  Config
	deps Deps
}

type ScheduleFile struct {
	Tasks         []Task `json:"tasks"`
	UpdatedAtUnix int64  `json:"updated_at_unix,omitempty"`
}

type Task struct {
	ID         string `json:"id"`
	Enabled    *bool  `json:"enabled,omitempty"`
	Type       string `json:"type"` // "restart" | "stop" | "backup" | "announce" | "prune_logs"
	InstanceID string `json:"instance_id"`

	EverySec int64 `json:"every_sec,omitempty"` // if set, run periodically
	AtUnix   int64 `json:"at_unix,omitempty"`   // if set, run once at/after time

	// backup options
	KeepLast int   `json:"keep_last,omitempty"` // backup retention (backup) or log retention (prune_logs)
	Stop     *bool `json:"stop,omitempty"` // default true

	// announce options
	Message string `json:"message,omitempty"`

	LastRunUnix int64  `json:"last_run_unix,omitempty"`
	LastError   string `json:"last_error,omitempty"`
}

type instanceConfig struct {
	JarPath  string `json:"jar_path"`
	JavaPath string `json:"java_path"`
	Xms      string `json:"xms"`
	Xmx      string `json:"xmx"`
}

func New(cfg Config, deps Deps) *Manager {
	if cfg.PollEvery <= 0 {
		cfg.PollEvery = 30 * time.Second
	}
	return &Manager{cfg: cfg, deps: deps}
}

func (m *Manager) RunTaskNow(ctx context.Context, t Task) error {
	return m.runTask(ctx, t)
}

func (m *Manager) Run(ctx context.Context) {
	if !m.cfg.Enabled {
		return
	}

	ticker := time.NewTicker(m.cfg.PollEvery)
	defer ticker.Stop()

	// Run once quickly on start.
	m.tick(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

func (m *Manager) tick(ctx context.Context) {
	fp := strings.TrimSpace(m.cfg.FilePath)
	if fp == "" {
		return
	}

	s, err := m.load(fp)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		m.logf("scheduler: load failed: %v", err)
		return
	}

	now := time.Now().Unix()
	changed := false

	for i := range s.Tasks {
		t := &s.Tasks[i]
		if strings.TrimSpace(t.Type) == "" || strings.TrimSpace(t.InstanceID) == "" {
			continue
		}
		if t.Enabled != nil && !*t.Enabled {
			continue
		}

		if t.EverySec < 0 || t.AtUnix < 0 {
			continue
		}

		due := false
		if t.EverySec > 0 {
			// Safety: avoid extremely tight loops.
			every := t.EverySec
			if every < 60 {
				every = 60
			}
			if now-t.LastRunUnix >= every {
				due = true
			}
		} else if t.AtUnix > 0 {
			if t.LastRunUnix < t.AtUnix && now >= t.AtUnix {
				due = true
			}
		}

		if !due {
			continue
		}

		runCtx, cancel := context.WithTimeout(ctx, 60*time.Minute)
		err := m.runTask(runCtx, *t)
		cancel()

		t.LastRunUnix = now
		if err != nil {
			t.LastError = err.Error()
		} else {
			t.LastError = ""
		}
		changed = true
	}

	if changed {
		s.UpdatedAtUnix = now
		if err := m.save(fp, s); err != nil {
			m.logf("scheduler: save failed: %v", err)
		}
	}
}

func (m *Manager) runTask(ctx context.Context, t Task) error {
	switch strings.ToLower(strings.TrimSpace(t.Type)) {
	case "restart":
		m.logf("scheduler: restart: instance=%s", t.InstanceID)
		return m.restart(ctx, t.InstanceID)
	case "stop":
		m.logf("scheduler: stop: instance=%s", t.InstanceID)
		return m.stop(ctx, t.InstanceID)
	case "backup":
		stop := true
		if t.Stop != nil {
			stop = *t.Stop
		}
		m.logf("scheduler: backup: instance=%s", t.InstanceID)
		return m.backup(ctx, t.InstanceID, t.KeepLast, stop)
	case "announce":
		m.logf("scheduler: announce: instance=%s", t.InstanceID)
		return m.announce(ctx, t.InstanceID, t.Message)
	case "prune_logs":
		m.logf("scheduler: prune_logs: instance=%s", t.InstanceID)
		return m.pruneLogs(ctx, t.InstanceID, t.KeepLast)
	default:
		return fmt.Errorf("unknown task type: %s", t.Type)
	}
}

func (m *Manager) restart(ctx context.Context, instanceID string) error {
	if m.deps.ServersFS == nil || m.deps.MC == nil {
		return errors.New("daemon misconfigured: scheduler deps missing")
	}

	cfg, err := m.readInstanceConfig(instanceID)
	if err != nil {
		return err
	}
	jar := strings.TrimSpace(cfg.JarPath)
	if jar == "" {
		jar = "server.jar"
	}

	_ = m.deps.MC.Stop(ctx, instanceID)
	return m.deps.MC.Start(ctx, mc.StartOptions{
		InstanceID: instanceID,
		JarPath:    jar,
		JavaPath:   strings.TrimSpace(cfg.JavaPath),
		Xms:        strings.TrimSpace(cfg.Xms),
		Xmx:        strings.TrimSpace(cfg.Xmx),
	}, nil)
}

func (m *Manager) stop(ctx context.Context, instanceID string) error {
	if m.deps.MC == nil {
		return errors.New("daemon misconfigured: scheduler deps missing")
	}
	return m.deps.MC.Stop(ctx, instanceID)
}

func (m *Manager) backup(ctx context.Context, instanceID string, keepLast int, stop bool) error {
	if m.deps.ServersFS == nil || m.deps.MC == nil {
		return errors.New("daemon misconfigured: scheduler deps missing")
	}
	if stop {
		_ = m.deps.MC.Stop(ctx, instanceID)
	}

	srcAbs, err := m.deps.ServersFS.Resolve(instanceID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(srcAbs); err != nil {
		return err
	}

	name := fmt.Sprintf("%s-%d.zip", instanceID, time.Now().Unix())
	destRel := filepath.Join("_backups", instanceID, name)
	destAbs, err := m.deps.ServersFS.Resolve(destRel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destAbs), 0o755); err != nil {
		return err
	}

	// Best-effort context check (zip itself isn't cancellable).
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	files, err := backup.ZipDir(srcAbs, destAbs)
	if err != nil {
		return err
	}
	m.logf("scheduler: backup ok: instance=%s files=%d path=%s", instanceID, files, destRel)

	if keepLast > 0 {
		_ = pruneOldBackups(destAbs, keepLast)
	}
	return nil
}

func (m *Manager) announce(ctx context.Context, instanceID string, message string) error {
	if m.deps.MC == nil {
		return errors.New("daemon misconfigured: scheduler deps missing")
	}
	msg := strings.TrimSpace(message)
	if msg == "" {
		return errors.New("message is required")
	}
	if strings.ContainsAny(msg, "\r\n") {
		return errors.New("message must be single-line")
	}
	return m.deps.MC.SendConsole(ctx, instanceID, fmt.Sprintf("say %s", msg))
}

func (m *Manager) pruneLogs(ctx context.Context, instanceID string, keepLast int) error {
	if m.deps.ServersFS == nil {
		return errors.New("daemon misconfigured: scheduler deps missing")
	}
	if keepLast < 1 {
		keepLast = 1
	}

	logsAbs, err := m.deps.ServersFS.Resolve(filepath.Join(instanceID, "logs"))
	if err != nil {
		return err
	}
	ents, err := os.ReadDir(logsAbs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	type item struct {
		path string
		ts   time.Time
	}
	var files []item
	for _, ent := range ents {
		if ent.IsDir() {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		files = append(files, item{path: filepath.Join(logsAbs, ent.Name()), ts: info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ts.After(files[j].ts) })
	if len(files) <= keepLast {
		return nil
	}

	deleted := 0
	for i := keepLast; i < len(files); i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if err := os.Remove(files[i].path); err == nil {
			deleted++
		}
	}
	m.logf("scheduler: prune_logs ok: instance=%s deleted=%d keep=%d", instanceID, deleted, keepLast)
	return nil
}

func pruneOldBackups(latestZipAbs string, keepLast int) error {
	if keepLast < 1 {
		return nil
	}
	dir := filepath.Dir(latestZipAbs)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type item struct {
		path string
		ts   time.Time
	}
	var files []item
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".zip") {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		files = append(files, item{path: filepath.Join(dir, name), ts: info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ts.After(files[j].ts) })
	for i := keepLast; i < len(files); i++ {
		_ = os.Remove(files[i].path)
	}
	return nil
}

func (m *Manager) readInstanceConfig(instanceID string) (instanceConfig, error) {
	abs, err := m.deps.ServersFS.Resolve(filepath.Join(instanceID, ".elegantmc.json"))
	if err != nil {
		return instanceConfig{}, err
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return instanceConfig{}, err
	}
	var cfg instanceConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		return instanceConfig{}, errors.New("invalid instance config (.elegantmc.json)")
	}
	return cfg, nil
}

func (m *Manager) load(path string) (ScheduleFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return ScheduleFile{}, err
	}
	var s ScheduleFile
	if err := json.Unmarshal(b, &s); err != nil {
		return ScheduleFile{}, err
	}
	return s, nil
}

func (m *Manager) save(path string, s ScheduleFile) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		_ = os.Rename(tmp, path)
	}
	_ = os.Remove(tmp)
	return nil
}

func (m *Manager) logf(format string, args ...any) {
	if m.deps.Log != nil {
		m.deps.Log.Printf(format, args...)
	}
}
