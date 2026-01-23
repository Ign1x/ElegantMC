package commands

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"elegantmc/daemon/internal/backup"
	"elegantmc/daemon/internal/download"
	"elegantmc/daemon/internal/frp"
	"elegantmc/daemon/internal/mc"
	"elegantmc/daemon/internal/mcinstall"
	"elegantmc/daemon/internal/protocol"
	"elegantmc/daemon/internal/sandbox"
	"elegantmc/daemon/internal/sysinfo"
)

type MojangConfig struct {
	MetaBaseURL string
	DataBaseURL string
}

type PaperConfig struct {
	APIBaseURL string
}

type ExecutorDeps struct {
	Log                   *log.Logger
	FS                    *sandbox.FS
	FRP                   *frp.Manager
	MC                    *mc.Manager
	Daemon                string
	FRPC                  string
	PreferredConnectAddrs []string
	ScheduleFile          string

	Mojang MojangConfig
	Paper  PaperConfig
}

type Executor struct {
	deps ExecutorDeps

	// Wire set by ws client (so command handlers can emit logs back to panel).
	send func(msg protocol.Message)

	uploads *uploadManager

	cpu *sysinfo.CPUTracker

	duMu    sync.Mutex
	duCache map[string]duCacheEntry

	procMu        sync.Mutex
	procPrevTotal uint64
	procPrevByPID map[int]uint64
}

var instanceIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var sha256HexPattern = regexp.MustCompile(`(?i)^[a-f0-9]{64}$`)

func NewExecutor(deps ExecutorDeps) *Executor {
	ex := &Executor{deps: deps, cpu: &sysinfo.CPUTracker{}}
	if deps.FS != nil {
		ex.uploads = newUploadManager(deps.FS)
	}
	ex.duCache = make(map[string]duCacheEntry)
	ex.procPrevByPID = make(map[int]uint64)
	return ex
}

func (e *Executor) mcTemplates() protocol.CommandResult {
	return ok(map[string]any{
		"templates": []any{
			map[string]any{
				"id":          "vanilla",
				"name":        "Vanilla",
				"supported":   true,
				"install_cmd": "mc_install_vanilla",
				"presets": map[string]any{
					"jar_name":        "server.jar",
					"xms":             "1G",
					"xmx":             "2G",
					"accept_eula":     true,
					"enable_frp":      true,
					"frp_remote_port": 0,
				},
			},
			map[string]any{
				"id":          "paper",
				"name":        "Paper",
				"supported":   true,
				"install_cmd": "mc_install_paper",
				"presets": map[string]any{
					"jar_name":        "server.jar",
					"xms":             "1G",
					"xmx":             "2G",
					"accept_eula":     true,
					"enable_frp":      true,
					"frp_remote_port": 0,
				},
			},
			map[string]any{
				"id":        "fabric",
				"name":      "Fabric",
				"supported": false,
				"note":      "placeholder (not built-in yet). Use Modpack ZIP / upload your server jar.",
				"presets": map[string]any{
					"jar_name": "server.jar",
					"xms":      "1G",
					"xmx":      "2G",
				},
			},
		},
	})
}

