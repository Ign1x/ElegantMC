package commands

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"runtime"
	"strconv"
	"strings"

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
	Log    *log.Logger
	FS     *sandbox.FS
	FRP    *frp.Manager
	MC     *mc.Manager
	Daemon string
	FRPC   string
	PreferredConnectAddrs []string

	Mojang MojangConfig
	Paper  PaperConfig
}

type Executor struct {
	deps ExecutorDeps

	// Wire set by ws client (so command handlers can emit logs back to panel).
	send func(msg protocol.Message)

	uploads *uploadManager

	cpu *sysinfo.CPUTracker
}

var instanceIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func NewExecutor(deps ExecutorDeps) *Executor {
	ex := &Executor{deps: deps, cpu: &sysinfo.CPUTracker{}}
	if deps.FS != nil {
		ex.uploads = newUploadManager(deps.FS)
	}
	return ex
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
		if len(ips) > 0 {
			tmp := append([]string(nil), ips...)
			rank := func(ip string) int {
				if strings.HasPrefix(ip, "10.") || strings.HasPrefix(ip, "192.168.") {
					return 0
				}
				if strings.HasPrefix(ip, "172.") {
					parts := strings.Split(ip, ".")
					if len(parts) >= 2 {
						if n, err := strconv.Atoi(parts[1]); err == nil && n >= 16 && n <= 31 {
							return 0
						}
					}
				}
				return 1
			}
			sort.SliceStable(tmp, func(i, j int) bool {
				ri := rank(tmp[i])
				rj := rank(tmp[j])
				if ri != rj {
					return ri < rj
				}
				return tmp[i] < tmp[j]
			})
			for _, ip := range tmp {
				add(ip)
			}
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
	frpSt := e.deps.FRP.Status()
	if frpSt.Running {
		hb.FRP = &protocol.FRPStatus{
			Running:     true,
			ProxyName:   frpSt.ProxyName,
			RemoteAddr:  frpSt.RemoteAddr,
			RemotePort:  frpSt.RemotePort,
			StartedUnix: frpSt.StartedUnix,
		}
	}

	// MC instances
	instances := e.deps.MC.List()
	ids := make([]string, 0, len(instances))
	for id := range instances {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		st := instances[id]
		hb.Instances = append(hb.Instances, protocol.MCInstance{
			ID:      id,
			Running: st.Running,
			PID:     st.PID,
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
	case "fs_read":
		return e.fsRead(cmd)
	case "fs_write":
		return e.fsWrite(cmd)
	case "fs_list":
		return e.fsList(cmd)
	case "fs_delete":
		return e.fsDelete(cmd)
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
		return e.frpStop(ctx)
	default:
		return fail(fmt.Sprintf("unknown command: %s", cmd.Name))
	}
}

func (e *Executor) fsDownload(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	path, _ := asString(cmd.Args["path"])
	url, _ := asString(cmd.Args["url"])
	sha256, _ := asString(cmd.Args["sha256"])
	sha1, _ := asString(cmd.Args["sha1"])
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
	res, err := download.DownloadFileWithChecksums(ctx, url, abs, sha256, sha1)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"path":   path,
		"bytes": res.Bytes,
		"sha256": res.SHA256,
		"sha1":  res.SHA1,
	})
}

func (e *Executor) frpcInstall(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	url, _ := asString(cmd.Args["url"])
	sha256, _ := asString(cmd.Args["sha256"])
	if strings.TrimSpace(url) == "" {
		return fail("url is required")
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
		out = append(out, map[string]any{
			"name":  ent.Name(),
			"isDir": ent.IsDir(),
			"size":  func() int64 { if info != nil { return info.Size() }; return 0 }(),
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

func (e *Executor) mcStart(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	jarPath, _ := asString(cmd.Args["jar_path"])
	javaPath, _ := asString(cmd.Args["java_path"])
	xms, _ := asString(cmd.Args["xms"])
	xmx, _ := asString(cmd.Args["xmx"])
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}

	err := e.deps.MC.Start(ctx, mc.StartOptions{
		InstanceID: instanceID,
		JarPath:    jarPath,
		JavaPath:   javaPath,
		Xms:        xms,
		Xmx:        xmx,
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

	proxy.Name, _ = asString(cmd.Args["name"])
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
			Source: "frp",
			Stream: stream,
			Line:   line,
		})
	}); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"name": proxy.Name})
}

func (e *Executor) frpStop(ctx context.Context) protocol.CommandResult {
	if err := e.deps.FRP.Stop(ctx); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"stopped": true})
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
