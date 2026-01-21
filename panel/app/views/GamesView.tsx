"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

type RenderLogLine = { text: string; level: "" | "warn" | "error" };

function highlightText(text: string, qLower: string) {
  const q = String(qLower || "").trim().toLowerCase();
  if (!q) return text;
  const t = String(text || "");
  const lower = t.toLowerCase();
  const parts: any[] = [];
  let i = 0;
  let hits = 0;
  const maxHits = 32;
  while (i < t.length && hits < maxHits) {
    const at = lower.indexOf(q, i);
    if (at < 0) break;
    if (at > i) parts.push(t.slice(i, at));
    parts.push(
      <mark key={`m-${hits}`} className="logMark">
        {t.slice(at, at + q.length)}
      </mark>
    );
    hits += 1;
    i = at + q.length;
  }
  if (!parts.length) return text;
  if (i < t.length) parts.push(t.slice(i));
  return parts;
}

export default function GamesView() {
  const {
    t,
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
    exportInstanceZip,
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
    confirmDialog,
    fmtUnix,
    fmtTime,
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
  const gamesLoading = serverDirsStatus === t.tr("Loading...", "加载中...") && !serverDirs.length;

  const [logQueryRaw, setLogQueryRaw] = useState<string>("");
  const [logQuery, setLogQuery] = useState<string>("");
  const [logRegex, setLogRegex] = useState<boolean>(false);
  const [logLevelFilter, setLogLevelFilter] = useState<"all" | "warn" | "error">("all");
  const [logTimeMode, setLogTimeMode] = useState<"local" | "relative">("local");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [wrapLogs, setWrapLogs] = useState<boolean>(true);
  const [highlightLogs, setHighlightLogs] = useState<boolean>(true);
  const [logPaused, setLogPaused] = useState<boolean>(false);
  const [logClearAtUnix, setLogClearAtUnix] = useState<number>(0);
  const [pausedLogs, setPausedLogs] = useState<any[] | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const consoleInputRef = useRef<HTMLInputElement | null>(null);
  const [logScrollTop, setLogScrollTop] = useState<number>(0);
  const [logViewportHeight, setLogViewportHeight] = useState<number>(640);
  const [logNearBottom, setLogNearBottom] = useState<boolean>(true);
  const [newLogsCount, setNewLogsCount] = useState<number>(0);
  const prevLogLinesLenRef = useRef<number>(0);

  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState<number>(0);
  const [gameQueryRaw, setGameQueryRaw] = useState<string>("");
  const [gameQuery, setGameQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "stopped">("all");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [tagsDraft, setTagsDraft] = useState<string>("");
  const [compactActions, setCompactActions] = useState<boolean>(false);

  const socketText = useMemo(() => {
    if (frpStatus?.running && frpStatus.remote_port) {
      return `${frpStatus.remote_addr}:${frpStatus.remote_port}`;
    }
    const ip = localHost || "127.0.0.1";
    return `${ip}:${Math.round(Number(gamePort || 25565))}`;
  }, [frpStatus, localHost, gamePort]);

  useEffect(() => {
    const t = window.setTimeout(() => setGameQuery(gameQueryRaw), 150);
    return () => window.clearTimeout(t);
  }, [gameQueryRaw]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 520px)");
    const onChange = () => setCompactActions(!!mq.matches);
    onChange();
    if (typeof (mq as any).addEventListener === "function") (mq as any).addEventListener("change", onChange);
    else (mq as any).addListener(onChange);
    return () => {
      if (typeof (mq as any).removeEventListener === "function") (mq as any).removeEventListener("change", onChange);
      else (mq as any).removeListener(onChange);
    };
  }, []);

  const runningById = useMemo(() => {
    const list = Array.isArray((selectedDaemon as any)?.heartbeat?.instances) ? (selectedDaemon as any).heartbeat.instances : [];
    const out: Record<string, boolean> = {};
    for (const it of list) {
      const id = String((it as any)?.id || "").trim();
      if (!id) continue;
      out[id] = !!(it as any)?.running;
    }
    return out;
  }, [selectedDaemon]);

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
    const tag = String(tagFilter || "").trim().toLowerCase();
    const q = String(gameQuery || "").trim().toLowerCase();
    const sf = statusFilter;
    return (serverDirs || []).filter((id: string) => {
      const tags = (instanceTagsById && (instanceTagsById as any)[id]) || [];
      const tagList = Array.isArray(tags) ? tags.map((s: any) => String(s || "").trim()).filter(Boolean) : [];

      if (tag) {
        if (!tagList.some((t: string) => t.toLowerCase() === tag)) return false;
      }

      if (sf !== "all") {
        const running = !!runningById[id];
        if (sf === "running" && !running) return false;
        if (sf === "stopped" && running) return false;
      }

      if (q) {
        const hay = [id, ...tagList].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }, [serverDirs, instanceTagsById, tagFilter, gameQuery, statusFilter, runningById]);

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

  const logFilter = useMemo(() => {
    const q = String(logQuery || "").trim();
    if (!q) return { mode: "none" as const, q: "", re: null as RegExp | null, error: "" };
    if (!logRegex) return { mode: "text" as const, q: q.toLowerCase(), re: null as RegExp | null, error: "" };

    const limit = 160;
    if (q.length > limit) return { mode: "regex" as const, q, re: null as RegExp | null, error: `Pattern too long (>${limit})` };
    try {
      return { mode: "regex" as const, q, re: new RegExp(q, "i"), error: "" };
    } catch (e: any) {
      return { mode: "regex" as const, q, re: null as RegExp | null, error: String(e?.message || e) };
    }
  }, [logQuery, logRegex]);

  useEffect(() => {
    setLogClearAtUnix(0);
  }, [instanceId, logView]);

  const filteredLogs = useMemo(() => {
    const inst = instanceId.trim();
    const q = logFilter.q;
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
    if (logFilter.mode === "none") return next;
    if (logFilter.mode === "text") return next.filter((l: any) => String(l?.line || "").toLowerCase().includes(q));

    // Regex: if invalid, keep logs visible and surface error in UI.
    const re = logFilter.re;
    if (!re) return next;
    return next.filter((l: any) => re.test(String(l?.line || "")));
  }, [logs, logView, instanceId, logPaused, pausedLogs, logClearAtUnix, logFilter]);

  const logLines = useMemo<RenderLogLine[]>(() => {
    const list = filteredLogs.length ? filteredLogs.slice(-2000) : [];
    if (!list.length) return [{ text: "<no logs>", level: "" }];
    const baseTs =
      logTimeMode === "relative"
        ? (() => {
            for (const l of list) {
              const ts = Number((l as any)?.ts_unix || 0);
              if (Number.isFinite(ts) && ts > 0) return ts;
            }
            return 0;
          })()
        : 0;
    const mapped: RenderLogLine[] = list.map((l: any) => {
      const tsUnix = Number(l.ts_unix || 0);
      let ts = "--:--:--";
      if (Number.isFinite(tsUnix) && tsUnix > 0) {
        if (logTimeMode === "relative" && baseTs > 0) ts = `+${Math.max(0, Math.floor(tsUnix - baseTs))}s`;
        else ts = fmtTime(tsUnix);
      }
      const src = l.source || "daemon";
      const stream = l.stream || "";
      const inst = l.instance ? `(${l.instance})` : "";
      const text = `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
      const upper = String(text || "").toUpperCase();
      const isErr = /\b(ERROR|FATAL)\b/.test(upper) || upper.includes("EXCEPTION") || upper.includes("STACKTRACE");
      const isWarn = /\bWARN(ING)?\b/.test(upper);
      const level: RenderLogLine["level"] = isErr ? "error" : isWarn ? "warn" : "";
      return { text, level };
    });
    if (logLevelFilter === "warn") {
      const out = mapped.filter((l) => l.level === "warn");
      return out.length ? out : [{ text: "<no logs>", level: "" }];
    }
    if (logLevelFilter === "error") {
      const out = mapped.filter((l) => l.level === "error");
      return out.length ? out : [{ text: "<no logs>", level: "" }];
    }
    return mapped;
  }, [filteredLogs, logLevelFilter, logTimeMode]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll]);

  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const update = () => setLogViewportHeight(Math.max(160, Math.round(el.clientHeight || 640)));
    update();
    const onWin = () => update();
    window.addEventListener("resize", onWin);
    let ro: any = null;
    try {
      if (typeof (window as any).ResizeObserver === "function") {
        ro = new (window as any).ResizeObserver(() => update());
        ro.observe(el);
      }
    } catch {
      ro = null;
    }
    return () => {
      window.removeEventListener("resize", onWin);
      try {
        if (ro && typeof ro.disconnect === "function") ro.disconnect();
      } catch {
        // ignore
      }
    };
  }, [wrapLogs]);

  useEffect(() => {
    if (!autoScroll || !logNearBottom) return;
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLines.length, autoScroll, logNearBottom]);

  useEffect(() => {
    if (logPaused) {
      prevLogLinesLenRef.current = logLines.length;
      setNewLogsCount(0);
      return;
    }
    const prev = prevLogLinesLenRef.current;
    const cur = logLines.length;
    prevLogLinesLenRef.current = cur;

    if (logNearBottom) {
      setNewLogsCount(0);
      return;
    }
    if (cur > prev) {
      setNewLogsCount((n) => n + (cur - prev));
      return;
    }
    if (cur < prev) setNewLogsCount(0);
  }, [logLines.length, logNearBottom, logPaused]);

  const logVirtual = useMemo<{
    start: number;
    end: number;
    topPad: number;
    bottomPad: number;
    visible: RenderLogLine[];
  }>(() => {
    const total = logLines.length;
    if (wrapLogs) {
      return { start: 0, end: total, topPad: 0, bottomPad: 0, visible: logLines };
    }
    const lineHeight = 18;
    const viewHeight = logViewportHeight;
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
  }, [logLines, logScrollTop, wrapLogs, logViewportHeight]);

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

  async function sendQuickCommand(cmd: string) {
    const inst = instanceId.trim();
    const line = String(cmd || "").trim();
    if (!inst || !line) return;
    const next = [...cmdHistory.filter((c) => c !== line), line].slice(-50);
    setCmdHistory(next);
    setCmdHistoryIdx(next.length);
    persistCmdHistory(inst, next);
    await sendConsoleLine(line);
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>{t.tr("Game", "游戏")}</h2>

        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>{t.tr("Game", "游戏")}</label>
              {gamesLoading ? (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="skeleton" style={{ minHeight: 44, borderRadius: 12 }} />
                  <div className="skeleton" style={{ minHeight: 36, borderRadius: 12 }} />
                  <div className="skeleton" style={{ minHeight: 36, borderRadius: 12 }} />
                </div>
              ) : (
                <>
                  <Select
                    value={instanceId}
                    onChange={(v) => setInstanceId(v)}
                    disabled={!serverDirs.length}
                    placeholder={t.tr("No games installed", "暂无游戏实例")}
                    options={filteredServerDirs.map((id: string) => {
                      const tags = (instanceTagsById && (instanceTagsById as any)[id]) || [];
                      const list = Array.isArray(tags) ? tags.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
                      const running = !!runningById[id];
                      const runLabel = running ? t.tr(" (running)", " (运行中)") : "";
                      const label = list.length ? `${id}${runLabel} · ${list.join(", ")}` : `${id}${runLabel}`;
                      return { value: id, label };
                    })}
                  />
                  <div className="row" style={{ marginTop: 8, gap: 10, alignItems: "center" }}>
                    <input
                      value={gameQueryRaw}
                      onChange={(e: any) => setGameQueryRaw(e.target.value)}
                      placeholder={t.tr("Search games…", "搜索游戏…")}
                      style={{ flex: 1, minWidth: 140 }}
                    />
                    <div style={{ width: 170 }}>
                      <Select
                        value={statusFilter}
                        onChange={(v) => setStatusFilter(v as any)}
                        options={[
                          { value: "all", label: t.tr("All statuses", "全部状态") },
                          { value: "running", label: t.tr("Running", "运行中") },
                          { value: "stopped", label: t.tr("Stopped", "已停止") },
                        ]}
                      />
                    </div>
                  </div>
                  <div className="row" style={{ marginTop: 8, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <span className="hint">{t.tr("Tag filter", "标签筛选")}</span>
                    <div style={{ width: 220 }}>
                      <Select
                        value={tagFilter}
                        onChange={(v) => setTagFilter(v)}
                        placeholder={t.tr("All tags", "全部标签")}
                        options={[
                          { value: "", label: t.tr("All tags", "全部标签") },
                          ...availableTags.map((tag) => ({ value: tag, label: tag })),
                        ]}
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div className="hint">
                  {t.tr("installed", "已安装")}: {serverDirs.length} · {t.tr("shown", "显示")}: {filteredServerDirs.length}
                  {serverDirsStatus ? ` · ${serverDirsStatus}` : ""}
                </div>
                <button
                  type="button"
                  className="iconBtn iconOnly"
                  title={t.tr("Refresh games list", "刷新游戏列表")}
                  aria-label={t.tr("Refresh games list", "刷新游戏列表")}
                  onClick={refreshServerDirs}
                  disabled={!selectedDaemon?.connected}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </div>
          </div>

          <div className={`toolbarRight gamesToolbarRight ${compactActions ? "compact" : ""}`}>
            {!compactActions ? (
              <div className="btnGroup">
                <button type="button" className="iconBtn" onClick={openInstallModal} disabled={!selectedDaemon?.connected || gameActionBusy}>
                  <Icon name="plus" />
                  {t.tr("Install", "安装")}
                </button>
              </div>
            ) : null}

            <div className="btnGroup gamesActionGroup">
              <button
                className={running ? "" : "primary"}
                onClick={() => (running ? stopServer() : startServer())}
                disabled={!canControl}
              >
                {gameActionBusy ? t.tr("Working...", "处理中...") : running ? t.tr("Stop", "停止") : t.tr("Start", "启动")}
              </button>
              <Select
                value=""
                onChange={(v) => {
                  if (v === "install") openInstallModal();
                  else if (v === "restart") restartServer();
                  else if (v === "backup") backupServer();
                  else if (v === "restore") openRestoreModal();
                  else if (v === "trash") openTrashModal();
                  else if (v === "export") exportInstanceZip();
                  else if (v === "properties") openServerPropertiesEditor();
                  else if (v === "rename") renameInstance();
                  else if (v === "clone") cloneInstance();
                  else if (v === "settings") openSettingsModal();
                  else if (v === "files") {
                    setFsPath(instanceId.trim());
                    setTab("files");
                  } else if (v === "delete") deleteServer();
                }}
                placeholder={t.tr("More", "更多")}
                options={[
                  ...(compactActions ? [{ value: "install", label: t.tr("Install…", "安装…"), disabled: !selectedDaemon?.connected || gameActionBusy }] : []),
                  { value: "restart", label: t.tr("Restart", "重启"), disabled: !canControl },
                  { value: "backup", label: t.tr("Backup", "备份"), disabled: !canControl },
                  { value: "restore", label: t.tr("Restore…", "恢复…"), disabled: !canControl },
                  { value: "trash", label: t.tr("Trash…", "回收站…"), disabled: !selectedDaemon?.connected },
                  { value: "export", label: t.tr("Export zip", "导出 zip"), disabled: !selectedDaemon?.connected || !instanceId.trim() },
                  { value: "properties", label: "server.properties…", disabled: !canControl },
                  { value: "rename", label: t.tr("Rename…", "重命名…"), disabled: !canControl },
                  { value: "clone", label: t.tr("Clone…", "克隆…"), disabled: !canControl },
                  { value: "settings", label: t.tr("Settings", "设置"), disabled: !canControl },
                  { value: "files", label: t.tr("Files", "文件"), disabled: !canControl },
                  { value: "delete", label: t.tr("Delete", "删除"), disabled: !canControl },
                ]}
                style={compactActions ? { width: "100%" } : { width: 150 }}
                disabled={!selectedDaemon?.connected || gameActionBusy}
              />
              {gameActionBusy ? <span className="badge">{t.tr("busy", "忙碌")}</span> : null}
            </div>
          </div>
        </div>

        {!gamesLoading && !serverDirs.length ? (
          <div className="emptyState" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800 }}>{t.tr("No games installed yet.", "暂无已安装游戏。")}</div>
            <div className="hint" style={{ marginTop: 6 }}>
              {t.tr("Install a Vanilla/Paper server or a modpack to get started.", "安装 Vanilla/Paper 或整合包以开始使用。")}
            </div>
            <div className="btnGroup" style={{ marginTop: 10, justifyContent: "center" }}>
              <button type="button" className="primary iconBtn" onClick={openInstallModal} disabled={!selectedDaemon?.connected || gameActionBusy}>
                <Icon name="plus" />
                {t.tr("Install", "安装")}
              </button>
            </div>
          </div>
        ) : null}

        {frpOpStatus || serverOpStatus ? (
          <div className="hint" style={{ marginTop: 8 }}>
            {frpOpStatus ? <span style={{ marginRight: 10 }}>FRP: {frpOpStatus}</span> : null}
            {serverOpStatus ? <span>MC: {serverOpStatus}</span> : null}
          </div>
        ) : null}

        <div className="grid2">
          <div className="kv">
            <div className="k">{t.tr("Status", "状态")}</div>
            <div className="v">
              {instanceStatus?.running ? (
                <span className="badge ok">
                  {t.tr("running", "运行中")} (pid {instanceStatus.pid || "-"})
                </span>
              ) : (
                <span className="badge">{t.tr("stopped", "已停止")}</span>
              )}
            </div>
            <div className="hint">
              {t.tr("node", "节点")}: {selectedDaemon?.id || "-"}
            </div>
          </div>

          <div className="kv">
            <div className="k">{t.tr("FRP process", "FRP 进程")}</div>
            <div className="v">
              {frpStatus?.running ? <span className="badge ok">{t.tr("running", "运行中")}</span> : <span className="badge">{t.tr("stopped", "已停止")}</span>}
              {frpStatus?.running && frpStatus.remote_port ? (
                <span className="badge">
                  {frpStatus.remote_addr}:{frpStatus.remote_port}
                </span>
              ) : null}
            </div>
            <div className="hint">
              {t.tr("desired", "期望")}:{" "}
              {enableFrp ? (
                selectedProfile ? (
                  <>
                    {t.tr("on", "开启")} (<code>{selectedProfile.name}</code>)
                  </>
                ) : (
                  <span style={{ color: "var(--danger)" }}>{t.tr("on (no profile)", "开启（无配置）")}</span>
                )
              ) : (
                t.tr("off", "关闭")
              )}
              {" · "}
              {t.tr("remote port", "remote port")}: <code>{Math.round(Number(frpRemotePort || 0))}</code>
            </div>
          </div>

          <div className="kv">
            <div className="k">{t.tr("Java", "Java")}</div>
            <div className="v">{instanceStatus?.java ? <code>{String(instanceStatus.java)}</code> : <span className="muted">-</span>}</div>
            <div className="hint">
              {t.tr("major", "major")}: <code>{Number(instanceStatus?.java_major || 0) || "-"}</code>
              {" · "}
              {t.tr("required", "required")}: <code>{Number(instanceStatus?.required_java_major || 0) ? `>=${Number(instanceStatus.required_java_major)}` : "-"}</code>
            </div>
          </div>

          <div className="kv">
            <div className="k">{t.tr("Tags", "标签")}</div>
            <div className="v">
              {currentTags.length ? currentTags.map((tag) => <span key={tag} className="badge">{tag}</span>) : <span className="muted">-</span>}
            </div>
            <div className="hint">
              <div className="row" style={{ gap: 8 }}>
                <input
                  value={tagsDraft}
                  onChange={(e: any) => setTagsDraft(e.target.value)}
                  placeholder={t.tr("e.g. survival, modpack", "例如 survival, modpack")}
                  style={{ flex: 1, minWidth: 180 }}
                  disabled={!instanceId.trim()}
                />
                <button type="button" onClick={saveTags} disabled={!selectedDaemon?.connected || !instanceId.trim()}>
                  {t.tr("Save", "保存")}
                </button>
              </div>
            </div>
          </div>

          <div className="kv">
            <div className="k">{t.tr("Network", "网络")}</div>
            <div className="v">
              {instanceId.trim() ? (
                <span className="badge">{`${localHost || "127.0.0.1"}:${Math.round(Number(gamePort || 25565))}`}</span>
              ) : (
                <span className="muted">-</span>
              )}
            </div>
            <div className="hint">
              {t.tr(
                "Hints: leave server-ip empty · Docker default published range 25565-25600",
                "提示：server-ip 建议留空 · Docker 默认映射端口段 25565-25600"
              )}
            </div>
          </div>

          <div className="kv">
            <div className="k">{t.tr("Last heartbeat", "最后心跳")}</div>
            <div className="v">{fmtUnix(selectedDaemon?.heartbeat?.server_time_unix)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{t.tr("Connect", "连接")}</h2>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <code
            className="clickCopy"
            role="button"
            tabIndex={0}
            title={t.tr("Click to copy", "点击复制")}
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
            {t.tr("Copy", "复制")}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          <span>
            {t.tr("desired", "期望")}:{" "}
            {enableFrp ? (
              selectedProfile ? (
                <>
                  FRP {t.tr("on", "开启")} (<code>{selectedProfile.name}</code>)
                </>
              ) : (
                <span style={{ color: "var(--danger)" }}>FRP {t.tr("on (no profile)", "开启（无配置）")}</span>
              )
            ) : (
              `FRP ${t.tr("off", "关闭")}`
            )}
            {" · "}
            {t.tr("actual", "实际")}: {frpStatus?.running ? t.tr("running", "运行中") : t.tr("stopped", "已停止")}
          </span>
        </div>
        <div className="hint">
          {frpStatus?.running && frpStatus.remote_port ? (
            <span>{t.tr("FRP: public address (copy to friends).", "FRP：公网连接地址（可直接复制给朋友）。")}</span>
          ) : enableFrp ? (
            !selectedProfile ? (
              <span>
                {t.tr("FRP is enabled but no server is selected (go to", "FRP 已开启但未选择服务器（去")}{" "}
                <button className="linkBtn" onClick={() => setTab("frp")}>
                  FRP
                </button>{" "}
                {t.tr("to save a profile).", "保存一个 profile）。")}
              </span>
            ) : selectedProfile.status?.online === false ? (
              <span style={{ color: "var(--danger)" }}>
                {t.tr("FRP server unreachable", "FRP 服务器不可达")}: {selectedProfile.status.error || t.tr("offline", "离线")}（{t.tr("go to FRP tab and click Test/Probe", "去 FRP 页点击 Test/Probe")}）
              </span>
            ) : frpRemotePort <= 0 ? (
              <span>{t.tr("FRP is enabled but Remote Port=0 (server-assigned; consider a fixed port).", "FRP 已开启但 Remote Port=0（由服务端分配端口；建议手动指定一个固定端口）。")}</span>
            ) : frpStatus && frpStatus.running === false ? (
              <span style={{ color: "var(--danger)" }}>
                {t.tr(
                  "FRP desired on, but not running on daemon (see Logs → FRP / check token, server_addr, server_port).",
                  "FRP 期望开启，但 daemon 上未运行（看 Logs → FRP / 检查 token、server_addr、server_port）"
                )}
              </span>
            ) : (
              <span>{t.tr("FRP: after start, a public address will appear.", "FRP：启动后会显示公网地址。")}</span>
            )
          ) : (
            <span>{t.tr("FRP is off: showing local/LAN address (Docker defaults to 25565-25600).", "未开启 FRP：显示本机/LAN 连接地址（Docker 默认映射 25565-25600）。")}</span>
          )}
        </div>
        <div className="hint">
          {t.tr("Minecraft: Multiplayer → Add Server → Address", "Minecraft：多人游戏 → 添加服务器 → 地址填")} <code>{instanceId.trim() ? socketText : "IP:Port"}</code>
        </div>
        {instanceId.trim() && (enableFrp || frpStatus?.running) ? (
          instanceProxies.length ? (
            <div style={{ marginTop: 10 }}>
              <div className="hint">{t.tr("FRP proxies for this instance:", "该实例的 FRP proxies：")}</div>
              <div className="stack" style={{ gap: 8, marginTop: 6 }}>
                {instanceProxies.map((p: any) => (
                  <div key={`${p.proxy_name}-${p.remote_addr}-${p.remote_port}`} className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <span className={`badge ${p.running ? "ok" : ""}`}>{String(p.proxy_name || "-")}</span>
                    <code>
                      {p.remote_addr}:{p.remote_port}
                    </code>
                    <span className="hint">
                      {t.tr("started", "启动")}: {fmtUnix(p.started_unix)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="hint" style={{ marginTop: 8 }}>
              {t.tr("FRP proxies", "FRP proxies")}: -
            </div>
          )
        ) : null}
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Backups", "备份")}</h2>
              <div className="hint">
                {instanceId.trim() ? (
                  <>
                    {t.tr("folder", "目录")}: <code>servers/_backups/{instanceId.trim()}/</code>
                    {typeof backupZipsStatus === "string" && backupZipsStatus ? ` · ${backupZipsStatus}` : ""}
                  </>
                ) : (
                  t.tr("Select a game to view backups", "选择游戏以查看备份")
                )}
              </div>
              {instanceId.trim() ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  {t.tr("size", "大小")}: <code>{instanceUsageBytes == null ? "-" : fmtBytes(instanceUsageBytes)}</code>
                  {instanceUsageStatus ? ` · ${instanceUsageStatus}` : ""}
                  {" · "}
                  {t.tr("last backup", "最近备份")}: {lastBackup.unix ? fmtUnix(lastBackup.unix) : Array.isArray(backupZips) && backupZips.length ? lastBackup.file : "-"}
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
              {t.tr("Refresh", "刷新")}
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => computeInstanceUsage()}
              disabled={!selectedDaemon?.connected || !instanceId.trim() || instanceUsageBusy}
              title={t.tr("Compute instance folder size (may take a while)", "计算实例目录大小（可能需要一段时间）")}
            >
              {instanceUsageBusy ? t.tr("Scanning…", "扫描中…") : t.tr("Compute size", "计算大小")}
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
              {t.tr("Open folder", "打开目录")}
            </button>
          </div>
        </div>

        {instanceId.trim() ? (
          Array.isArray(backupZips) && backupZips.length ? (
            <>
              <div className="hint">
                {t.tr("showing", "显示")} {Math.min(10, backupZips.length)} / {backupZips.length}
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {backupZips.slice(0, 10).map((p: string) => (
                  <div key={p} className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <code style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p}</code>
                    <button type="button" className="iconBtn iconOnly" title={t.tr("Copy path", "复制路径")} aria-label={t.tr("Copy path", "复制路径")} onClick={() => copyText(p)}>
                      <Icon name="copy" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="hint">
              {t.tr("No backups yet. Use More → Backup to create one.", "暂无备份。使用 More → Backup 创建一个备份。")}
            </div>
          )
        ) : (
          <div className="hint">{t.tr("Select a game to see backups.", "选择游戏以查看备份。")}</div>
        )}
      </div>

      <div className="card">
        <h2>{t.tr("Logs", "日志")}</h2>
        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ minWidth: 180 }}>
              <label>{t.tr("View", "视图")}</label>
              <Select
                value={logView}
                onChange={(v) => setLogView(v as any)}
                options={[
                  { value: "all", label: t.tr("All", "全部") },
                  { value: "mc", label: "MC" },
                  { value: "install", label: t.tr("Install", "安装") },
                  { value: "frp", label: "FRP" },
                ]}
              />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>{t.tr("Level", "级别")}</label>
              <Select
                value={logLevelFilter}
                onChange={(v) => setLogLevelFilter(v as any)}
                options={[
                  { value: "all", label: t.tr("All", "全部") },
                  { value: "warn", label: t.tr("Warn", "警告") },
                  { value: "error", label: t.tr("Error", "错误") },
                ]}
              />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>{t.tr("Time", "时间")}</label>
              <Select
                value={logTimeMode}
                onChange={(v) => setLogTimeMode(v as any)}
                options={[
                  { value: "local", label: t.tr("Local", "本地") },
                  { value: "relative", label: t.tr("Relative", "相对") },
                ]}
              />
            </div>
          </div>
          <div className="toolbarRight">
            <input
              value={logQueryRaw}
              onChange={(e: any) => setLogQueryRaw(e.target.value)}
              placeholder={t.tr("Search logs…", "搜索日志…")}
              style={{ width: 220 }}
            />
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={logRegex} onChange={(e) => setLogRegex(e.target.checked)} /> {t.tr("Regex", "正则")}
            </label>
            {logFilter.mode === "regex" && logFilter.error ? (
              <span className="badge" title={logFilter.error}>
                {t.tr("regex error", "正则错误")}
              </span>
            ) : null}
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> {t.tr("Auto-scroll", "自动滚动")}
            </label>
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={wrapLogs} onChange={(e) => setWrapLogs(e.target.checked)} /> {t.tr("Wrap", "换行")}
            </label>
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={highlightLogs} onChange={(e) => setHighlightLogs(e.target.checked)} /> {t.tr("Highlight", "高亮")}
            </label>
            <button type="button" className="iconBtn" onClick={() => setLogPaused((v) => !v)}>
              {logPaused ? t.tr("Resume", "继续") : t.tr("Pause", "暂停")}
            </button>
            {logPaused ? <span className="badge">{t.tr("paused", "已暂停")}</span> : null}
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                setLogClearAtUnix(Math.floor(Date.now() / 1000));
              }}
            >
              {t.tr("Clear view", "清空视图")}
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
              {t.tr("Copy", "复制")}
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
              {t.tr("Download view", "下载视图")}
            </button>
            <button type="button" className="iconBtn" onClick={downloadLatestLog} disabled={!selectedDaemon?.connected || !instanceId.trim()}>
              <Icon name="download" />
              latest.log
            </button>
          </div>
        </div>
        <div className="logScrollWrap">
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
              {logVirtual.visible.map((l, idx) => (
                <span key={`${logVirtual.start + idx}`} className={`logLine ${highlightLogs ? l.level : ""}`}>
                  <button
                    type="button"
                    className="logLineCopyBtn"
                    title={t.tr("Copy line", "复制该行")}
                    aria-label={t.tr("Copy line", "复制该行")}
                    onClick={() => copyText(l.text)}
                  >
                    <Icon name="copy" />
                  </button>
                  <span className="logLineText" style={{ whiteSpace: wrapLogs ? "pre-wrap" : "pre", wordBreak: wrapLogs ? "break-word" : "normal" }}>
                    {logFilter.mode === "text" && logFilter.q ? highlightText(l.text, logFilter.q) : l.text}
                  </span>
                </span>
              ))}
            </pre>
            <div style={{ height: logVirtual.bottomPad }} />
          </div>
          {newLogsCount > 0 && !logNearBottom && !logPaused ? (
            <button
              type="button"
              className="logNewPill"
              onClick={() => {
                const el = logScrollRef.current;
                if (!el) return;
                el.scrollTop = el.scrollHeight;
                setNewLogsCount(0);
                setAutoScroll(true);
              }}
              title={t.tr("Jump to bottom", "跳到底部")}
            >
              {t.tr(`${newLogsCount} new logs`, `${newLogsCount} 条新日志`)}
            </button>
          ) : null}
        </div>
        <div className="hint">{t.tr("Tip: All shows current game + FRP logs.", "提示：All 会显示当前游戏 + FRP 的日志。")}</div>

        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
          <span className="muted">{t.tr("Quick", "快捷")}:</span>
          <button
            type="button"
            className="dangerBtn"
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
            onClick={async () => {
              const ok = await confirmDialog(
                t.tr("Send 'stop' to the server console? The server will shut down.", "向服务端控制台发送 'stop'？服务器将关闭。"),
                { title: t.tr("Stop", "停止"), confirmLabel: t.tr("Stop", "停止"), cancelLabel: t.tr("Cancel", "取消"), danger: true }
              );
              if (!ok) return;
              await sendQuickCommand("stop");
            }}
          >
            {t.tr("Stop", "停止")}
          </button>
          <button type="button" disabled={!selectedDaemon?.connected || !instanceId.trim()} onClick={() => sendQuickCommand("save-all")}>
            save-all
          </button>
          <button
            type="button"
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
            onClick={() => {
              setConsoleLine("say ");
              window.setTimeout(() => consoleInputRef.current?.focus(), 0);
            }}
          >
            say…
          </button>
          <button type="button" disabled={!selectedDaemon?.connected || !instanceId.trim()} onClick={() => sendQuickCommand("whitelist reload")}>
            whitelist reload
          </button>
          <button
            type="button"
            className="dangerBtn"
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
            onClick={async () => {
              const ok = await confirmDialog(
                t.tr(
                  "Send 'reload' to the server console? This is risky on many servers/plugins.",
                  "向服务端控制台发送 'reload'？这在很多服务端/插件上都有风险。"
                ),
                { title: "reload", confirmLabel: "reload", cancelLabel: t.tr("Cancel", "取消"), danger: true }
              );
              if (!ok) return;
              await sendQuickCommand("reload");
            }}
          >
            reload
          </button>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <input
            ref={consoleInputRef}
            value={consoleLine}
            onChange={(e) => setConsoleLine(e.target.value)}
            placeholder={t.tr("Console command (e.g. say hi)", "控制台命令（例如 say hi）")}
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
            {t.tr("Send", "发送")}
          </button>
        </div>
      </div>
    </div>
  );
}