func (e *Executor) mcBackup(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
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

	format, _ := asString(cmd.Args["format"])
	format = strings.TrimSpace(strings.ToLower(format))
	if format != "" && format != "zip" && format != "tar.gz" && format != "tgz" {
		return fail("format must be zip or tar.gz")
	}

	backupName, _ := asString(cmd.Args["backup_name"])
	backupName = strings.TrimSpace(backupName)
	comment, _ := asString(cmd.Args["comment"])
	comment = strings.TrimSpace(comment)
	if len(comment) > 500 {
		comment = comment[:500]
	}
	if backupName == "" {
		if format == "tar.gz" || format == "tgz" {
			backupName = fmt.Sprintf("%s-%d.tar.gz", instanceID, timeNowUnix())
			format = "tar.gz"
		} else {
			backupName = fmt.Sprintf("%s-%d.zip", instanceID, timeNowUnix())
			if format == "" {
				format = "zip"
			}
		}
	}
	if backupName == "" {
		return fail("backup_name is empty")
	}
	if strings.Contains(backupName, "/") || strings.Contains(backupName, "\\") {
		return fail("backup_name must be a filename (no /)")
	}

	if format == "" {
		lower := strings.ToLower(backupName)
		if strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz") {
			format = "tar.gz"
		} else {
			format = "zip"
		}
	}
	useTarGz := format == "tar.gz" || format == "tgz"
	if useTarGz {
		lower := strings.ToLower(backupName)
		if !strings.HasSuffix(lower, ".tar.gz") && !strings.HasSuffix(lower, ".tgz") {
			backupName += ".tar.gz"
		}
	} else {
		if !strings.HasSuffix(strings.ToLower(backupName), ".zip") {
			backupName += ".zip"
		}
	}
	if len(backupName) > 160 {
		return fail("backup_name too long")
	}

	// Best-effort stop (optional).
	shouldStop := true
	if v, ok := asBool(cmd.Args["stop"]); ok {
		shouldStop = v
	}
	if shouldStop {
		_ = e.deps.MC.Stop(ctx, instanceID)
	}

	srcAbs, err := e.deps.FS.Resolve(instanceID)
	if err != nil {
		return fail(err.Error())
	}
	if _, err := os.Stat(srcAbs); err != nil {
		return fail(err.Error())
	}

	destRel := filepath.Join("_backups", instanceID, backupName)
	destAbs, err := e.deps.FS.Resolve(destRel)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(destAbs), 0o755); err != nil {
		return fail(err.Error())
	}

	files := 0
	var bytes int64
	createdAtUnix := timeNowUnix()
	if useTarGz {
		last := time.Now()
		e.emitInstall(instanceID, fmt.Sprintf("backup: tar.gz %s -> %s", instanceID, destRel))
		n, b, err := backup.TarGzDir(srcAbs, destAbs, func(p backup.ArchiveProgress) {
			if time.Since(last) < 1*time.Second {
				return
			}
			last = time.Now()
			e.emitInstall(instanceID, fmt.Sprintf("backup progress: files=%d bytes=%d", p.Files, p.Bytes))
		})
		if err != nil {
			return fail(err.Error())
		}
		files = n
		bytes = b
		e.emitInstall(instanceID, fmt.Sprintf("backup done: %d files (%d bytes) -> %s", files, bytes, destRel))
	} else {
		e.emitInstall(instanceID, fmt.Sprintf("backup: zipping %s -> %s", instanceID, destRel))
		n, err := backup.ZipDir(srcAbs, destAbs)
		if err != nil {
			return fail(err.Error())
		}
		files = n
		e.emitInstall(instanceID, fmt.Sprintf("backup done: %d files -> %s", files, destRel))
	}

	// Best-effort file size (zip doesn't report bytes).
	if st, err := os.Stat(destAbs); err == nil && st != nil && st.Size() > 0 {
		bytes = st.Size()
	}

	// Best-effort metadata sidecar for panel restore points view.
	{
		meta := map[string]any{
			"schema":          1,
			"instance_id":     instanceID,
			"path":            destRel,
			"backup_name":     backupName,
			"format":          format,
			"created_at_unix": createdAtUnix,
			"files":           files,
			"bytes":           bytes,
			"comment":         comment,
		}
		if b, err := json.MarshalIndent(meta, "", "  "); err == nil {
			b = append(b, '\n')
			_ = os.WriteFile(destAbs+".meta.json", b, 0o600)
		}
	}

	if keepLast, err := asInt(cmd.Args["keep_last"]); err == nil && keepLast > 0 {
		if keepLast > 1000 {
			keepLast = 1000
		}
		dirAbs := filepath.Dir(destAbs)
		if removed, kept, total, err := pruneBackupZips(dirAbs, keepLast); err == nil {
			if removed > 0 {
				e.emitInstall(instanceID, fmt.Sprintf("backup prune: kept=%d total=%d removed=%d", kept, total, removed))
			}
		}
	}
	out := map[string]any{"instance_id": instanceID, "path": destRel, "files": files, "format": format}
	out["bytes"] = bytes
	return ok(out)
}

func (e *Executor) mcRestore(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
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

	zipRel, _ := asString(cmd.Args["zip_path"])
	if strings.TrimSpace(zipRel) == "" {
		return fail("zip_path is required")
	}
	zipAbs, err := e.deps.FS.Resolve(zipRel)
	if err != nil {
		return fail(err.Error())
	}

	// Stop instance (best-effort).
	_ = e.deps.MC.Stop(ctx, instanceID)

	instAbs, err := e.deps.FS.Resolve(instanceID)
	if err != nil {
		return fail(err.Error())
	}

	// Remove old dir then restore.
	if err := os.RemoveAll(instAbs); err != nil {
		return fail(err.Error())
	}
	if err := os.MkdirAll(instAbs, 0o755); err != nil {
		return fail(err.Error())
	}

	e.emitInstall(instanceID, fmt.Sprintf("restore: %s -> %s", zipRel, instanceID))
	var files int
	lower := strings.ToLower(zipRel)
	if strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz") {
		files, err = backup.UntarGzToDir(zipAbs, instAbs)
	} else {
		files, err = backup.UnzipToDir(zipAbs, instAbs)
	}
	if err != nil {
		return fail(err.Error())
	}
	e.emitInstall(instanceID, fmt.Sprintf("restore done: %d files", files))
	return ok(map[string]any{"instance_id": instanceID, "restored": true, "files": files})
}

