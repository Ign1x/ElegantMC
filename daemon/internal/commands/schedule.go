package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elegantmc/daemon/internal/protocol"
	"elegantmc/daemon/internal/scheduler"
)

func (e *Executor) scheduleGet(cmd protocol.Command) protocol.CommandResult {
	_ = cmd
	fp := strings.TrimSpace(e.deps.ScheduleFile)
	if fp == "" {
		return fail("schedule file not configured")
	}

	b, err := os.ReadFile(fp)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ok(map[string]any{"path": fp, "exists": false, "schedule": scheduler.ScheduleFile{Tasks: []scheduler.Task{}}})
		}
		return fail(err.Error())
	}
	var s scheduler.ScheduleFile
	if err := json.Unmarshal(b, &s); err != nil {
		return fail("invalid schedule.json")
	}
	return ok(map[string]any{"path": fp, "exists": true, "schedule": s})
}

func (e *Executor) scheduleSet(cmd protocol.Command) protocol.CommandResult {
	fp := strings.TrimSpace(e.deps.ScheduleFile)
	if fp == "" {
		return fail("schedule file not configured")
	}
	raw, _ := asString(cmd.Args["json"])
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fail("json is required")
	}
	if len(raw) > 1_000_000 {
		return fail("json too large")
	}

	var s scheduler.ScheduleFile
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return fail("invalid json")
	}
	if len(s.Tasks) > 200 {
		return fail("too many tasks (max 200)")
	}

	seen := make(map[string]struct{}, len(s.Tasks))
	for i := range s.Tasks {
		t := &s.Tasks[i]
		t.ID = strings.TrimSpace(t.ID)
		t.Type = strings.TrimSpace(t.Type)
		t.InstanceID = strings.TrimSpace(t.InstanceID)
		if t.ID == "" {
			return fail(fmt.Sprintf("task[%d].id is required", i))
		}
		if _, ok := seen[t.ID]; ok {
			return fail(fmt.Sprintf("duplicate task id: %s", t.ID))
		}
		seen[t.ID] = struct{}{}
		if t.Type == "" {
			return fail(fmt.Sprintf("task[%d].type is required", i))
		}
		tt := strings.ToLower(t.Type)
		switch tt {
		case "restart", "stop", "backup", "announce", "prune_logs":
			// ok
		default:
			return fail(fmt.Sprintf("task[%d].type unsupported: %s", i, t.Type))
		}
		if t.InstanceID == "" {
			return fail(fmt.Sprintf("task[%d].instance_id is required", i))
		}
		if err := validateInstanceID(t.InstanceID); err != nil {
			return fail(fmt.Sprintf("task[%d].instance_id invalid: %s", i, err.Error()))
		}
		if t.EverySec < 0 || t.AtUnix < 0 {
			return fail(fmt.Sprintf("task[%d] invalid schedule values", i))
		}
		if t.KeepLast < 0 {
			return fail(fmt.Sprintf("task[%d].keep_last invalid", i))
		}
		if t.KeepLast > 1000 {
			return fail(fmt.Sprintf("task[%d].keep_last too large (max 1000)", i))
		}

		if tt == "announce" {
			t.Message = strings.TrimSpace(t.Message)
			if t.Message == "" {
				return fail(fmt.Sprintf("task[%d].message is required", i))
			}
			if strings.ContainsAny(t.Message, "\r\n") {
				return fail(fmt.Sprintf("task[%d].message must be single-line", i))
			}
			if len(t.Message) > 400 {
				return fail(fmt.Sprintf("task[%d].message too long (max 400)", i))
			}
		}
		if tt == "prune_logs" {
			if t.KeepLast < 1 {
				return fail(fmt.Sprintf("task[%d].keep_last is required for prune_logs", i))
			}
		}
	}

	s.UpdatedAtUnix = timeNowUnix()
	if err := writeJSONAtomic(fp, s); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"saved": true, "path": fp, "updated_at_unix": s.UpdatedAtUnix})
}

func (e *Executor) scheduleRunTask(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	fp := strings.TrimSpace(e.deps.ScheduleFile)
	if fp == "" {
		return fail("schedule file not configured")
	}
	taskID, _ := asString(cmd.Args["task_id"])
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return fail("task_id is required")
	}

	b, err := os.ReadFile(fp)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fail("schedule file not found")
		}
		return fail(err.Error())
	}
	var s scheduler.ScheduleFile
	if err := json.Unmarshal(b, &s); err != nil {
		return fail("invalid schedule.json")
	}

	idx := -1
	for i := range s.Tasks {
		if strings.TrimSpace(s.Tasks[i].ID) == taskID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fail("task not found")
	}

	now := timeNowUnix()
	m := scheduler.New(scheduler.Config{Enabled: true, FilePath: fp}, scheduler.Deps{
		ServersFS: e.deps.FS,
		MC:        e.deps.MC,
		Log:       e.deps.Log,
	})

	err = m.RunTaskNow(ctx, s.Tasks[idx])
	s.Tasks[idx].LastRunUnix = now
	if err != nil {
		s.Tasks[idx].LastError = err.Error()
	} else {
		s.Tasks[idx].LastError = ""
	}
	s.UpdatedAtUnix = now

	if saveErr := writeJSONAtomic(fp, s); saveErr != nil {
		return fail(saveErr.Error())
	}

	return ok(map[string]any{
		"task_id": taskID,
		"ran":     true,
		"error":   s.Tasks[idx].LastError,
	})
}

func writeJSONAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
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
