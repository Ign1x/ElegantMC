"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

export default function GamesView() {
  const {
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceId,
    setInstanceId,
    selectedDaemon,
    openSettingsModal,
    openInstallModal,
    startServer,
    stopServer,
    restartServer,
    deleteServer,
    backupServer,
    openRestoreModal,
    openServerPropertiesEditor,
    renameInstance,
    cloneInstance,
    backupZips,
    backupZipsStatus,
    refreshBackupZips,
    frpOpStatus,
    serverOpStatus,
    gameActionBusy,
    instanceStatus,
    frpStatus,
    localHost,
    gamePort,
    copyText,
    enableFrp,
    selectedProfile,
    frpRemotePort,
    setTab,
    fmtUnix,
    fmtBytes,
    logView,
    setLogView,
    logs,
    consoleLine,
    setConsoleLine,
    sendConsoleLine,
    setFsPath,
    instanceUsageBytes,
    instanceUsageStatus,
    instanceUsageBusy,
    computeInstanceUsage,
  } = useAppCtx();

  const running = !!instanceStatus?.running;
  const canControl = !!selectedDaemon?.connected && !!instanceId.trim() && !gameActionBusy;

  const [logQuery, setLogQuery] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [highlightLogs, setHighlightLogs] = useState<boolean>(true);
  const [logPaused, setLogPaused] = useState<boolean>(false);
  const [pausedLogs, setPausedLogs] = useState<any[] | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const socketText = useMemo(() => {
    if (frpStatus?.running && frpStatus.remote_port) {
      return `${frpStatus.remote_addr}:${frpStatus.remote_port}`;
    }
    const ip = localHost || "127.0.0.1";
    return `${ip}:${Math.round(Number(gamePort || 25565))}`;
  }, [frpStatus, localHost, gamePort]);

  const lastBackup = useMemo(() => {
    const list = Array.isArray(backupZips) ? backupZips : [];
    if (!list.length) return { unix: null as number | null, file: "" };
    const p = String(list[0] || "");
    const file = p.split("/").pop() || p;
    const m = file.match(/-(\d{9,12})\.zip$/);
    const unix = m ? Number(m[1]) : null;
    return { unix: Number.isFinite(Number(unix)) ? Number(unix) : null, file };
  }, [backupZips]);

  useEffect(() => {
    if (!logPaused) {
      setPausedLogs(null);
      return;
    }
    setPausedLogs(Array.isArray(logs) ? logs.slice() : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logPaused]);

  const filteredLogs = useMemo(() => {
    const inst = instanceId.trim();
    const q = logQuery.trim().toLowerCase();
    const source = logPaused && pausedLogs ? pausedLogs : logs;
    const list = (source || []).filter((l: any) => {
      if (logView === "frp") return l.source === "frp" && (!l.instance || l.instance === inst);
      if (logView === "mc") return l.source === "mc" && l.instance === inst;
      if (logView === "install") return l.source === "install" && l.instance === inst;
      // all
      return (l.instance && l.instance === inst) || (l.source === "frp" && !l.instance);
    });
    if (!q) return list;
    return list.filter((l: any) => String(l?.line || "").toLowerCase().includes(q));
  }, [logs, logView, instanceId, logQuery, logPaused, pausedLogs]);

  const logText = useMemo(() => {
    return filteredLogs.length
      ? filteredLogs
          .slice(-400)
          .map((l: any) => {
            const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
            const src = l.source || "daemon";
            const stream = l.stream || "";
            const inst = l.instance ? `(${l.instance})` : "";
            return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
          })
          .join("\n")
      : "<no logs>";
  }, [filteredLogs]);

  const logLines = useMemo(() => {
    const lines = String(logText || "").split("\n");
    return lines.map((text) => {
      const upper = String(text || "").toUpperCase();
      const isErr = /\b(ERROR|FATAL)\b/.test(upper) || upper.includes("EXCEPTION") || upper.includes("STACKTRACE");
      const isWarn = /\bWARN(ING)?\b/.test(upper);
      return { text, level: isErr ? "error" : isWarn ? "warn" : "" };
    });
  }, [logText]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logText, autoScroll]);

  useEffect(() => {
    if (!selectedDaemon?.connected) return;
    const inst = instanceId.trim();
    if (!inst) return;
    refreshBackupZips(inst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, selectedDaemon?.connected]);

  return (
    <div className="stack">
      <div className="card">
        <h2>Game</h2>

        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>Game</label>
              <Select
                value={instanceId}
                onChange={(v) => setInstanceId(v)}
                disabled={!serverDirs.length}
                placeholder="No games installed"
                options={serverDirs.map((id: string) => ({ value: id, label: id }))}
              />
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div className="hint">
                  installed: {serverDirs.length}
                  {serverDirsStatus ? ` · ${serverDirsStatus}` : ""}
                </div>
                <button
                  type="button"
                  className="iconBtn iconOnly"
                  title="Refresh games list"
                  onClick={refreshServerDirs}
                  disabled={!selectedDaemon?.connected}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </div>
          </div>

          <div className="toolbarRight">
            <div className="btnGroup">
              <button type="button" className="iconBtn" onClick={openInstallModal} disabled={!selectedDaemon?.connected || gameActionBusy}>
                <Icon name="plus" />
                Install
              </button>
            </div>

            <div className="btnGroup">
              <button
                className={running ? "" : "primary"}
                onClick={() => (running ? stopServer() : startServer())}
                disabled={!canControl}
              >
                {gameActionBusy ? "Working..." : running ? "Stop" : "Start"}
              </button>
              <Select
                value=""
                onChange={(v) => {
                  if (v === "restart") restartServer();
                  else if (v === "backup") backupServer();
                  else if (v === "restore") openRestoreModal();
                  else if (v === "properties") openServerPropertiesEditor();
                  else if (v === "rename") renameInstance();
                  else if (v === "clone") cloneInstance();
                  else if (v === "settings") openSettingsModal();
                  else if (v === "files") {
                    setFsPath(instanceId.trim());
                    setTab("files");
                  } else if (v === "delete") deleteServer();
                }}
                placeholder="More"
                options={[
                  { value: "restart", label: "Restart", disabled: !canControl },
                  { value: "backup", label: "Backup", disabled: !canControl },
                  { value: "restore", label: "Restore…", disabled: !canControl },
                  { value: "properties", label: "server.properties…", disabled: !canControl },
                  { value: "rename", label: "Rename…", disabled: !canControl },
                  { value: "clone", label: "Clone…", disabled: !canControl },
                  { value: "settings", label: "Settings", disabled: !canControl },
                  { value: "files", label: "Files", disabled: !canControl },
                  { value: "delete", label: "Delete", disabled: !canControl },
                ]}
                style={{ width: 150 }}
                disabled={!selectedDaemon?.connected || gameActionBusy}
              />
              {gameActionBusy ? <span className="badge">busy</span> : null}
            </div>
          </div>
        </div>

        {frpOpStatus || serverOpStatus ? (
          <div className="hint" style={{ marginTop: 8 }}>
            {frpOpStatus ? <span style={{ marginRight: 10 }}>FRP: {frpOpStatus}</span> : null}
            {serverOpStatus ? <span>MC: {serverOpStatus}</span> : null}
          </div>
        ) : null}

        <div className="grid2">
          <div className="kv">
            <div className="k">Status</div>
            <div className="v">
              {instanceStatus?.running ? (
                <span className="badge ok">running (pid {instanceStatus.pid || "-"})</span>
              ) : (
                <span className="badge">stopped</span>
              )}
            </div>
            <div className="hint">node: {selectedDaemon?.id || "-"}</div>
          </div>

          <div className="kv">
            <div className="k">FRP process</div>
            <div className="v">
              {frpStatus?.running ? <span className="badge ok">running</span> : <span className="badge">stopped</span>}
            </div>
          </div>

          <div className="kv">
            <div className="k">Last heartbeat</div>
            <div className="v">{fmtUnix(selectedDaemon?.heartbeat?.server_time_unix)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Connect</h2>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <code
            className="clickCopy"
            role="button"
            tabIndex={0}
            title="Click to copy"
            style={{ fontSize: 14, padding: "6px 10px" }}
            onClick={() => (instanceId.trim() ? copyText(socketText) : null)}
            onKeyDown={(e) => {
              if (!instanceId.trim()) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                copyText(socketText);
              }
            }}
          >
            {instanceId.trim() ? socketText : "-"}
          </code>
          <button type="button" className="iconBtn" onClick={() => copyText(socketText)} disabled={!instanceId.trim()}>
            <Icon name="copy" />
            Copy
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          {frpStatus?.running && frpStatus.remote_port ? (
            <span>FRP：公网连接地址（可直接复制给朋友）。</span>
          ) : enableFrp ? (
            !selectedProfile ? (
              <span>
                FRP 已开启但未选择服务器（去{" "}
                <button className="linkBtn" onClick={() => setTab("frp")}>
                  FRP
                </button>{" "}
                保存一个 profile）。
              </span>
            ) : frpRemotePort <= 0 ? (
              <span>FRP 已开启但 Remote Port=0（由服务端分配端口；建议手动指定一个固定端口）。</span>
            ) : (
              <span>FRP：启动后会显示公网地址。</span>
            )
          ) : (
            <span>未开启 FRP：显示本机/LAN 连接地址（Docker 默认映射 25565-25600）。</span>
          )}
        </div>
        <div className="hint">
          Minecraft：多人游戏 → 添加服务器 → 地址填 <code>{instanceId.trim() ? socketText : "IP:Port"}</code>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>Backups</h2>
              <div className="hint">
                {instanceId.trim() ? (
                  <>
                    folder: <code>servers/_backups/{instanceId.trim()}/</code>
                    {typeof backupZipsStatus === "string" && backupZipsStatus ? ` · ${backupZipsStatus}` : ""}
                  </>
                ) : (
                  "Select a game to view backups"
                )}
              </div>
              {instanceId.trim() ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  size: <code>{instanceUsageBytes == null ? "-" : fmtBytes(instanceUsageBytes)}</code>
                  {instanceUsageStatus ? ` · ${instanceUsageStatus}` : ""}
                  {" · "}
                  last backup: {lastBackup.unix ? fmtUnix(lastBackup.unix) : Array.isArray(backupZips) && backupZips.length ? lastBackup.file : "-"}
                </div>
              ) : null}
            </div>
          </div>
          <div className="toolbarRight">
            <button
              type="button"
              className="iconBtn"
              onClick={() => refreshBackupZips(instanceId.trim())}
              disabled={!selectedDaemon?.connected || !instanceId.trim()}
            >
              <Icon name="refresh" />
              Refresh
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => computeInstanceUsage()}
              disabled={!selectedDaemon?.connected || !instanceId.trim() || instanceUsageBusy}
              title="Compute instance folder size (may take a while)"
            >
              {instanceUsageBusy ? "Scanning…" : "Compute size"}
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const inst = instanceId.trim();
                if (!inst) return;
                setFsPath(`_backups/${inst}`);
                setTab("files");
              }}
              disabled={!selectedDaemon?.connected || !instanceId.trim()}
            >
              Open folder
            </button>
          </div>
        </div>

        {instanceId.trim() ? (
          Array.isArray(backupZips) && backupZips.length ? (
            <>
              <div className="hint">
                showing {Math.min(10, backupZips.length)} / {backupZips.length}
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {backupZips.slice(0, 10).map((p: string) => (
                  <div key={p} className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <code style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p}</code>
                    <button type="button" className="iconBtn iconOnly" title="Copy path" onClick={() => copyText(p)}>
                      <Icon name="copy" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="hint">
              No backups yet. Use <code>More → Backup</code> to create one.
            </div>
          )
        ) : (
          <div className="hint">Select a game to see backups.</div>
        )}
      </div>

      <div className="card">
        <h2>Logs</h2>
        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ minWidth: 180 }}>
              <label>View</label>
              <Select
                value={logView}
                onChange={(v) => setLogView(v as any)}
                options={[
                  { value: "all", label: "All" },
                  { value: "mc", label: "MC" },
                  { value: "install", label: "Install" },
                  { value: "frp", label: "FRP" },
                ]}
              />
            </div>
          </div>
          <div className="toolbarRight">
            <input
              value={logQuery}
              onChange={(e: any) => setLogQuery(e.target.value)}
              placeholder="Search logs…"
              style={{ width: 220 }}
            />
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> autoscroll
            </label>
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={highlightLogs} onChange={(e) => setHighlightLogs(e.target.checked)} /> highlight
            </label>
            <button type="button" className="iconBtn" onClick={() => setLogPaused((v) => !v)}>
              {logPaused ? "Resume" : "Pause"}
            </button>
            {logPaused ? <span className="badge">paused</span> : null}
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const text =
                  filteredLogs
                    .slice(-300)
                    .map((l: any) => {
                      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
                      const src = l.source || "daemon";
                      const stream = l.stream || "";
                      const inst = l.instance ? `(${l.instance})` : "";
                      return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
                    })
                    .join("\n") || "";
                copyText(text || "<empty>");
              }}
            >
              <Icon name="copy" />
              Copy
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const text =
                  filteredLogs
                    .slice(-2000)
                    .map((l: any) => {
                      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
                      const src = l.source || "daemon";
                      const stream = l.stream || "";
                      const inst = l.instance ? `(${l.instance})` : "";
                      return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
                    })
                    .join("\n") || "";
                const blob = new Blob([text || "<empty>"], { type: "text/plain;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const name = instanceId.trim() ? `elegantmc-${instanceId.trim()}-logs.txt` : `elegantmc-logs.txt`;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }}
            >
              <Icon name="download" />
              Download
            </button>
          </div>
        </div>
        <pre ref={preRef} style={{ maxHeight: 640, overflow: "auto" }}>
          {highlightLogs
            ? logLines.map((l, idx) => (
                <span key={idx} className={`logLine ${l.level}`}>
                  {l.text}
                  {"\n"}
                </span>
              ))
            : logText}
        </pre>
        <div className="hint">提示：All 会显示当前游戏 + FRP 的日志。</div>

        <div className="row" style={{ marginTop: 12 }}>
          <input
            value={consoleLine}
            onChange={(e) => setConsoleLine(e.target.value)}
            placeholder="Console command (e.g. say hi)"
            style={{ flex: 1, minWidth: 240 }}
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
          />
          <button onClick={sendConsoleLine} disabled={!consoleLine.trim() || !selectedDaemon?.connected || !instanceId.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