func (e *Executor) HeartbeatSnapshot() protocol.Heartbeat {
	var hb protocol.Heartbeat

	// System stats (best-effort).
	if e.cpu != nil {
		if usage, err := e.cpu.UsagePercent(); err == nil {
			hb.CPU = &protocol.CPUStat{UsagePercent: usage}
		}
	}
	if mem, err := sysinfo.ReadMemStats(); err == nil && mem.TotalBytes > 0 {
		hb.Mem = &protocol.MemStat{
			TotalBytes: mem.TotalBytes,
			UsedBytes:  mem.UsedBytes,
			FreeBytes:  mem.AvailableBytes,
		}
	}
	if e.deps.FS != nil {
		diskPath := filepath.Dir(e.deps.FS.Root())
		if disk, err := sysinfo.ReadDiskStats(diskPath); err == nil && disk.TotalBytes > 0 {
			hb.Disk = &protocol.DiskStat{
				Path:       disk.Path,
				TotalBytes: disk.TotalBytes,
				UsedBytes:  disk.UsedBytes,
				FreeBytes:  disk.FreeBytes,
			}
		}
	}

	// Network (best-effort).
	{
		host := sysinfo.Hostname()
		ips := sysinfo.ListLocalIPv4()
		var preferred []string
		seen := make(map[string]struct{})
		add := func(v string) {
			v = strings.TrimSpace(v)
			if v == "" {
				return
			}
			if _, ok := seen[v]; ok {
				return
			}
			seen[v] = struct{}{}
			preferred = append(preferred, v)
		}
		for _, v := range e.deps.PreferredConnectAddrs {
			add(v)
		}
		if len(ips) > 0 || host != "" || len(preferred) > 0 {
			hb.Net = &protocol.NetInfo{
				Hostname:              host,
				IPv4:                  ips,
				PreferredConnectAddrs: preferred,
			}
		}
	}

	// FRP
	for _, st := range e.deps.FRP.Statuses() {
		hb.FRPProxies = append(hb.FRPProxies, protocol.FRPStatus{
			Running:     true,
			ProxyName:   st.ProxyName,
			RemoteAddr:  st.RemoteAddr,
			RemotePort:  st.RemotePort,
			StartedUnix: st.StartedUnix,
		})
	}
	if len(hb.FRPProxies) > 0 {
		first := hb.FRPProxies[0]
		hb.FRP = &first
	}

	// MC instances
	instances := e.deps.MC.List()
	ticksByPID := make(map[int]uint64)
	memByPID := make(map[int]uint64)
	for _, st := range instances {
		if !st.Running || st.PID <= 0 {
			continue
		}
		if ticks, err := sysinfo.ReadProcCPUTicks(st.PID); err == nil {
			ticksByPID[st.PID] = ticks
		}
		if rss, err := sysinfo.ReadProcRSSBytes(st.PID); err == nil {
			memByPID[st.PID] = rss
		}
	}
	cpuByPID := make(map[int]float64)
	if total, _, err := sysinfo.ReadCPUTicks(); err == nil && total > 0 {
		e.procMu.Lock()
		prevTotal := e.procPrevTotal
		if prevTotal == 0 {
			e.procPrevTotal = total
			for pid, cur := range ticksByPID {
				e.procPrevByPID[pid] = cur
			}
		} else {
			deltaTotal := uint64(0)
			if total > prevTotal {
				deltaTotal = total - prevTotal
			}
			e.procPrevTotal = total
			for pid, cur := range ticksByPID {
				prev, ok := e.procPrevByPID[pid]
				e.procPrevByPID[pid] = cur
				if !ok || deltaTotal == 0 || cur < prev {
					continue
				}
				cpu := float64(cur-prev) * 100 / float64(deltaTotal)
				if cpu < 0 {
					cpu = 0
				}
				if cpu > 100 {
					cpu = 100
				}
				cpuByPID[pid] = cpu
			}
			for pid := range e.procPrevByPID {
				if _, ok := ticksByPID[pid]; ok {
					continue
				}
				delete(e.procPrevByPID, pid)
			}
		}
		e.procMu.Unlock()
	}
	ids := make([]string, 0, len(instances))
	for id := range instances {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		st := instances[id]
		var cpuPercent *float64
		if v, ok := cpuByPID[st.PID]; ok {
			val := v
			cpuPercent = &val
		}
		var memRSSBytes *uint64
		if v, ok := memByPID[st.PID]; ok {
			val := v
			memRSSBytes = &val
		}
		hb.Instances = append(hb.Instances, protocol.MCInstance{
			ID:                id,
			Running:           st.Running,
			PID:               st.PID,
			CPUPercent:        cpuPercent,
			MemRSSBytes:       memRSSBytes,
			Java:              st.Java,
			JavaMajor:         st.JavaMajor,
			RequiredJavaMajor: st.RequiredJavaMajor,
			LastExitCode:      st.LastExitCode,
			LastExitSignal:    st.LastExitSignal,
			LastExitUnix:      st.LastExitUnix,
		})
	}

	return hb
}

