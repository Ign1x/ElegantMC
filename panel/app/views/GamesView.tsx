"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

type RenderLogLine = { text: string; level: "" | "warn" | "error" };

export default function GamesView() {
  const {
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceId,
    setInstanceId,
    instanceTagsById,
    updateInstanceTags,
    selectedDaemon,
    openSettingsModal,
    openInstallModal,
    startServer,
    stopServer,
    restartServer,
    deleteServer,
    backupServer,
    openRestoreModal,
    openTrashModal,
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
    downloadLatestLog,
    setFsPath,
    instanceUsageBytes,
    instanceUsageStatus,
    instanceUsageBusy,
    computeInstanceUsage,
  } = useAppCtx();

  const running = !!instanceStatus?.running;
  const canControl = !!selectedDaemon?.connected && !!instanceId.trim() && !gameActionBusy;

  const [logQueryRaw, setLogQueryRaw] = useState<string>("");
  const [logQuery, setLogQuery] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [highlightLogs, setHighlightLogs] = useState<boolean>(true);
  const [logPaused, setLogPaused] = useState<boolean>(false);
  const [logClearAtUnix, setLogClearAtUnix] = useState<number>(0);
  const [pausedLogs, setPausedLogs] = useState<any[] | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [logScrollTop, setLogScrollTop] = useState<number>(0);
  const [logNearBottom, setLogNearBottom] = useState<boolean>(true);

  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState<number>(0);
  const [tagFilter, setTagFilter] = useState<string>("");
  const [tagsDraft, setTagsDraft] = useState<string>("");

  const socketText = useMemo(() => {
    if (frpStatus?.running && frpStatus.remote_port) {
      return `${frpStatus.remote_addr}:${frpStatus.remote_port}`;
    }
    const ip = localHost || "127.0.0.1";
    return `${ip}:${Math.round(Number(gamePort || 25565))}`;
  }, [frpStatus, localHost, gamePort]);

  const currentTags = useMemo(() => {
    const inst = String(instanceId || "").trim();
    if (!inst) return [] as string[];
    const list = (instanceTagsById && (instanceTagsById as any)[inst]) || [];
    return Array.isArray(list) ? list.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
  }, [instanceId, instanceTagsById]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const id of serverDirs || []) {
      const list = (instanceTagsById && (instanceTagsById as any)[id]) || [];
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        const s = String(t || "").trim();
        if (s) set.add(s);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [serverDirs, instanceTagsById]);

  const filteredServerDirs = useMemo(() => {
    const q = String(tagFilter || "").trim().toLowerCase();
    if (!q) return serverDirs;
    return (serverDirs || []).filter((id: string) => {
      const list = (instanceTagsById && (instanceTagsById as any)[id]) || [];
      if (!Array.isArray(list)) return false;
      return list.some((t: any) => String(t || "").trim().toLowerCase() === q);
    });
  }, [serverDirs, instanceTagsById, tagFilter]);

  useEffect(() => {
    setTagsDraft(currentTags.join(", "));
  }, [instanceId, currentTags.join("|")]);

  function saveTags() {
    const inst = instanceId.trim();
    if (!inst) return;
    const tags = String(tagsDraft || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateInstanceTags(inst, tags);
  }

  const instanceProxies = useMemo(() => {
    const inst = String(instanceId || "").trim();
    const list = Array.isArray(selectedDaemon?.heartbeat?.frp_proxies) ? selectedDaemon.heartbeat.frp_proxies : [];
    if (!inst || !list.length) return [];
    const prefix = `${inst}-`;
    return list.filter((p: any) => {
      const name = String(p?.proxy_name || "").trim();
      return name === inst || name.startsWith(prefix);
    });
  }, [selectedDaemon, instanceId]);

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

  useEffect(() => {
    const t = window.setTimeout(() => setLogQuery(logQueryRaw), 180);
    return () => window.clearTimeout(t);
  }, [logQueryRaw]);

  useEffect(() => {
    setLogClearAtUnix(0);
  }, [instanceId, logView]);

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
    const since = Math.max(0, Math.floor(Number(logClearAtUnix || 0)));
    const next = since ? list.filter((l: any) => Math.floor(Number(l?.ts_unix || 0)) >= since) : list;
    if (!q) return next;
    return next.filter((l: any) => String(l?.line || "").toLowerCase().includes(q));
  }, [logs, logView, instanceId, logQuery, logPaused, pausedLogs, logClearAtUnix]);

  const logLines = useMemo<RenderLogLine[]>(() => {
    const list = filteredLogs.length ? filteredLogs.slice(-2000) : [];
    if (!list.length) return [{ text: "<no logs>", level: "" }];
    return list.map((l: any) => {
      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
      const src = l.source || "daemon";
      const stream = l.stream || "";
      const inst = l.instance ? `(${l.instance})` : "";
      const text = `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
      const upper = String(text || "").toUpperCase();
      const isErr = /\b(ERROR|FATAL)\b/.test(upper) || upper.includes("EXCEPTION") || upper.includes("STACKTRACE");
      const isWarn = /\bWARN(ING)?\b/.test(upper);
      return { text, level: isErr ? "error" : isWarn ? "warn" : "" };
    });
  }, [filteredLogs]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll]);

  useEffect(() => {
    if (!autoScroll || !logNearBottom) return;
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines.length, autoScroll, logNearBottom]);

  const logVirtual = useMemo<{
    start: number;
    end: number;
    topPad: number;
    bottomPad: number;
    visible: RenderLogLine[];
  }>(() => {
    const total = logLines.length;
    const lineHeight = 18;
    const viewHeight = 640;
    const overscan = 12;
    const start = Math.max(0, Math.floor(logScrollTop / lineHeight) - overscan);
    const visibleCount = Math.ceil(viewHeight / lineHeight) + overscan * 2;
    const end = Math.min(total, start + visibleCount);
    return {
      start,
      end,
      topPad: start * lineHeight,
      bottomPad: (total - end) * lineHeight,
      visible: logLines.slice(start, end),
    };
  }, [logLines, logScrollTop]);

  useEffect(() => {
    if (!selectedDaemon?.connected) return;
    const inst = instanceId.trim();
    if (!inst) return;
    refreshBackupZips(inst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, selectedDaemon?.connected]);

  useEffect(() => {
    const inst = instanceId.trim();
    if (!inst) {
      setCmdHistory([]);
      setCmdHistoryIdx(0);
      return;
    }
    try {
      const raw = localStorage.getItem("elegantmc_console_history_v1");
      const all = raw ? JSON.parse(raw) : {};
      const list = Array.isArray(all?.[inst]) ? all[inst] : [];
      const cleaned = list.map((s: any) => String(s || "").trim()).filter(Boolean).slice(-50);
      setCmdHistory(cleaned);
      setCmdHistoryIdx(cleaned.length);
    } catch {
      setCmdHistory([]);
      setCmdHistoryIdx(0);
    }
  }, [instanceId]);

  function persistCmdHistory(inst: string, list: string[]) {
    try {
      const raw = localStorage.getItem("elegantmc_console_history_v1");
      const all = raw ? JSON.parse(raw) : {};
      all[inst] = list.slice(-50);
      localStorage.setItem("elegantmc_console_history_v1", JSON.stringify(all));
    } catch {
      // ignore
    }
  }

  async function sendConsoleWithHistory() {
    const inst = instanceId.trim();
    const cmd = consoleLine.trim();
    if (!inst || !cmd) return;
    const next = [...cmdHistory.filter((c) => c !== cmd), cmd].slice(-50);
    setCmdHistory(next);
    setCmdHistoryIdx(next.length);
    persistCmdHistory(inst, next);
    await sendConsoleLine();
  }

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
                options={filteredServerDirs.map((id: string) => {
                  const tags = (instanceTagsById && (instanceTagsById as any)[id]) || [];
                  const list = Array.isArray(tags) ? tags.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
                  const label = list.length ? `${id} · ${list.join(", ")}` : id;
                  return { value: id, label };
                })}
              />
              <div className="row" style={{ marginTop: 8, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span className="hint">Tag filter</span>
                <div style={{ width: 220 }}>
                  <Select
                    value={tagFilter}
                    onChange={(v) => setTagFilter(v)}
                    placeholder="All tags"
                    options={[{ value: "", label: "All tags" }, ...availableTags.map((t) => ({ value: t, label: t }))]}
                  />
                </div>
              </div>
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
                  else if (v === "trash") openTrashModal();
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
                  { value: "trash", label: "Trash…", disabled: !selectedDaemon?.connected },
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
              {frpStatus?.running && frpStatus.remote_port ? (
                <span className="badge">
                  {frpStatus.remote_addr}:{frpStatus.remote_port}
                </span>
              ) : null}
            </div>
            <div className="hint">
              desired:{" "}
              {enableFrp ? (
                selectedProfile ? (
                  <>
                    on (<code>{selectedProfile.name}</code>)
                  </>
                ) : (
                  <span style={{ color: "var(--danger)" }}>on (no profile)</span>
                )
              ) : (
                "off"
              )}
              {" · "}
              remote port: <code>{Math.round(Number(frpRemotePort || 0))}</code>
            </div>
          </div>

          <div className="kv">
            <div className="k">Java</div>
            <div className="v">{instanceStatus?.java ? <code>{String(instanceStatus.java)}</code> : <span className="muted">-</span>}</div>
            <div className="hint">
              major: <code>{Number(instanceStatus?.java_major || 0) || "-"}</code>
              {" · "}
              required: <code>{Number(instanceStatus?.required_java_major || 0) ? `>=${Number(instanceStatus.required_java_major)}` : "-"}</code>
            </div>
          </div>

          <div className="kv">
            <div className="k">Tags</div>
            <div className="v">
              {currentTags.length ? currentTags.map((t) => <span key={t} className="badge">{t}</span>) : <span className="muted">-</span>}
            </div>
            <div className="hint">
              <div className="row" style={{ gap: 8 }}>
                <input
                  value={tagsDraft}
                  onChange={(e: any) => setTagsDraft(e.target.value)}
                  placeholder="e.g. survival, modpack"
                  style={{ flex: 1, minWidth: 180 }}
                  disabled={!instanceId.trim()}
                />
                <button type="button" onClick={saveTags} disabled={!selectedDaemon?.connected || !instanceId.trim()}>
                  Save
                </button>
              </div>
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
          <span>
            desired:{" "}
            {enableFrp ? (
              selectedProfile ? (
                <>
                  FRP on (<code>{selectedProfile.name}</code>)
                </>
              ) : (
                <span style={{ color: "var(--danger)" }}>FRP on (no profile)</span>
              )
            ) : (
              "FRP off"
            )}
            {" · "}
            actual: {frpStatus?.running ? "running" : "stopped"}
          </span>
        </div>
        <div className="hint">
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
            ) : selectedProfile.status?.online === false ? (
              <span style={{ color: "var(--danger)" }}>
                FRP server unreachable: {selectedProfile.status.error || "offline"}（去 FRP tab 点 Test/Probe）
              </span>
            ) : frpRemotePort <= 0 ? (
              <span>FRP 已开启但 Remote Port=0（由服务端分配端口；建议手动指定一个固定端口）。</span>
            ) : frpStatus && frpStatus.running === false ? (
              <span style={{ color: "var(--danger)" }}>
                FRP desired on, but not running on daemon（看 Logs → FRP / 检查 token、server_addr、server_port）
              </span>
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
        {instanceId.trim() && (enableFrp || frpStatus?.running) ? (
          instanceProxies.length ? (
            <div style={{ marginTop: 10 }}>
              <div className="hint">FRP proxies for this instance:</div>
              <div className="stack" style={{ gap: 8, marginTop: 6 }}>
                {instanceProxies.map((p: any) => (
                  <div key={`${p.proxy_name}-${p.remote_addr}-${p.remote_port}`} className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <span className={`badge ${p.running ? "ok" : ""}`}>{String(p.proxy_name || "-")}</span>
                    <code>
                      {p.remote_addr}:{p.remote_port}
                    </code>
                    <span className="hint">started: {fmtUnix(p.started_unix)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="hint" style={{ marginTop: 8 }}>
              FRP proxies: -
            </div>
          )
        ) : null}
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
              value={logQueryRaw}
              onChange={(e: any) => setLogQueryRaw(e.target.value)}
              placeholder="Search logs…"
              style={{ width: 220 }}
            />
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto-scroll
            </label>
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={highlightLogs} onChange={(e) => setHighlightLogs(e.target.checked)} /> Highlight
            </label>
            <button type="button" className="iconBtn" onClick={() => setLogPaused((v) => !v)}>
              {logPaused ? "Resume" : "Pause"}
            </button>
            {logPaused ? <span className="badge">paused</span> : null}
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                setLogClearAtUnix(Math.floor(Date.now() / 1000));
              }}
            >
              Clear view
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const text =
                  logLines
                    .slice(-300)
                    .map((l: any) => l.text)
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
                  logLines
                    .slice(-2000)
                    .map((l: any) => l.text)
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
              Download view
            </button>
            <button type="button" className="iconBtn" onClick={downloadLatestLog} disabled={!selectedDaemon?.connected || !instanceId.trim()}>
              <Icon name="download" />
              latest.log
            </button>
          </div>
        </div>
        <div
          ref={logScrollRef}
          style={{ maxHeight: 640, overflow: "auto" }}
          onScroll={(e) => {
            const el = e.currentTarget;
            setLogScrollTop(el.scrollTop);
            const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
            setLogNearBottom(remaining <= 64);
          }}
        >
          <div style={{ height: logVirtual.topPad }} />
          <pre style={{ margin: 0 }}>
            {highlightLogs
              ? logVirtual.visible.map((l, idx) => (
                  <span key={`${logVirtual.start + idx}`} className={`logLine ${l.level}`}>
                    {l.text}
                    {"\n"}
                  </span>
                ))
              : logVirtual.visible.map((l) => l.text).join("\n")}
          </pre>
          <div style={{ height: logVirtual.bottomPad }} />
        </div>
        <div className="hint">提示：All 会显示当前游戏 + FRP 的日志。</div>

        <div className="row" style={{ marginTop: 12 }}>
          <input
            value={consoleLine}
            onChange={(e) => setConsoleLine(e.target.value)}
            placeholder="Console command (e.g. say hi)"
            style={{ flex: 1, minWidth: 240 }}
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
            onKeyDown={(e: any) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendConsoleWithHistory();
                return;
              }
              if (e.key === "ArrowUp") {
                if (!cmdHistory.length) return;
                e.preventDefault();
                const nextIdx = Math.max(0, cmdHistoryIdx - 1);
                setCmdHistoryIdx(nextIdx);
                setConsoleLine(cmdHistory[nextIdx] || "");
                return;
              }
              if (e.key === "ArrowDown") {
                if (!cmdHistory.length) return;
                e.preventDefault();
                const nextIdx = Math.min(cmdHistory.length, cmdHistoryIdx + 1);
                setCmdHistoryIdx(nextIdx);
                setConsoleLine(nextIdx >= cmdHistory.length ? "" : cmdHistory[nextIdx] || "");
              }
            }}
          />
          <button onClick={sendConsoleWithHistory} disabled={!consoleLine.trim() || !selectedDaemon?.connected || !instanceId.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
