package commands

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"elegantmc/daemon/internal/protocol"
)

type backupFile struct {
	name  string
	abs   string
	mtime time.Time
}

func listBackupZips(dirAbs string) ([]backupFile, error) {
	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil, err
	}
	var files []backupFile
	for _, ent := range entries {
		if ent == nil || ent.IsDir() {
			continue
		}
		name := ent.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".zip") && !strings.HasSuffix(lower, ".tar.gz") && !strings.HasSuffix(lower, ".tgz") {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		files = append(files, backupFile{
			name:  name,
			abs:   filepath.Join(dirAbs, name),
			mtime: info.ModTime(),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].mtime.Equal(files[j].mtime) {
			return files[i].name > files[j].name
		}
		return files[i].mtime.After(files[j].mtime)
	})
	return files, nil
}

func pruneBackupZips(dirAbs string, keepLast int) (removed int, kept int, total int, err error) {
	if keepLast < 0 {
		return 0, 0, 0, os.ErrInvalid
	}
	files, err := listBackupZips(dirAbs)
	if err != nil {
		return 0, 0, 0, err
	}
	total = len(files)
	if keepLast >= total {
		return 0, total, total, nil
	}
	for i := keepLast; i < total; i++ {
		_ = os.Remove(files[i].abs)
		_ = os.Remove(files[i].abs + ".meta.json")
		removed++
	}
	kept = keepLast
	return removed, kept, total, nil
}

func (e *Executor) mcBackupPrune(cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}
	keepLast, err := asInt(cmd.Args["keep_last"])
	if err != nil {
		return fail("keep_last must be int")
	}
	if keepLast < 0 || keepLast > 1000 {
		return fail("keep_last must be in 0-1000")
	}

	dirRel := filepath.Join("_backups", instanceID)
	dirAbs, err := e.deps.FS.Resolve(dirRel)
	if err != nil {
		return fail(err.Error())
	}
	if _, err := os.Stat(dirAbs); err != nil {
		if os.IsNotExist(err) {
			return ok(map[string]any{"instance_id": instanceID, "removed": 0, "kept": 0, "total": 0})
		}
		return fail(err.Error())
	}

	removed, kept, total, err := pruneBackupZips(dirAbs, keepLast)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"instance_id": instanceID, "removed": removed, "kept": kept, "total": total})
}