// BindSender is called by the WS client after it is ready.
func (e *Executor) BindSender(send func(msg protocol.Message)) {
	e.send = send
}

func (e *Executor) Execute(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	switch cmd.Name {
	case "ping":
		return ok(map[string]any{"pong": true})
	case "net_check_port":
		return e.netCheckPort(cmd)
	case "mc_templates":
		return e.mcTemplates()
	case "mc_detect_jar":
		return e.mcDetectJar(cmd)
	case "mc_required_java":
		return e.mcRequiredJava(cmd)
	case "mc_java_cache_list":
		return e.mcJavaCacheList(cmd)
	case "mc_java_cache_remove":
		return e.mcJavaCacheRemove(cmd)
	case "mc_backup":
		return e.mcBackup(ctx, cmd)
	case "mc_backup_prune":
		return e.mcBackupPrune(cmd)
	case "mc_restore":
		return e.mcRestore(ctx, cmd)
	case "schedule_get":
		return e.scheduleGet(cmd)
	case "schedule_set":
		return e.scheduleSet(cmd)
	case "schedule_run_task":
		return e.scheduleRunTask(ctx, cmd)
	case "diagnostics_bundle":
		return e.diagnosticsBundle(ctx, cmd)
	case "fs_read":
		return e.fsRead(cmd)
	case "fs_write":
		return e.fsWrite(cmd)
	case "fs_list":
		return e.fsList(cmd)
	case "fs_stat":
		return e.fsStat(cmd)
	case "fs_du":
		return e.fsDu(ctx, cmd)
	case "fs_delete":
		return e.fsDelete(cmd)
	case "fs_trash":
		return e.fsTrash(cmd)
	case "fs_trash_restore":
		return e.fsTrashRestore(cmd)
	case "fs_trash_list":
		return e.fsTrashList(cmd)
	case "fs_trash_delete":
		return e.fsTrashDelete(cmd)
	case "fs_mkdir":
		return e.fsMkdir(cmd)
	case "fs_move":
		return e.fsMove(cmd)
	case "fs_copy":
		return e.fsCopy(cmd)
	case "fs_zip":
		return e.fsZip(ctx, cmd)
	case "fs_unzip":
		return e.fsUnzip(ctx, cmd)
	case "fs_upload_begin":
		return e.fsUploadBegin(ctx, cmd)
	case "fs_upload_chunk":
		return e.fsUploadChunk(ctx, cmd)
	case "fs_upload_commit":
		return e.fsUploadCommit(ctx, cmd)
	case "fs_upload_abort":
		return e.fsUploadAbort(ctx, cmd)
	case "fs_download":
		return e.fsDownload(ctx, cmd)
	case "frpc_install":
		return e.frpcInstall(ctx, cmd)
	case "mc_install_vanilla":
		return e.mcInstallVanilla(ctx, cmd)
	case "mc_install_paper":
		return e.mcInstallPaper(ctx, cmd)
	case "mc_start":
		return e.mcStart(ctx, cmd)
	case "mc_restart":
		return e.mcRestart(ctx, cmd)
	case "mc_stop":
		return e.mcStop(ctx, cmd)
	case "mc_delete":
		return e.mcDelete(ctx, cmd)
	case "mc_console":
		return e.mcConsole(ctx, cmd)
	case "frp_start":
		return e.frpStart(ctx, cmd)
	case "frp_stop":
		return e.frpStop(ctx, cmd)
	default:
		return fail(fmt.Sprintf("unknown command: %s", cmd.Name))
	}
}

func (e *Executor) fsDownload(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	url, _ := asString(cmd.Args["url"])
	sha256, _ := asString(cmd.Args["sha256"])
	sha1, _ := asString(cmd.Args["sha1"])
	instanceID, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(path) == "" {
		return fail("path is required")
	}
	if strings.TrimSpace(url) == "" {
		return fail("url is required")
	}
	abs, err := e.deps.FS.Resolve(path)
	if err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(instanceID) != "" {
		e.emitInstall(instanceID, fmt.Sprintf("download: %s -> %s", url, path))
	}
	res, err := download.DownloadFileWithChecksums(ctx, url, abs, sha256, sha1)
	if err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(instanceID) != "" {
		msg := fmt.Sprintf("download ok: bytes=%d", res.Bytes)
		if res.SHA256 != "" {
			msg += fmt.Sprintf(" sha256=%s", res.SHA256)
		}
		if res.SHA1 != "" {
			msg += fmt.Sprintf(" sha1=%s", res.SHA1)
		}
		e.emitInstall(instanceID, msg)
	}
	return ok(map[string]any{
		"path":   path,
		"bytes":  res.Bytes,
		"sha256": res.SHA256,
		"sha1":   res.SHA1,
	})
}

