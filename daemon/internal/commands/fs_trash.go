package commands

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"elegantmc/daemon/internal/protocol"
)

const (
	trashRootRel  = "_trash"
	trashMetaName = "elegantmc-trash.json"
)

type trashInfo struct {
	TrashID       string `json:"trash_id"`
	OriginalPath  string `json:"original_path"`
	PayloadRel    string `json:"payload_rel"`
	DeletedAtUnix int64  `json:"deleted_at_unix"`
	IsDir         bool   `json:"is_dir"`
}

func randHex(n int) (string, error) {
	if n <= 0 {
		return "", errors.New("invalid random length")
	}
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func writeTrashMeta(absPath string, info trashInfo) error {
	b, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return os.WriteFile(absPath, b, 0o644)
}

func (e *Executor) fsTrash(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	path = strings.TrimSpace(path)
	if path == "" {
		return fail("path is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	abs, err := e.deps.FS.Resolve(path)
	if err != nil {
		return fail(err.Error())
	}
	if filepath.Clean(abs) == filepath.Clean(e.deps.FS.Root()) {
		return fail("refuse to trash root")
	}

	st, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("not found")
		}
		return fail(err.Error())
	}

	rnd, err := randHex(4)
	if err != nil {
		return fail(err.Error())
	}
	trashID := time.Now().UTC().Format("20060102-150405") + "-" + rnd
	itemDirNative := filepath.Join(trashRootRel, trashID)
	itemDirRel := filepath.ToSlash(itemDirNative)

	base := filepath.Base(abs)
	if strings.TrimSpace(base) == "" || base == "." || base == string(filepath.Separator) {
		base = "item"
	}
	payloadNative := filepath.Join(itemDirNative, base)
	payloadRel := filepath.ToSlash(payloadNative)

	itemDirAbs, err := e.deps.FS.Resolve(itemDirRel)
	if err != nil {
		return fail(err.Error())
	}
	payloadAbs, err := e.deps.FS.Resolve(payloadRel)
	if err != nil {
		return fail(err.Error())
	}

	if err := os.MkdirAll(itemDirAbs, 0o755); err != nil {
		return fail(err.Error())
	}
	if _, err := os.Stat(payloadAbs); err == nil {
		return fail("trash destination already exists")
	}
	if err := os.Rename(abs, payloadAbs); err != nil {
		return fail(err.Error())
	}

	metaAbs := filepath.Join(itemDirAbs, trashMetaName)
	info := trashInfo{
		TrashID:       trashID,
		OriginalPath:  filepath.ToSlash(filepath.Clean(path)),
		PayloadRel:    payloadRel,
		DeletedAtUnix: time.Now().Unix(),
		IsDir:         st.IsDir(),
	}
	if err := writeTrashMeta(metaAbs, info); err != nil {
		// Best-effort rollback.
		_ = os.Rename(payloadAbs, abs)
		_ = os.RemoveAll(itemDirAbs)
		return fail(err.Error())
	}

	return ok(map[string]any{
		"path":         path,
		"trash_id":     trashID,
		"trash_path":   itemDirRel,
		"payload_path": payloadRel,
		"is_dir":       st.IsDir(),
	})
}

func (e *Executor) fsTrashRestore(cmd protocol.Command) protocol.CommandResult {
	trashID, _ := asString(cmd.Args["trash_id"])
	trashPath, _ := asString(cmd.Args["trash_path"])
	trashID = strings.TrimSpace(trashID)
	trashPath = strings.TrimSpace(trashPath)

	if trashID == "" && trashPath == "" {
		return fail("trash_id or trash_path is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	itemDirRel := ""
	if trashID != "" {
		itemDirRel = filepath.ToSlash(filepath.Join(trashRootRel, trashID))
	} else {
		itemDirRel = filepath.ToSlash(filepath.Clean(trashPath))
		if strings.HasSuffix(itemDirRel, "/"+trashMetaName) {
			itemDirRel = strings.TrimSuffix(itemDirRel, "/"+trashMetaName)
		}
	}
	if itemDirRel == trashRootRel || strings.HasPrefix(itemDirRel, trashRootRel+"/") == false {
		return fail("trash_path must be under _trash/")
	}

	itemDirAbs, err := e.deps.FS.Resolve(itemDirRel)
	if err != nil {
		return fail(err.Error())
	}

	metaAbs := filepath.Join(itemDirAbs, trashMetaName)
	b, err := os.ReadFile(metaAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("trash meta not found")
		}
		return fail(err.Error())
	}
	var info trashInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return fail(err.Error())
	}

	origRel := strings.TrimSpace(info.OriginalPath)
	payloadRel := strings.TrimSpace(info.PayloadRel)
	if origRel == "" || payloadRel == "" {
		return fail("trash meta invalid")
	}
	origRel = filepath.ToSlash(filepath.Clean(origRel))
	payloadRel = filepath.ToSlash(filepath.Clean(payloadRel))

	if origRel == "." || origRel == "/" || origRel == trashRootRel || strings.HasPrefix(origRel, trashRootRel+"/") {
		return fail("refuse to restore into trash or root")
	}

	absFrom, err := e.deps.FS.Resolve(payloadRel)
	if err != nil {
		return fail(err.Error())
	}
	absTo, err := e.deps.FS.Resolve(origRel)
	if err != nil {
		return fail(err.Error())
	}
	if filepath.Clean(absTo) == filepath.Clean(e.deps.FS.Root()) {
		return fail("refuse to restore root")
	}

	if _, err := os.Stat(absFrom); err != nil {
		if os.IsNotExist(err) {
			return fail("trash payload not found")
		}
		return fail(err.Error())
	}
	if _, err := os.Stat(absTo); err == nil {
		return fail("restore target already exists")
	}
	if err := os.MkdirAll(filepath.Dir(absTo), 0o755); err != nil {
		return fail(err.Error())
	}
	if err := os.Rename(absFrom, absTo); err != nil {
		return fail(err.Error())
	}

	_ = os.RemoveAll(itemDirAbs)
	return ok(map[string]any{
		"restored":      true,
		"trash_path":    itemDirRel,
		"original_path": origRel,
	})
}

func (e *Executor) fsTrashList(cmd protocol.Command) protocol.CommandResult {
	limit, _ := asInt(cmd.Args["limit"])
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	trashAbs, err := e.deps.FS.Resolve(trashRootRel)
	if err != nil {
		return fail(err.Error())
	}
	entries, err := os.ReadDir(trashAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return ok(map[string]any{"items": []any{}})
		}
		return fail(err.Error())
	}

	type item struct {
		TrashPath string    `json:"trash_path"`
		Info      trashInfo `json:"info"`
	}
	var items []item
	for _, ent := range entries {
		if ent == nil || !ent.IsDir() {
			continue
		}
		dirRel := filepath.ToSlash(filepath.Join(trashRootRel, ent.Name()))
		dirAbs := filepath.Join(trashAbs, ent.Name())
		b, err := os.ReadFile(filepath.Join(dirAbs, trashMetaName))
		if err != nil {
			continue
		}
		var info trashInfo
		if err := json.Unmarshal(b, &info); err != nil {
			continue
		}
		items = append(items, item{TrashPath: dirRel, Info: info})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].Info.DeletedAtUnix > items[j].Info.DeletedAtUnix
	})
	if len(items) > limit {
		items = items[:limit]
	}

	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, map[string]any{
			"trash_path": it.TrashPath,
			"info":       it.Info,
		})
	}
	return ok(map[string]any{"items": out})
}

func (e *Executor) fsTrashDelete(cmd protocol.Command) protocol.CommandResult {
	trashID, _ := asString(cmd.Args["trash_id"])
	trashPath, _ := asString(cmd.Args["trash_path"])
	trashID = strings.TrimSpace(trashID)
	trashPath = strings.TrimSpace(trashPath)

	if trashID == "" && trashPath == "" {
		return fail("trash_id or trash_path is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	itemDirRel := ""
	if trashID != "" {
		itemDirRel = filepath.ToSlash(filepath.Join(trashRootRel, trashID))
	} else {
		itemDirRel = filepath.ToSlash(filepath.Clean(trashPath))
	}
	if itemDirRel == trashRootRel || strings.HasPrefix(itemDirRel, trashRootRel+"/") == false {
		return fail("trash_path must be under _trash/")
	}

	itemDirAbs, err := e.deps.FS.Resolve(itemDirRel)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.RemoveAll(itemDirAbs); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"trash_path": itemDirRel, "deleted": true})
}

