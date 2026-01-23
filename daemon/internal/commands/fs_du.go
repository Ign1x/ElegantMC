package commands

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"elegantmc/daemon/internal/protocol"
)

type duCacheEntry struct {
	Bytes          int64
	Entries        int
	ComputedAtUnix int64
}

func (e *Executor) fsDu(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	p, _ := asString(cmd.Args["path"])
	p = strings.TrimSpace(p)
	if p == "" {
		return fail("path is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	maxEntries := 250_000
	if v, ok := cmd.Args["max_entries"]; ok {
		if n, err := asInt(v); err == nil {
			if n < 1 {
				maxEntries = 1
			} else if n > 2_000_000 {
				maxEntries = 2_000_000
			} else {
				maxEntries = n
			}
		}
	}

	ttlSec := 60
	if v, ok := cmd.Args["ttl_sec"]; ok {
		if n, err := asInt(v); err == nil {
			if n < 0 {
				ttlSec = 0
			} else if n > 3600 {
				ttlSec = 3600
			} else {
				ttlSec = n
			}
		}
	}

	force := false
	if v, ok := asBool(cmd.Args["force"]); ok {
		force = v
	}

	key := path.Clean(filepath.ToSlash(p))
	key = strings.TrimPrefix(key, "/")
	if key == "." {
		key = ""
	}
	if key == "" {
		return fail("path must not be empty")
	}

	now := time.Now().Unix()
	if !force && ttlSec > 0 {
		e.duMu.Lock()
		ent, found := e.duCache[key]
		e.duMu.Unlock()
		if found && now-ent.ComputedAtUnix <= int64(ttlSec) {
			return ok(map[string]any{
				"path":             key,
				"bytes":            ent.Bytes,
				"entries":          ent.Entries,
				"cached":           true,
				"computed_at_unix": ent.ComputedAtUnix,
				"ttl_sec":          ttlSec,
			})
		}
	}

	abs, err := e.deps.FS.Resolve(key)
	if err != nil {
		return fail(err.Error())
	}
	info, err := os.Stat(abs)
	if err != nil {
		return fail(err.Error())
	}
	if !info.IsDir() {
		return ok(map[string]any{
			"path":             key,
			"bytes":            info.Size(),
			"entries":          1,
			"cached":           false,
			"computed_at_unix": now,
			"ttl_sec":          ttlSec,
		})
	}

	var bytes int64
	entries := 0
	walkErr := filepath.WalkDir(abs, func(cur string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d == nil {
			return nil
		}
		// Refuse symlinks to keep "du" inside the sandbox.
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		bytes += info.Size()
		entries++
		if entries > maxEntries {
			return errors.New("too many entries")
		}
		return nil
	})
	if walkErr != nil {
		return fail(walkErr.Error())
	}

	ent := duCacheEntry{Bytes: bytes, Entries: entries, ComputedAtUnix: now}
	e.duMu.Lock()
	e.duCache[key] = ent
	e.duMu.Unlock()

	return ok(map[string]any{
		"path":             key,
		"bytes":            bytes,
		"entries":          entries,
		"cached":           false,
		"computed_at_unix": now,
		"ttl_sec":          ttlSec,
	})
}