func (e *Executor) frpcInstall(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	url, _ := asString(cmd.Args["url"])
	sha256, _ := asString(cmd.Args["sha256"])
	if strings.TrimSpace(url) == "" {
		return fail("url is required")
	}
	sha256 = strings.TrimSpace(sha256)
	if sha256 == "" {
		return fail("sha256 is required")
	}
	if !sha256HexPattern.MatchString(sha256) {
		return fail("sha256 must be 64 hex chars")
	}
	if strings.TrimSpace(e.deps.FRPC) == "" {
		return fail("daemon misconfigured: frpc path is empty")
	}
	res, err := download.DownloadFile(ctx, url, e.deps.FRPC, sha256)
	if err != nil {
		return fail(err.Error())
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(e.deps.FRPC, 0o755)
	}
	return ok(map[string]any{
		"path":   e.deps.FRPC,
		"bytes":  res.Bytes,
		"sha256": res.SHA256,
	})
}

func (e *Executor) mcInstallVanilla(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	version, _ := asString(cmd.Args["version"])
	jarName, _ := asString(cmd.Args["jar_name"])
	acceptEULA, _ := asBool(cmd.Args["accept_eula"])

	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(version) == "" {
		return fail("version is required")
	}
	if strings.TrimSpace(jarName) == "" {
		jarName = "server.jar"
	}
	if err := validateJarName(jarName); err != nil {
		return fail(err.Error())
	}

	targetRel := filepath.Join(instanceID, jarName)
	targetAbs, err := e.deps.FS.Resolve(targetRel)
	if err != nil {
		return fail(err.Error())
	}

	e.emitInstall(instanceID, fmt.Sprintf("resolve vanilla version=%s", version))
	resolved, err := mcinstall.ResolveVanillaServerJar(ctx, e.deps.Mojang.MetaBaseURL, e.deps.Mojang.DataBaseURL, version)
	if err != nil {
		return fail(err.Error())
	}

	e.emitInstall(instanceID, fmt.Sprintf("download server jar -> %s", targetRel))
	dl, err := download.DownloadFileWithChecksumsProgress(ctx, resolved.URL, targetAbs, "", resolved.SHA1, func(p download.Progress) {
		if p.Total > 0 {
			e.emitInstall(instanceID, fmt.Sprintf("downloading... %d/%d bytes (%.1f%%)", p.Bytes, p.Total, float64(p.Bytes)*100/float64(p.Total)))
		} else {
			e.emitInstall(instanceID, fmt.Sprintf("downloading... %d bytes", p.Bytes))
		}
	})
	if err != nil {
		return fail(err.Error())
	}
	e.emitInstall(instanceID, fmt.Sprintf("download ok: bytes=%d sha1=%s", dl.Bytes, dl.SHA1))

	if acceptEULA {
		if err := e.writeEULA(instanceID); err != nil {
			return fail(err.Error())
		}
		e.emitInstall(instanceID, "wrote eula.txt (accepted)")
	}

	return ok(map[string]any{
		"instance_id": instanceID,
		"version":     resolved.Version,
		"jar_path":    jarName,
		"path":        targetRel,
		"url":         resolved.URL,
		"sha1":        resolved.SHA1,
		"bytes":       dl.Bytes,
	})
}

func (e *Executor) mcInstallPaper(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	version, _ := asString(cmd.Args["version"])
	jarName, _ := asString(cmd.Args["jar_name"])
	build, _ := asInt(cmd.Args["build"])
	acceptEULA, _ := asBool(cmd.Args["accept_eula"])

	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(version) == "" {
		return fail("version is required")
	}
	if strings.TrimSpace(jarName) == "" {
		jarName = "server.jar"
	}
	if err := validateJarName(jarName); err != nil {
		return fail(err.Error())
	}

	targetRel := filepath.Join(instanceID, jarName)
	targetAbs, err := e.deps.FS.Resolve(targetRel)
	if err != nil {
		return fail(err.Error())
	}

	e.emitInstall(instanceID, fmt.Sprintf("resolve paper version=%s build=%d", version, build))
	resolved, err := mcinstall.ResolvePaperJar(ctx, e.deps.Paper.APIBaseURL, version, build)
	if err != nil {
		return fail(err.Error())
	}

	e.emitInstall(instanceID, fmt.Sprintf("download paper jar -> %s", targetRel))
	dl, err := download.DownloadFileWithChecksumsProgress(ctx, resolved.URL, targetAbs, resolved.SHA256, "", func(p download.Progress) {
		if p.Total > 0 {
			e.emitInstall(instanceID, fmt.Sprintf("downloading... %d/%d bytes (%.1f%%)", p.Bytes, p.Total, float64(p.Bytes)*100/float64(p.Total)))
		} else {
			e.emitInstall(instanceID, fmt.Sprintf("downloading... %d bytes", p.Bytes))
		}
	})
	if err != nil {
		return fail(err.Error())
	}
	e.emitInstall(instanceID, fmt.Sprintf("download ok: bytes=%d sha256=%s", dl.Bytes, dl.SHA256))

	if acceptEULA {
		if err := e.writeEULA(instanceID); err != nil {
			return fail(err.Error())
		}
		e.emitInstall(instanceID, "wrote eula.txt (accepted)")
	}

	return ok(map[string]any{
		"instance_id": instanceID,
		"version":     resolved.Version,
		"build":       resolved.Build,
		"jar_path":    jarName,
		"path":        targetRel,
		"url":         resolved.URL,
		"sha256":      resolved.SHA256,
		"bytes":       dl.Bytes,
	})
}

func (e *Executor) fsRead(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	if strings.TrimSpace(path) == "" {
		return fail("path is required")
	}
	abs, err := e.deps.FS.Resolve(path)
	if err != nil {
		return fail(err.Error())
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"path": path,
		"b64":  base64.StdEncoding.EncodeToString(b),
	})
}

func (e *Executor) fsWrite(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	b64, _ := asString(cmd.Args["b64"])
	if strings.TrimSpace(path) == "" {
		return fail("path is required")
	}
	if b64 == "" {
		return fail("b64 is required")
	}
	abs, err := e.deps.FS.Resolve(path)
	if err != nil {
		return fail(err.Error())
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fail("invalid b64")
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fail(err.Error())
	}
	if err := os.WriteFile(abs, data, 0o600); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"path": path, "bytes": len(data)})
}

func (e *Executor) fsList(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	abs, err := e.deps.FS.Resolve(path)
	if err != nil {
		return fail(err.Error())
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return fail(err.Error())
	}
	out := make([]map[string]any, 0, len(entries))
	for _, ent := range entries {
		info, _ := ent.Info()
		var mtimeUnix int64
		if info != nil {
			mtimeUnix = info.ModTime().Unix()
		}
		out = append(out, map[string]any{
			"name":  ent.Name(),
			"isDir": ent.IsDir(),
			"size": func() int64 {
				if info != nil {
					return info.Size()
				}
				return 0
			}(),
			"mtime_unix": mtimeUnix,
		})
	}
	return ok(map[string]any{"path": path, "entries": out})
}

func (e *Executor) fsDelete(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	if strings.TrimSpace(path) == "" {
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
		return fail("refuse to delete root")
	}

	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("not found")
		}
		return fail(err.Error())
	}

	if err := os.RemoveAll(abs); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"path": path, "deleted": true, "is_dir": info.IsDir()})
}

func (e *Executor) fsMkdir(cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	if strings.TrimSpace(path) == "" {
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
		return fail("refuse to mkdir root")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"path": path, "created": true})
}

func (e *Executor) fsMove(cmd protocol.Command) protocol.CommandResult {
	from, _ := asString(cmd.Args["from"])
	to, _ := asString(cmd.Args["to"])
	if strings.TrimSpace(from) == "" {
		return fail("from is required")
	}
	if strings.TrimSpace(to) == "" {
		return fail("to is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	absFrom, err := e.deps.FS.Resolve(from)
	if err != nil {
		return fail(err.Error())
	}
	absTo, err := e.deps.FS.Resolve(to)
	if err != nil {
		return fail(err.Error())
	}
	if filepath.Clean(absFrom) == filepath.Clean(e.deps.FS.Root()) || filepath.Clean(absTo) == filepath.Clean(e.deps.FS.Root()) {
		return fail("refuse to move root")
	}

	if err := os.MkdirAll(filepath.Dir(absTo), 0o755); err != nil {
		return fail(err.Error())
	}
	if _, err := os.Stat(absTo); err == nil {
		return fail("destination exists")
	}
	if err := os.Rename(absFrom, absTo); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"from": from, "to": to, "moved": true})
}

func (e *Executor) fsUnzip(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	zipPath, _ := asString(cmd.Args["zip_path"])
	destDir, _ := asString(cmd.Args["dest_dir"])
	instanceID, _ := asString(cmd.Args["instance_id"])
	stripTop := true
	if v, ok := asBool(cmd.Args["strip_top_level"]); ok {
		stripTop = v
	}
	if strings.TrimSpace(zipPath) == "" {
		return fail("zip_path is required")
	}
	if strings.TrimSpace(destDir) == "" {
		return fail("dest_dir is required")
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	zipAbs, err := e.deps.FS.Resolve(zipPath)
	if err != nil {
		return fail(err.Error())
	}
	destAbs, err := e.deps.FS.Resolve(destDir)
	if err != nil {
		return fail(err.Error())
	}
	if filepath.Clean(destAbs) == filepath.Clean(e.deps.FS.Root()) {
		return fail("refuse to unzip to root")
	}

	if strings.TrimSpace(instanceID) == "" {
		instanceID = destDir
	}
	e.emitInstall(instanceID, fmt.Sprintf("unzip: %s -> %s", zipPath, destDir))

	zr, err := zip.OpenReader(zipAbs)
	if err != nil {
		return fail(err.Error())
	}
	defer zr.Close()

	// Detect a single top-level directory for nicer extraction.
	stripPrefix := ""
	if stripTop {
		top := make(map[string]struct{})
		for _, f := range zr.File {
			name := strings.ReplaceAll(f.Name, "\\", "/")
			name = strings.TrimPrefix(name, "/")
			if name == "" {
				continue
			}
			if strings.HasPrefix(name, "__MACOSX/") {
				continue
			}
			parts := strings.Split(name, "/")
			if len(parts) == 0 || parts[0] == "" {
				continue
			}
			top[parts[0]] = struct{}{}
			if len(top) > 1 {
				break
			}
		}
		if len(top) == 1 {
			for k := range top {
				stripPrefix = k + "/"
			}
		}
	}

	var files, dirs int
	for _, f := range zr.File {
		select {
		case <-ctx.Done():
			return fail(ctx.Err().Error())
		default:
		}

		if f == nil {
			continue
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			return fail("zip contains symlink (refuse)")
		}

		name := strings.ReplaceAll(f.Name, "\\", "/")
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		if stripPrefix != "" && strings.HasPrefix(name, stripPrefix) {
			name = strings.TrimPrefix(name, stripPrefix)
		}
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}

		clean := path.Clean(name)
		if clean == "." || clean == "/" {
			continue
		}
		if strings.HasPrefix(clean, "../") || clean == ".." || strings.HasPrefix(clean, "/") {
			return fail("zip entry escapes destination")
		}

		rel := filepath.Join(destDir, filepath.FromSlash(clean))
		outAbs, err := e.deps.FS.Resolve(rel)
		if err != nil {
			return fail(err.Error())
		}

		if f.FileInfo().IsDir() || strings.HasSuffix(clean, "/") {
			if err := os.MkdirAll(outAbs, 0o755); err != nil {
				return fail(err.Error())
			}
			dirs++
			continue
		}

		if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
			return fail(err.Error())
		}

		rc, err := f.Open()
		if err != nil {
			return fail(err.Error())
		}
		dst, err := os.OpenFile(outAbs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			rc.Close()
			return fail(err.Error())
		}
		_, copyErr := io.Copy(dst, rc)
		_ = dst.Close()
		_ = rc.Close()
		if copyErr != nil {
			return fail(copyErr.Error())
		}
		files++
	}

	e.emitInstall(instanceID, fmt.Sprintf("unzip done: files=%d dirs=%d", files, dirs))
	return ok(map[string]any{"zip_path": zipPath, "dest_dir": destDir, "files": files, "dirs": dirs})
}

func (e *Executor) mcStart(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	jarPath, _ := asString(cmd.Args["jar_path"])
	javaPath, _ := asString(cmd.Args["java_path"])
	xms, _ := asString(cmd.Args["xms"])
	xmx, _ := asString(cmd.Args["xmx"])
	jvmArgs, _ := asStringSlice(cmd.Args["jvm_args"])
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}

	err := e.deps.MC.Start(ctx, mc.StartOptions{
		InstanceID: instanceID,
		JarPath:    jarPath,
		JavaPath:   javaPath,
		Xms:        xms,
		Xmx:        xmx,
		JvmArgs:    jvmArgs,
	}, func(instID, stream, line string) {
		e.emitLog(protocol.LogLine{
			Source:   "mc",
			Stream:   stream,
			Instance: instID,
			Line:     line,
		})
	})
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"instance_id": instanceID})
}

func (e *Executor) mcRestart(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}

	// Best-effort stop.
	_ = e.deps.MC.Stop(ctx, instanceID)
	return e.mcStart(ctx, cmd)
}

func (e *Executor) mcStop(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if err := e.deps.MC.Stop(ctx, instanceID); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"instance_id": instanceID})
}

func (e *Executor) mcDelete(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if err := e.deps.MC.Delete(ctx, instanceID); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"instance_id": instanceID, "deleted": true})
}

func (e *Executor) mcConsole(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	line, _ := asString(cmd.Args["line"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(line) == "" {
		return fail("line is required")
	}
	if err := e.deps.MC.SendConsole(ctx, instanceID, line); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"instance_id": instanceID})
}

func (e *Executor) frpStart(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	var proxy frp.ProxyConfig
	var err error

	instanceID, _ := asString(cmd.Args["instance_id"])
	proxy.Name = strings.TrimSpace(instanceID)
	if proxy.Name == "" {
		proxy.Name, _ = asString(cmd.Args["name"])
	}
	if err := validateInstanceID(proxy.Name); err != nil {
		return fail(err.Error())
	}
	proxy.ServerAddr, _ = asString(cmd.Args["server_addr"])
	proxy.ServerPort, err = asInt(cmd.Args["server_port"])
	if err != nil {
		return fail("server_port must be int")
	}
	proxy.Token, _ = asString(cmd.Args["token"])
	proxy.LocalIP, _ = asString(cmd.Args["local_ip"])
	proxy.LocalPort, err = asInt(cmd.Args["local_port"])
	if err != nil {
		return fail("local_port must be int")
	}
	proxy.RemotePort, err = asInt(cmd.Args["remote_port"])
	if err != nil {
		return fail("remote_port must be int")
	}

	if err := e.deps.FRP.Start(ctx, proxy, func(stream, line string) {
		e.emitLog(protocol.LogLine{
			Source:   "frp",
			Stream:   stream,
			Instance: proxy.Name,
			Line:     line,
		})
	}); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"name": proxy.Name})
}

func (e *Executor) frpStop(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	name, _ := asString(cmd.Args["instance_id"])
	if strings.TrimSpace(name) == "" {
		name, _ = asString(cmd.Args["name"])
	}
	if strings.TrimSpace(name) == "" {
		if err := e.deps.FRP.StopAll(ctx); err != nil {
			return fail(err.Error())
		}
		return ok(map[string]any{"stopped": true})
	}
	if err := validateInstanceID(name); err != nil {
		return fail(err.Error())
	}
	if err := e.deps.FRP.StopProxy(ctx, name); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"stopped": true, "name": name})
}

func (e *Executor) emitLog(line protocol.LogLine) {
	if e.send == nil {
		return
	}
	payload, _ := jsonMarshal(line)
	e.send(protocol.Message{
		Type:    "log",
		TSUnix:  timeNowUnix(),
		Payload: payload,
	})
}

func (e *Executor) emitInstall(instanceID string, line string) {
	e.emitLog(protocol.LogLine{
		Source:   "install",
		Stream:   "stdout",
		Instance: instanceID,
		Line:     line,
	})
}

func ok(out map[string]any) protocol.CommandResult {
	return protocol.CommandResult{OK: true, Output: out}
}

func fail(msg string) protocol.CommandResult {
	return protocol.CommandResult{OK: false, Error: msg}
}

func asString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func asStringSlice(v any) ([]string, bool) {
	switch a := v.(type) {
	case []string:
		out := make([]string, 0, len(a))
		for _, it := range a {
			s := strings.TrimSpace(it)
			if s != "" {
				out = append(out, s)
			}
		}
		return out, true
	case []any:
		out := make([]string, 0, len(a))
		for _, it := range a {
			s, ok := it.(string)
			if !ok {
				continue
			}
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out, true
	default:
		return nil, false
	}
}

func asInt(v any) (int, error) {
	switch n := v.(type) {
	case float64:
		return int(n), nil
	case int:
		return n, nil
	case int64:
		return int(n), nil
	case string:
		// allow stringified numbers
		if strings.TrimSpace(n) == "" {
			return 0, errors.New("empty")
		}
		var i int
		_, err := fmt.Sscanf(n, "%d", &i)
		return i, err
	default:
		return 0, errors.New("not a number")
	}
}

func asBool(v any) (bool, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "1", "true", "yes", "y", "on":
			return true, true
		case "0", "false", "no", "n", "off":
			return false, true
		default:
			return false, false
		}
	case float64:
		return b != 0, true
	case int:
		return b != 0, true
	case int64:
		return b != 0, true
	default:
		return false, false
	}
}

func (e *Executor) writeEULA(instanceID string) error {
	abs, err := e.deps.FS.Resolve(filepath.Join(instanceID, "eula.txt"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	content := "# Generated by ElegantMC\n# By changing the setting below to TRUE you are indicating your agreement to the EULA (https://aka.ms/MinecraftEULA).\n" +
		"eula=true\n"
	return os.WriteFile(abs, []byte(content), 0o600)
}

func validateInstanceID(instanceID string) error {
	instanceID = strings.TrimSpace(instanceID)
	if !instanceIDPattern.MatchString(instanceID) {
		return errors.New("invalid instance_id (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,63})")
	}
	return nil
}

func validateJarName(jarName string) error {
	jarName = strings.TrimSpace(jarName)
	if jarName == "" {
		return errors.New("jar_name is empty")
	}
	if strings.Contains(jarName, "..") || strings.ContainsAny(jarName, `/\\`) {
		return errors.New("invalid jar_name (must be a simple filename, no slashes or '..')")
	}
	return nil
}
