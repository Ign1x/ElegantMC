"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";
import DangerZone from "../ui/DangerZone";
import Sparkline from "../ui/Sparkline";

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

function parseTpsFromLines(lines: string[]) {
  let tps: [number, number, number] | null = null;
  let mspt: number | null = null;
  const toNum = (s: string) => {
    const n = Number.parseFloat(String(s || "").trim());
    return Number.isFinite(n) ? n : null;
  };

  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || "");
    const m =
      line.match(/TPS\s+from\s+last[^:]*:\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i) ||
      line.match(/\bTPS\b[^0-9]*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
    if (m) {
      const a = toNum(m[1] || "");
      const b = toNum(m[2] || "");
      const c = toNum(m[3] || "");
      if (a != null && b != null && c != null) tps = [a, b, c];
    }
    const mm = line.match(/\b(?:Tick Time|MSPT)\b[^0-9]*([0-9.]+)\s*ms/i);
    if (mm) {
      const n = toNum(mm[1] || "");
      if (n != null) mspt = n;
    }
  }

  if (!tps) return null;
  return { tps1: tps[0], tps5: tps[1], tps15: tps[2], mspt };
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
    favoriteInstanceIds,
    toggleFavoriteInstance,
    instanceNotesById,
    updateInstanceNote,
    instanceMetaById,
    selectedDaemon,
    openSettingsModal,
    openJarUpdateModal,
    openInstallModal,
    startServer,
    startServerFromSavedConfig,
    stopServer,
    restartServer,
    deleteServer,
    backupServer,
    openTrashModal,
    openDatapackModal,
    openResourcePackModal,
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
    joinRelPath,
    logView,
    setLogView,
    logs,
    logsLoadedOnce,
    consoleLine,
    setConsoleLine,
    sendConsoleLine,
    downloadLatestLog,
    setFsPath,
    openFileByPath,
    fsReadText,
    fsWriteText,
    instanceUsageBytes,
    instanceUsageStatus,
    instanceUsageBusy,
    computeInstanceUsage,
    instanceMetricsHistory,
    instanceMetricsStatus,
    restoreBackupNow,
    startFrpProxyNow,
    repairInstance,
    updateModrinthPack,
  } = useAppCtx();

  const running = !!instanceStatus?.running;
  const canControl = !!selectedDaemon?.connected && !!instanceId.trim() && !gameActionBusy;
  const gamesLoading = serverDirsStatus === t.tr("Loading...", "加载中...") && !serverDirs.length;
  const logsLoading = !logsLoadedOnce && !!selectedDaemon?.connected;

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
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [compactActions, setCompactActions] = useState<boolean>(false);

  const [cmdOutputs, setCmdOutputs] = useState<
    { id: string; cmd: string; startedUnix: number; lines: string[] }[]
  >([]);
  const [cmdCapture, setCmdCapture] = useState<{
    id: string;
    inst: string;
    cmd: string;
    startedUnix: number;
    nextLogIdx: number;
  } | null>(null);
  const cmdCaptureLinesRef = useRef<string[]>([]);
  const [cmdCaptureLines, setCmdCaptureLines] = useState<string[]>([]);

  const [accessTab, setAccessTab] = useState<"players" | "whitelist" | "ops">("players");

  const [playersStatus, setPlayersStatus] = useState<string>("");
  const [playersBusy, setPlayersBusy] = useState<boolean>(false);
  const [players, setPlayers] = useState<{ name: string; uuid: string; expiresOn: string }[]>([]);
  const [playersQueryRaw, setPlayersQueryRaw] = useState<string>("");
  const [playersQuery, setPlayersQuery] = useState<string>("");

  const [whitelistStatus, setWhitelistStatus] = useState<string>("");
  const [whitelistBusy, setWhitelistBusy] = useState<boolean>(false);
  const [whitelistDirty, setWhitelistDirty] = useState<boolean>(false);
  const [whitelistEntries, setWhitelistEntries] = useState<{ name: string; uuid: string }[]>([]);
  const [wlAddName, setWlAddName] = useState<string>("");
  const [wlAddUuid, setWlAddUuid] = useState<string>("");
  const [wlErr, setWlErr] = useState<string>("");

  const [opsStatus, setOpsStatus] = useState<string>("");
  const [opsBusy, setOpsBusy] = useState<boolean>(false);
  const [opsDirty, setOpsDirty] = useState<boolean>(false);
  const [opsEntries, setOpsEntries] = useState<{ name: string; uuid: string; level: number; bypassesPlayerLimit: boolean }[]>([]);
  const [opAddName, setOpAddName] = useState<string>("");
  const [opAddUuid, setOpAddUuid] = useState<string>("");
  const [opAddLevel, setOpAddLevel] = useState<number>(4);
  const [opAddBypass, setOpAddBypass] = useState<boolean>(true);
  const [opErr, setOpErr] = useState<string>("");

  const [packManifest, setPackManifest] = useState<any | null>(null);
  const [packManifestStatus, setPackManifestStatus] = useState<string>("");

  const [backupMetaByPath, setBackupMetaByPath] = useState<Record<string, any>>({});
  const [dangerRestorePath, setDangerRestorePath] = useState<string>("");
  const [backupNewOpen, setBackupNewOpen] = useState<boolean>(false);
  const [backupNewFormat, setBackupNewFormat] = useState<"zip" | "tar.gz">("tar.gz");
  const [backupNewStop, setBackupNewStop] = useState<boolean>(true);
  const [backupNewKeepLast, setBackupNewKeepLast] = useState<number>(0);
  const [backupNewComment, setBackupNewComment] = useState<string>("");

  const [tpsInfo, setTpsInfo] = useState<{
    atUnix: number;
    tps1: number | null;
    tps5: number | null;
    tps15: number | null;
    mspt: number | null;
  } | null>(null);
  const [tpsStatus, setTpsStatus] = useState<string>("");
  const lastTpsParsedIdRef = useRef<string>("");

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
    const t = window.setTimeout(() => setPlayersQuery(playersQueryRaw), 150);
    return () => window.clearTimeout(t);
  }, [playersQueryRaw]);

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

  const favoriteSet = useMemo(() => {
    const set = new Set<string>();
    const list = Array.isArray(favoriteInstanceIds) ? favoriteInstanceIds : [];
    for (const id of list) {
      const s = String(id || "").trim();
      if (s) set.add(s);
    }
    return set;
  }, [favoriteInstanceIds]);

  const currentTags = useMemo(() => {
    const inst = String(instanceId || "").trim();
    if (!inst) return [] as string[];
    const list = (instanceTagsById && (instanceTagsById as any)[inst]) || [];
    return Array.isArray(list) ? list.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
  }, [instanceId, instanceTagsById]);

  const currentNote = useMemo(() => {
    const inst = String(instanceId || "").trim();
    if (!inst) return "";
    return String((instanceNotesById && (instanceNotesById as any)[inst]) || "");
  }, [instanceId, instanceNotesById]);

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

  useEffect(() => {
    setNoteDraft(currentNote);
  }, [instanceId, currentNote]);

  function saveTags() {
    const inst = instanceId.trim();
    if (!inst) return;
    const tags = String(tagsDraft || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateInstanceTags(inst, tags);
  }

  function saveNote() {
    const inst = instanceId.trim();
    if (!inst) return;
    updateInstanceNote(inst, noteDraft);
  }

  const sortedServerDirs = useMemo(() => {
    const list = (filteredServerDirs || []).slice();
    list.sort((a: string, b: string) => {
      const af = favoriteSet.has(a) ? 1 : 0;
      const bf = favoriteSet.has(b) ? 1 : 0;
      if (af !== bf) return bf - af;
      return a.localeCompare(b);
    });
    return list;
  }, [filteredServerDirs, favoriteSet]);

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

  const perf = useMemo(() => {
    const hist = Array.isArray(instanceMetricsHistory) ? instanceMetricsHistory : [];
    const memTotalBytes = Math.floor(Number(selectedDaemon?.heartbeat?.mem?.total_bytes || 0));
    const cpuValues = hist.map((p: any) => (typeof p?.cpu_percent === "number" ? p.cpu_percent : null));
    const memPctValues = hist.map((p: any) => {
      if (memTotalBytes <= 0) return null;
      const rss = typeof p?.mem_rss_bytes === "number" ? p.mem_rss_bytes : null;
      if (rss == null) return null;
      const pct = (Number(rss) * 100) / memTotalBytes;
      return Number.isFinite(pct) ? pct : null;
    });
    const last = hist.length ? hist[hist.length - 1] : null;
    const cpuLatest = typeof (last as any)?.cpu_percent === "number" ? (last as any).cpu_percent : null;
    const memLatestBytes = typeof (last as any)?.mem_rss_bytes === "number" ? (last as any).mem_rss_bytes : null;
    const memLatestPct =
      memTotalBytes > 0 && typeof memLatestBytes === "number" ? (Number(memLatestBytes) * 100) / memTotalBytes : null;
    return { hist, memTotalBytes, cpuValues, memPctValues, cpuLatest, memLatestBytes, memLatestPct };
  }, [instanceMetricsHistory, selectedDaemon]);

  const lastBackup = useMemo(() => {
    const list = Array.isArray(backupZips) ? backupZips : [];
    if (!list.length) return { unix: null as number | null, file: "" };
    const p = String(list[0] || "");
    const file = p.split("/").pop() || p;
    const meta = backupMetaByPath[p];
    const metaUnix = Math.floor(Number(meta?.created_at_unix || 0));
    if (Number.isFinite(metaUnix) && metaUnix > 0) return { unix: metaUnix, file };
    const m = file.match(/-(\d{9,12})\.(?:zip|tar\.gz|tgz)$/i);
    const unix = m ? Number(m[1]) : null;
    return { unix: Number.isFinite(Number(unix)) ? Number(unix) : null, file };
  }, [backupZips, backupMetaByPath]);

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
      if (logView === "frp") {
        if (l.source !== "frp") return false;
        const name = String(l.instance || "").trim();
        if (!inst) return true;
        if (!name) return true;
        return name === inst || name.startsWith(`${inst}-`);
      }
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

  const logRangeLabel = useMemo(() => {
    const total = logLines.length;
    if (!total) return "";
    const start = Math.max(0, logVirtual.start);
    const end = Math.max(start, Math.min(total, logVirtual.end));
    return `${Math.min(total, start + 1)}-${end} / ${total}`;
  }, [logLines.length, logVirtual.end, logVirtual.start]);

  useEffect(() => {
    if (!selectedDaemon?.connected) return;
    const inst = instanceId.trim();
    if (!inst) return;
    refreshBackupZips(inst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, selectedDaemon?.connected]);

  useEffect(() => {
    setDangerRestorePath("");
  }, [instanceId]);

  useEffect(() => {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) {
      setDangerRestorePath("");
      return;
    }
    if (dangerRestorePath) return;
    const first = Array.isArray(backupZips) && backupZips.length ? String(backupZips[0] || "") : "";
    if (first) setDangerRestorePath(first);
  }, [instanceId, selectedDaemon?.connected, backupZips, dangerRestorePath]);

  useEffect(() => {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) {
      setBackupMetaByPath({});
      return;
    }
    const list = (Array.isArray(backupZips) ? backupZips : []).slice(0, 25);
    let cancelled = false;
    async function load() {
      const next: Record<string, any> = {};
      for (const p of list) {
        const path = String(p || "").trim();
        if (!path) continue;
        try {
          const raw = await fsReadText(`${path}.meta.json`, 8_000);
          const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) next[path] = parsed;
        } catch {
          // ignore missing meta
        }
      }
      if (!cancelled) setBackupMetaByPath(next);
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupZips, instanceId, selectedDaemon?.connected]);

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
    beginCmdCapture(cmd);
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
    beginCmdCapture(line);
    await sendConsoleLine(line);
  }

  function normalizeUuid(raw: string) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const hex = s.replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) return "";
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isValidMcName(raw: string) {
    const name = String(raw || "").trim();
    return /^[A-Za-z0-9_]{1,16}$/.test(name);
  }

  function beginCmdCapture(cmd: string) {
    const inst = instanceId.trim();
    if (!inst) return;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cmdCaptureLinesRef.current = [];
    setCmdCaptureLines([]);
    setCmdCapture({
      id,
      inst,
      cmd,
      startedUnix: Math.floor(Date.now() / 1000),
      nextLogIdx: Array.isArray(logs) ? logs.length : 0,
    });
  }

  useEffect(() => {
    if (!cmdCapture) return;
    const all = Array.isArray(logs) ? logs : [];
    let idx = Math.max(0, Math.min(all.length, Math.floor(Number(cmdCapture.nextLogIdx || 0))));
    if (idx >= all.length) return;
    const slice = all.slice(idx);
    const nextIdx = idx + slice.length;

    const lines: string[] = [];
    for (const l of slice) {
      if (l?.source !== "mc") continue;
      if (String(l?.instance || "").trim() !== cmdCapture.inst) continue;
      const tsUnix = Math.floor(Number(l?.ts_unix || 0));
      const ts = tsUnix > 0 ? fmtTime(tsUnix) : "-";
      const stream = String(l?.stream || "").trim();
      const body = String(l?.line || "");
      lines.push(`[${ts}]${stream ? ` ${stream}:` : ""} ${body}`);
    }
    if (lines.length) {
      cmdCaptureLinesRef.current = [...cmdCaptureLinesRef.current, ...lines].slice(-120);
      setCmdCaptureLines(cmdCaptureLinesRef.current);
    }

    setCmdCapture((prev) => (prev && prev.id === cmdCapture.id ? { ...prev, nextLogIdx: nextIdx } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.length, cmdCapture?.id]);

  useEffect(() => {
    if (!cmdCapture) return;
    const id = cmdCapture.id;
    const cmd = cmdCapture.cmd;
    const startedUnix = cmdCapture.startedUnix;
    const tmr = window.setTimeout(() => {
      const lines = cmdCaptureLinesRef.current.slice();
      setCmdOutputs((prev) => [{ id, cmd, startedUnix, lines }, ...prev].slice(0, 12));
      setCmdCapture(null);
      setCmdCaptureLines([]);
      cmdCaptureLinesRef.current = [];
    }, 2800);
    return () => window.clearTimeout(tmr);
  }, [cmdCapture?.id]);

  useEffect(() => {
    const latest = cmdOutputs[0];
    if (!latest) return;
    if (latest.id === lastTpsParsedIdRef.current) return;
    const cmd = String(latest.cmd || "").trim().toLowerCase();
    if (cmd !== "tps" && cmd !== "minecraft:tps") return;
    lastTpsParsedIdRef.current = latest.id;

    const parsed = parseTpsFromLines(latest.lines || []);
    if (!parsed) {
      setTpsInfo(null);
      setTpsStatus(t.tr("No TPS output captured (is this a Paper/Spigot server?)", "未捕获到 TPS 输出（是否为 Paper/Spigot 服务端？）"));
      return;
    }
    setTpsInfo({ atUnix: latest.startedUnix, ...parsed });
    setTpsStatus("");
  }, [cmdOutputs, t]);

  function isNotFoundErr(e: any) {
    const m = String(e?.message || e || "");
    return /not found|no such file|enoent/i.test(m);
  }

  useEffect(() => {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) {
      setPackManifest(null);
      setPackManifestStatus("");
      return;
    }
    let cancelled = false;
    async function load() {
      setPackManifestStatus(t.tr("Loading...", "加载中..."));
      try {
        const raw = await fsReadText(joinRelPath(inst, ".elegantmc_pack.json"), 10_000);
        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
        if (cancelled) return;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setPackManifest(null);
          setPackManifestStatus("");
          return;
        }
        setPackManifest(parsed);
        setPackManifestStatus("");
      } catch (e: any) {
        if (cancelled) return;
        if (isNotFoundErr(e)) {
          setPackManifest(null);
          setPackManifestStatus("");
        } else {
          setPackManifest(null);
          setPackManifestStatus(String(e?.message || e));
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, selectedDaemon?.connected]);

  async function refreshPlayers() {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) return;
    setPlayersBusy(true);
    setPlayersStatus(t.tr("Loading...", "加载中..."));
    try {
      const raw = await fsReadText(joinRelPath(inst, "usercache.json"), 10_000);
      const parsed = raw && raw.trim() ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed : [];
      const cleaned = list
        .map((it: any) => ({
          name: String(it?.name || "").trim(),
          uuid: normalizeUuid(String(it?.uuid || "")),
          expiresOn: String(it?.expiresOn || "").trim(),
        }))
        .filter((p: any) => p.name || p.uuid);
      cleaned.sort((a: any, b: any) => a.name.localeCompare(b.name));
      setPlayers(cleaned);
      setPlayersStatus(cleaned.length ? "" : t.tr("No players in usercache.json yet", "usercache.json 暂无玩家"));
    } catch (e: any) {
      setPlayers([]);
      if (isNotFoundErr(e)) setPlayersStatus(t.tr("usercache.json not found (server may not have started yet)", "未找到 usercache.json（可能尚未启动过）"));
      else setPlayersStatus(String(e?.message || e));
    } finally {
      setPlayersBusy(false);
    }
  }

  async function refreshWhitelist() {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) return;
    setWhitelistBusy(true);
    setWlErr("");
    setWhitelistStatus(t.tr("Loading...", "加载中..."));
    try {
      const raw = await fsReadText(joinRelPath(inst, "whitelist.json"), 10_000);
      const parsed = raw && raw.trim() ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed : [];
      const cleaned = list
        .map((it: any) => ({
          name: String(it?.name || "").trim(),
          uuid: normalizeUuid(String(it?.uuid || "")),
        }))
        .filter((p: any) => p.name || p.uuid);
      cleaned.sort((a: any, b: any) => a.name.localeCompare(b.name));
      setWhitelistEntries(cleaned);
      setWhitelistDirty(false);
      setWhitelistStatus("");
    } catch (e: any) {
      setWhitelistEntries([]);
      setWhitelistDirty(false);
      if (isNotFoundErr(e)) setWhitelistStatus(t.tr("whitelist.json not found (will create on save)", "未找到 whitelist.json（保存时将创建）"));
      else setWhitelistStatus(String(e?.message || e));
    } finally {
      setWhitelistBusy(false);
    }
  }

  async function saveWhitelist() {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected || whitelistBusy) return;
    setWhitelistBusy(true);
    setWlErr("");
    setWhitelistStatus(t.tr("Saving...", "保存中..."));
    try {
      const payload = (whitelistEntries || [])
        .map((it) => ({ name: String(it?.name || "").trim(), uuid: normalizeUuid(String(it?.uuid || "")) }))
        .filter((p) => p.name || p.uuid);
      await fsWriteText(joinRelPath(inst, "whitelist.json"), JSON.stringify(payload, null, 2) + "\n", 10_000);
      setWhitelistDirty(false);
      setWhitelistStatus(t.tr("Saved", "已保存"));
      setTimeout(() => setWhitelistStatus(""), 900);
    } catch (e: any) {
      setWhitelistStatus(String(e?.message || e));
    } finally {
      setWhitelistBusy(false);
    }
  }

  function addWhitelistEntry() {
    setWlErr("");
    const name = String(wlAddName || "").trim();
    const uuid = normalizeUuid(wlAddUuid);
    if (!name && !uuid) {
      setWlErr(t.tr("name or uuid required", "name 或 uuid 必填"));
      return;
    }
    if (name && !isValidMcName(name)) {
      setWlErr(t.tr("invalid name (1-16, A-Z a-z 0-9 _)", "name 无效（1-16 位，仅 A-Z a-z 0-9 _）"));
      return;
    }
    if (wlAddUuid.trim() && !uuid) {
      setWlErr(t.tr("invalid uuid", "uuid 无效"));
      return;
    }
    const nameKey = name.toLowerCase();
    const uuidKey = uuid.toLowerCase();
    const dup = (whitelistEntries || []).some((e) => (uuidKey && String(e.uuid || "").toLowerCase() === uuidKey) || (nameKey && String(e.name || "").toLowerCase() === nameKey));
    if (dup) {
      setWlErr(t.tr("duplicate entry", "重复条目"));
      return;
    }
    setWhitelistEntries((prev) => [...(prev || []), { name, uuid }].sort((a, b) => a.name.localeCompare(b.name)));
    setWhitelistDirty(true);
    setWlAddName("");
    setWlAddUuid("");
  }

  async function refreshOps() {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected) return;
    setOpsBusy(true);
    setOpErr("");
    setOpsStatus(t.tr("Loading...", "加载中..."));
    try {
      const raw = await fsReadText(joinRelPath(inst, "ops.json"), 10_000);
      const parsed = raw && raw.trim() ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed : [];
      const cleaned = list
        .map((it: any) => {
          const name = String(it?.name || "").trim();
          const uuid = normalizeUuid(String(it?.uuid || ""));
          const levelRaw = Math.round(Number(it?.level ?? 0));
          const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(4, levelRaw)) : 4;
          const bypass = typeof it?.bypassesPlayerLimit === "boolean" ? !!it.bypassesPlayerLimit : true;
          return { name, uuid, level, bypassesPlayerLimit: bypass };
        })
        .filter((p: any) => p.name || p.uuid);
      cleaned.sort((a: any, b: any) => a.name.localeCompare(b.name));
      setOpsEntries(cleaned);
      setOpsDirty(false);
      setOpsStatus("");
    } catch (e: any) {
      setOpsEntries([]);
      setOpsDirty(false);
      if (isNotFoundErr(e)) setOpsStatus(t.tr("ops.json not found (will create on save)", "未找到 ops.json（保存时将创建）"));
      else setOpsStatus(String(e?.message || e));
    } finally {
      setOpsBusy(false);
    }
  }

  async function saveOps() {
    const inst = instanceId.trim();
    if (!inst || !selectedDaemon?.connected || opsBusy) return;
    setOpsBusy(true);
    setOpErr("");
    setOpsStatus(t.tr("Saving...", "保存中..."));
    try {
      const payload = (opsEntries || [])
        .map((it) => {
          const name = String(it?.name || "").trim();
          const uuid = normalizeUuid(String(it?.uuid || ""));
          const levelRaw = Math.round(Number(it?.level ?? 4));
          const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(4, levelRaw)) : 4;
          const bypass = typeof it?.bypassesPlayerLimit === "boolean" ? !!it.bypassesPlayerLimit : true;
          return { name, uuid, level, bypassesPlayerLimit: bypass };
        })
        .filter((p) => p.name || p.uuid);
      await fsWriteText(joinRelPath(inst, "ops.json"), JSON.stringify(payload, null, 2) + "\n", 10_000);
      setOpsDirty(false);
      setOpsStatus(t.tr("Saved", "已保存"));
      setTimeout(() => setOpsStatus(""), 900);
    } catch (e: any) {
      setOpsStatus(String(e?.message || e));
    } finally {
      setOpsBusy(false);
    }
  }

  function addOpEntry() {
    setOpErr("");
    const name = String(opAddName || "").trim();
    const uuid = normalizeUuid(opAddUuid);
    const level = Math.max(1, Math.min(4, Math.round(Number(opAddLevel) || 4)));
    const bypass = !!opAddBypass;
    if (!name && !uuid) {
      setOpErr(t.tr("name or uuid required", "name 或 uuid 必填"));
      return;
    }
    if (name && !isValidMcName(name)) {
      setOpErr(t.tr("invalid name (1-16, A-Z a-z 0-9 _)", "name 无效（1-16 位，仅 A-Z a-z 0-9 _）"));
      return;
    }
    if (opAddUuid.trim() && !uuid) {
      setOpErr(t.tr("invalid uuid", "uuid 无效"));
      return;
    }
    const nameKey = name.toLowerCase();
    const uuidKey = uuid.toLowerCase();
    const dup = (opsEntries || []).some((e) => (uuidKey && String(e.uuid || "").toLowerCase() === uuidKey) || (nameKey && String(e.name || "").toLowerCase() === nameKey));
    if (dup) {
      setOpErr(t.tr("duplicate entry", "重复条目"));
      return;
    }
    setOpsEntries((prev) => [...(prev || []), { name, uuid, level, bypassesPlayerLimit: bypass }].sort((a, b) => a.name.localeCompare(b.name)));
    setOpsDirty(true);
    setOpAddName("");
    setOpAddUuid("");
  }

  useEffect(() => {
    const inst = instanceId.trim();
    if (!inst) {
      setPlayers([]);
      setPlayersStatus("");
      setPlayersQueryRaw("");
      setWhitelistEntries([]);
      setWhitelistStatus("");
      setWhitelistDirty(false);
      setOpsEntries([]);
      setOpsStatus("");
      setOpsDirty(false);
      return;
    }
    if (!selectedDaemon?.connected) return;
    if (accessTab === "players") refreshPlayers();
    if (accessTab === "whitelist") refreshWhitelist();
    if (accessTab === "ops") refreshOps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessTab, instanceId, selectedDaemon?.connected]);

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
                    options={sortedServerDirs.map((id: string) => {
                      const tags = (instanceTagsById && (instanceTagsById as any)[id]) || [];
                      const list = Array.isArray(tags) ? tags.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
                      const running = !!runningById[id];
                      const runLabel = running ? t.tr(" (running)", " (运行中)") : "";
                      const fav = favoriteSet.has(id) ? "★ " : "";
                      const label = list.length ? `${fav}${id}${runLabel} · ${list.join(", ")}` : `${fav}${id}${runLabel}`;
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
          </div>
        </div>

        <div className={`gamesStickyBar ${compactActions ? "compact" : ""}`}>
          <div className="gamesStickyLeft">
            <span className="muted">{t.tr("Instance", "实例")}</span>
            <span className="gamesStickyTitle">{instanceId.trim() || "-"}</span>
            <span className={`badge ${running ? "ok" : ""}`}>{running ? t.tr("running", "运行中") : t.tr("stopped", "已停止")}</span>
          </div>

          <div className="btnGroup gamesActionGroup">
            <button className={running ? "" : "primary"} onClick={() => (running ? stopServer() : startServer())} disabled={!canControl}>
              {gameActionBusy ? t.tr("Working...", "处理中...") : running ? t.tr("Stop", "停止") : t.tr("Start", "启动")}
            </button>
            <button
              type="button"
              className="iconBtn iconOnly"
              title={favoriteSet.has(instanceId.trim()) ? t.tr("Unfavorite", "取消收藏") : t.tr("Favorite", "收藏")}
              aria-label={favoriteSet.has(instanceId.trim()) ? t.tr("Unfavorite", "取消收藏") : t.tr("Favorite", "收藏")}
              onClick={() => toggleFavoriteInstance(instanceId.trim())}
              disabled={!instanceId.trim()}
            >
              {favoriteSet.has(instanceId.trim()) ? "★" : "☆"}
            </button>
            <Select
              value=""
              onChange={(v) => {
                if (v === "install") openInstallModal();
                else if (v === "restart") restartServer();
                else if (v === "backup") backupServer();
                else if (v === "datapack") openDatapackModal();
                else if (v === "resourcepack") openResourcePackModal();
                else if (v === "trash") openTrashModal();
                else if (v === "export") exportInstanceZip();
                else if (v === "properties") openServerPropertiesEditor();
                else if (v === "rename") renameInstance();
                else if (v === "clone") cloneInstance();
                else if (v === "repair") repairInstance();
                else if (v === "settings") openSettingsModal();
                else if (v === "files") {
                  setFsPath(instanceId.trim());
                  setTab("files");
                }
              }}
              placeholder={t.tr("More", "更多")}
              options={[
                ...(compactActions ? [{ value: "install", label: t.tr("Install…", "安装…"), disabled: !selectedDaemon?.connected || gameActionBusy }] : []),
                { value: "restart", label: t.tr("Restart", "重启"), disabled: !canControl },
                { value: "backup", label: t.tr("Backup", "备份"), disabled: !canControl },
                { value: "datapack", label: t.tr("Datapack…", "Datapack…"), disabled: !canControl },
                { value: "resourcepack", label: t.tr("Resource pack…", "资源包…"), disabled: !canControl },
                { value: "repair", label: t.tr("Repair…", "修复…"), disabled: !canControl },
                { value: "trash", label: t.tr("Trash…", "回收站…"), disabled: !selectedDaemon?.connected },
                { value: "export", label: t.tr("Export zip", "导出 zip"), disabled: !selectedDaemon?.connected || !instanceId.trim() },
                { value: "properties", label: "server.properties…", disabled: !canControl },
                { value: "rename", label: t.tr("Rename…", "重命名…"), disabled: !canControl },
                { value: "clone", label: t.tr("Clone…", "克隆…"), disabled: !canControl },
                { value: "settings", label: t.tr("Settings", "设置"), disabled: !canControl },
                { value: "files", label: t.tr("Files", "文件"), disabled: !canControl },
              ]}
              style={compactActions ? { width: "100%" } : { width: 150 }}
              disabled={!selectedDaemon?.connected || gameActionBusy}
            />
            {gameActionBusy ? <span className="badge">{t.tr("busy", "忙碌")}</span> : null}
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

        {!gamesLoading && serverDirs.length ? (
          <div style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{t.tr("Instances", "实例")}</h3>
              <span className="muted">
                {t.tr("shown", "显示")}: {sortedServerDirs.length}
              </span>
            </div>
            <div className="cardGrid">
              {sortedServerDirs.map((id: string) => {
                const tags = (instanceTagsById && (instanceTagsById as any)[id]) || [];
                const tagList = Array.isArray(tags) ? tags.map((s: any) => String(s || "").trim()).filter(Boolean) : [];
                const note = String((instanceNotesById && (instanceNotesById as any)[id]) || "").trim();
                const noteOneLine = note ? note.split(/\r?\n/)[0].slice(0, 120) : "";
                const meta = (instanceMetaById && (instanceMetaById as any)[id]) || null;
                const kindKey = String(meta?.server_kind || "").trim().toLowerCase();
                const kind = kindKey ? `${kindKey.slice(0, 1).toUpperCase()}${kindKey.slice(1)}` : "";
                const ver = String(meta?.server_version || "").trim();
                const kindVer = [kind, ver].filter(Boolean).join(" ");
                const portRaw = meta?.game_port != null ? Math.round(Number(meta.game_port)) : 0;
                const port = Number.isFinite(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 0;
                const running = !!runningById[id];
                const isActive = id === instanceId;
                return (
                  <div
                    key={id}
                    className="itemCard"
                    style={{ opacity: running ? 1 : 0.9, borderColor: isActive ? "var(--ok-border)" : undefined }}
                    role="button"
                    tabIndex={0}
                    onClick={() => setInstanceId(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setInstanceId(id);
                      }
                    }}
                  >
                    <div className="itemCardHeader">
                      <div style={{ minWidth: 0 }}>
                        <div className="itemTitle" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</span>
                          {favoriteSet.has(id) ? <span className="badge">★</span> : null}
                        </div>
                        {kindVer || port ? (
                          <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
                            {kindVer ? <span className="badge">{kindVer}</span> : null}
                            {port ? <span className="badge">:{port}</span> : null}
                          </div>
                        ) : null}
                        <div className="itemMeta">
                          {tagList.length ? (
                            <span>
                              {t.tr("tags", "标签")}: {tagList.join(", ")}
                            </span>
                          ) : (
                            <span className="muted">{t.tr("no tags", "无标签")}</span>
                          )}
                          {noteOneLine ? <span> · {noteOneLine}</span> : null}
                        </div>
                      </div>
                      <span className={`badge ${running ? "ok" : ""}`}>{running ? t.tr("running", "运行中") : t.tr("stopped", "已停止")}</span>
                    </div>

                    <div className="itemFooter">
                      <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                        <button
                          type="button"
                          className={running ? "" : "primary"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (running) stopServer(id);
                            else startServerFromSavedConfig(id);
                          }}
                          disabled={!selectedDaemon?.connected || gameActionBusy}
                        >
                          {running ? t.tr("Stop", "停止") : t.tr("Start", "启动")}
                        </button>
                        <button
                          type="button"
                          className="iconBtn iconOnly"
                          title={favoriteSet.has(id) ? t.tr("Unfavorite", "取消收藏") : t.tr("Favorite", "收藏")}
                          aria-label={favoriteSet.has(id) ? t.tr("Unfavorite", "取消收藏") : t.tr("Favorite", "收藏")}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavoriteInstance(id);
                          }}
                          disabled={!id.trim()}
                        >
                          {favoriteSet.has(id) ? "★" : "☆"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFsPath(id);
                            setTab("files");
                          }}
                          disabled={!selectedDaemon?.connected}
                        >
                          {t.tr("Files", "文件")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
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
            <div className="k">{t.tr("Last exit", "最后退出")}</div>
            <div className="v">
              {typeof instanceStatus?.last_exit_unix === "number" && instanceStatus.last_exit_unix > 0 ? (
                <span className={instanceStatus?.last_exit_signal || (typeof instanceStatus?.last_exit_code === "number" && instanceStatus.last_exit_code !== 0) ? "badge warn" : "badge"}>
                  {fmtUnix(instanceStatus.last_exit_unix)}
                </span>
              ) : (
                <span className="muted">-</span>
              )}
            </div>
            <div className="hint">
              {instanceStatus?.last_exit_signal ? (
                <>
                  {t.tr("signal", "信号")}: <code>{String(instanceStatus.last_exit_signal)}</code>
                </>
              ) : typeof instanceStatus?.last_exit_code === "number" ? (
                <>
                  {t.tr("exit code", "退出码")}: <code>{String(instanceStatus.last_exit_code)}</code>
                </>
              ) : (
                <span className="muted">-</span>
              )}
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
            <div className="k">{t.tr("Pack", "整合包")}</div>
            <div className="v">
              {packManifest ? (
                <code style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {String(packManifest?.source?.title || packManifest?.mrpack?.name || packManifest?.provider || "").trim() || "-"}
                </code>
              ) : (
                <span className="muted">-</span>
              )}
            </div>
            <div className="hint">
              {packManifest ? (
                <>
                  <span className="muted">{t.tr("provider", "来源")}: </span>
                  <code>{String(packManifest?.provider || "-")}</code>
                  {packManifest?.source?.version_number || packManifest?.source?.version_name ? (
                    <>
                      {" · "}
                      <span className="muted">{t.tr("version", "版本")}: </span>
                      <code>{String(packManifest?.source?.version_number || packManifest?.source?.version_name || "").trim() || "-"}</code>
                    </>
                  ) : null}
                  {packManifest?.loader?.kind ? (
                    <>
                      {" · "}
                      <span className="muted">{t.tr("loader", "加载器")}: </span>
                      <code>
                        {String(packManifest?.loader?.kind || "").trim()}
                        {packManifest?.loader?.version ? ` ${String(packManifest.loader.version)}` : ""}
                      </code>
                    </>
                  ) : null}
                  {" · "}
                  <button
                    type="button"
                    className="linkBtn"
                    onClick={async () => {
                      const inst = instanceId.trim();
                      if (!inst) return;
                      setTab("files");
                      await openFileByPath(joinRelPath(inst, ".elegantmc_pack.json"));
                    }}
                    disabled={!selectedDaemon?.connected || !instanceId.trim()}
                  >
                    {t.tr("manifest", "manifest")}
                  </button>
                  {String(packManifest?.provider || "") === "modrinth" &&
                  String(packManifest?.source?.project_id || packManifest?.mrpack?.project_id || "")
                    .trim()
                    .length ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="linkBtn"
                        onClick={async () => {
                          const ok = await confirmDialog(
                            t.tr(
                              "Update this Modrinth pack to the latest version?\n\nThis updates pack files (mods/config/etc). Existing config files under config/ are preserved when they already exist.",
                              "将此 Modrinth 整合包更新到最新版本？\n\n这会更新整合包文件（mods/config 等）。对于 config/ 下已存在的配置文件，会尽量保留不覆盖。"
                            ),
                            {
                              title: t.tr("Update Pack", "更新整合包"),
                              confirmLabel: t.tr("Update", "更新"),
                              cancelLabel: t.tr("Cancel", "取消"),
                            }
                          );
                          if (!ok) return;
                          await updateModrinthPack();
                        }}
                        disabled={!selectedDaemon?.connected || !instanceId.trim() || gameActionBusy}
                      >
                        {t.tr("Update pack", "更新整合包")}
                      </button>
                    </>
                  ) : null}
                </>
              ) : packManifestStatus ? (
                <span style={{ color: "var(--danger)" }}>{packManifestStatus}</span>
              ) : (
                <span className="muted">{t.tr("not a modpack install", "非整合包安装")}</span>
              )}
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
            <div className="k">{t.tr("Notes", "备注")}</div>
            <div className="v" style={{ width: "100%" }}>
              <textarea
                value={noteDraft}
                onChange={(e: any) => setNoteDraft(e.target.value)}
                placeholder={t.tr("Local notes (not synced)", "本地备注（不同步）")}
                rows={3}
                style={{ width: "100%", resize: "vertical" }}
                disabled={!instanceId.trim()}
              />
            </div>
            <div className="hint">
              <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                <span className="muted">
                  {t.tr("saved locally", "仅本地保存")} · {Math.min(4000, Math.max(0, noteDraft.length))}/4000
                </span>
                <button type="button" onClick={saveNote} disabled={!instanceId.trim()}>
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
        {instanceStatus?.running && instanceId.trim() ? (
          <div className="row" style={{ marginTop: 10, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div className="hint" style={{ minWidth: 0 }}>
              {t.tr(
                "From a running instance, you can start an FRP proxy without restarting MC.",
                "实例运行中时，可无需重启 MC 直接启动 FRP proxy。"
              )}
            </div>
            <div className="btnGroup">
              <button
                type="button"
                className="iconBtn"
                onClick={() => startFrpProxyNow()}
                disabled={!selectedDaemon?.connected || !selectedProfile || gameActionBusy}
                title={!selectedProfile ? t.tr("Select an FRP profile first", "请先选择 FRP 配置") : undefined}
              >
                <Icon name="plus" />
                {t.tr("Start FRP proxy", "启动 FRP proxy")}
              </button>
            </div>
          </div>
        ) : null}
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
              <h2>{t.tr("Performance", "性能")}</h2>
              <div className="hint">
                {instanceId.trim() ? (
                  <>
                    {t.tr("game", "游戏")}: <code>{instanceId.trim()}</code>
                    {instanceMetricsStatus ? ` · ${instanceMetricsStatus}` : ""}
                    {tpsStatus ? ` · ${tpsStatus}` : ""}
                  </>
                ) : (
                  t.tr("Select a game to see performance metrics", "选择游戏以查看性能指标")
                )}
              </div>
              {instanceId.trim() ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  CPU: <code>{perf.cpuLatest == null ? "-" : `${perf.cpuLatest.toFixed(1)}%`}</code> · RSS:{" "}
                  <code>{perf.memLatestBytes == null ? "-" : fmtBytes(perf.memLatestBytes)}</code>
                  {perf.memTotalBytes > 0 && typeof perf.memLatestPct === "number" ? (
                    <>
                      {" "}
                      (<code>{perf.memLatestPct.toFixed(1)}%</code>)
                    </>
                  ) : null}
                  {" · "}
                  TPS: <code>{tpsInfo?.tps1 == null ? "-" : tpsInfo.tps1.toFixed(2)}</code>
                  {tpsInfo?.mspt != null ? (
                    <>
                      {" "}
                      / MSPT: <code>{tpsInfo.mspt.toFixed(2)}ms</code>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <div className="toolbarRight">
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                setTpsStatus(t.tr("Querying...", "查询中..."));
                sendQuickCommand("tps");
              }}
              disabled={!selectedDaemon?.connected || !instanceId.trim() || !running || gameActionBusy}
              title={!running ? t.tr("Start the server to query TPS", "请先启动服务器以查询 TPS") : undefined}
            >
              <Icon name="refresh" />
              {t.tr("Query TPS", "查询 TPS")}
            </button>
          </div>
        </div>

        {instanceId.trim() ? (
          <div className="row" style={{ marginTop: 10, gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ minWidth: 220 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">CPU%</span>
                <code>{perf.cpuLatest == null ? "-" : `${perf.cpuLatest.toFixed(1)}%`}</code>
              </div>
              <Sparkline values={perf.cpuValues} width={220} height={36} />
            </div>
            <div style={{ minWidth: 220 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">{t.tr("Memory (RSS %)", "内存（RSS %）")}</span>
                <code>
                  {perf.memLatestBytes == null ? "-" : fmtBytes(perf.memLatestBytes)}
                  {perf.memTotalBytes > 0 && typeof perf.memLatestPct === "number" ? ` (${perf.memLatestPct.toFixed(1)}%)` : ""}
                </code>
              </div>
              <Sparkline
                values={perf.memPctValues}
                width={220}
                height={36}
                stroke="rgba(34, 197, 94, 0.95)"
                fill="rgba(34, 197, 94, 0.14)"
              />
            </div>
            <div style={{ minWidth: 220 }}>
              <div className="muted">TPS (1m / 5m / 15m)</div>
              <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
                <span className={`badge ${tpsInfo?.tps1 != null && tpsInfo.tps1 >= 19.5 ? "ok" : ""}`}>
                  {tpsInfo?.tps1 != null ? tpsInfo.tps1.toFixed(2) : "-"}
                </span>
                <span className="badge">{tpsInfo?.tps5 != null ? tpsInfo.tps5.toFixed(2) : "-"}</span>
                <span className="badge">{tpsInfo?.tps15 != null ? tpsInfo.tps15.toFixed(2) : "-"}</span>
                {tpsInfo?.mspt != null ? <span className="badge">MSPT {tpsInfo.mspt.toFixed(2)}</span> : null}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {t.tr("last query", "最后查询")}: <code>{tpsInfo ? fmtUnix(tpsInfo.atUnix) : "-"}</code>
              </div>
            </div>
          </div>
        ) : (
          <div className="hint" style={{ marginTop: 10 }}>
            {t.tr("Select a game to see metrics.", "选择游戏以查看指标。")}
          </div>
        )}
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
              onClick={() => {
                setBackupNewStop(true);
                setBackupNewFormat("tar.gz");
                setBackupNewKeepLast(0);
                setBackupNewComment("");
                setBackupNewOpen(true);
              }}
              disabled={!canControl}
              title={!instanceId.trim() ? t.tr("Select a game first", "请先选择游戏") : undefined}
            >
              <Icon name="plus" />
              {t.tr("New backup", "新建备份")}
            </button>
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
                {t.tr("showing", "显示")} {Math.min(15, backupZips.length)} / {backupZips.length}
              </div>
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th style={{ width: 180 }}>{t.tr("Time", "时间")}</th>
                    <th>{t.tr("Backup", "备份")}</th>
                    <th style={{ width: 110 }}>{t.tr("Size", "大小")}</th>
                    <th>{t.tr("Comment", "备注")}</th>
                    <th style={{ width: 210 }} />
                  </tr>
                </thead>
                <tbody>
                  {backupZips.slice(0, 15).map((p: string) => {
                    const path = String(p || "");
                    const file = path.split("/").pop() || path;
                    const meta = backupMetaByPath[path] || null;
                    const unixMeta = Math.floor(Number(meta?.created_at_unix || 0));
                    const m = file.match(/-(\d{9,12})\.(?:zip|tar\.gz|tgz)$/i);
                    const unixName = m ? Math.floor(Number(m[1])) : 0;
                    const unix =
                      (Number.isFinite(unixMeta) && unixMeta > 0 ? unixMeta : 0) ||
                      (Number.isFinite(unixName) && unixName > 0 ? unixName : 0) ||
                      0;
                    const bytes = meta && Number.isFinite(Number(meta?.bytes)) ? Number(meta.bytes) : null;
                    const comment = meta ? String(meta?.comment || "").trim() : "";
                    const format =
                      meta && String(meta?.format || "").trim()
                        ? String(meta.format).trim()
                        : file.toLowerCase().endsWith(".zip")
                          ? "zip"
                          : "tar.gz";
                    return (
                      <tr key={path}>
                        <td className="muted">{unix ? fmtUnix(unix) : "-"}</td>
                        <td style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <span className="badge">{format}</span>
                            <code style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{file}</code>
                          </div>
                        </td>
                        <td>{bytes == null ? "-" : fmtBytes(bytes)}</td>
                        <td className="muted" style={{ minWidth: 0 }}>
                          {comment || <span className="muted">-</span>}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                            <button
                              type="button"
                              className="iconBtn iconOnly"
                              title={t.tr("Copy path", "复制路径")}
                              aria-label={t.tr("Copy path", "复制路径")}
                              onClick={() => copyText(path)}
                            >
                              <Icon name="copy" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const inst = instanceId.trim();
                                if (!inst) return;
                                setFsPath(`_backups/${inst}`);
                                setTab("files");
                              }}
                            >
                              {t.tr("Open", "打开")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <div className="hint">
              {t.tr("No backups yet. Use New backup to create one.", "暂无备份。使用「新建备份」创建一个备份。")}
            </div>
          )
        ) : (
          <div className="hint">{t.tr("Select a game to see backups.", "选择游戏以查看备份。")}</div>
        )}
      </div>

      <div className="card">
        <h2>{t.tr("Danger Zone", "危险区")}</h2>
        <div className="hint">
          {instanceId.trim()
            ? t.tr("High-risk actions require extra confirmation.", "高风险操作会要求额外确认。")
            : t.tr("Select a game to manage dangerous actions.", "选择游戏以管理危险操作。")}
        </div>

        <DangerZone title={t.tr("Danger Zone", "危险区")}>
          <div className="grid2" style={{ alignItems: "end" }}>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>{t.tr("Restore from backup", "从备份恢复")}</label>
              <Select
                value={dangerRestorePath}
                onChange={(v) => setDangerRestorePath(v)}
                disabled={!Array.isArray(backupZips) || !backupZips.length || !canControl}
                placeholder={
                  Array.isArray(backupZips) && backupZips.length ? t.tr("Select backup…", "选择备份…") : t.tr("No backups found", "未找到备份")
                }
                options={(Array.isArray(backupZips) ? backupZips : []).slice(0, 25).map((p: any) => {
                  const path = String(p || "").trim();
                  const meta = path ? (backupMetaByPath as any)?.[path] : null;
                  const file = path ? path.split("/").pop() || path : "-";
                  const unix = meta && typeof meta.created_at_unix === "number" ? meta.created_at_unix : 0;
                  const label = unix ? `${fmtUnix(unix)} · ${file}` : file;
                  return { value: path, label };
                })}
              />
              <div className="hint">
                {t.tr("This will overwrite servers/<instance>/.", "这将覆盖 servers/<instance>/。")}{" "}
                <code>{instanceId.trim() ? `servers/${instanceId.trim()}/` : "servers/<instance>/"}</code>
              </div>
              <div className="btnGroup" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <button
                  type="button"
                  className="dangerBtn"
                  onClick={() => restoreBackupNow(dangerRestorePath)}
                  disabled={!canControl || !dangerRestorePath.trim()}
                >
                  {t.tr("Restore", "恢复")}
                </button>
              </div>
            </div>

            <div className="field">
              <label>{t.tr("Server jar", "服务端 Jar")}</label>
              <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                <button type="button" className="iconBtn" onClick={openJarUpdateModal} disabled={!canControl}>
                  {t.tr("Update jar…", "更新 Jar…")}
                </button>
              </div>
              <div className="hint">{t.tr("Stops the server and replaces the jar file.", "会停止服务器并替换 Jar 文件。")}</div>
            </div>

            <div className="field">
              <label>{t.tr("Instance", "实例")}</label>
              <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                <button type="button" className="dangerBtn" onClick={() => deleteServer()} disabled={!canControl}>
                  {t.tr("Move to trash…", "移入回收站…")}
                </button>
              </div>
              <div className="hint">{t.tr("Moves servers/<instance>/ to trash.", "将 servers/<instance>/ 移入回收站。")}</div>
            </div>
          </div>
        </DangerZone>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Players", "玩家")}</h2>
              <div className="hint">
                {instanceId.trim() ? (
                  <>
                    {t.tr("game", "游戏")}: <code>{instanceId.trim()}</code>
                  </>
                ) : (
                  t.tr("Select a game to manage players", "选择游戏以管理玩家")
                )}
              </div>
            </div>
          </div>
          <div className="toolbarRight" style={{ alignItems: "center" }}>
            <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
              <button type="button" className={accessTab === "players" ? "primary" : ""} onClick={() => setAccessTab("players")} disabled={!instanceId.trim()}>
                {t.tr("Players", "玩家")}
              </button>
              <button type="button" className={accessTab === "whitelist" ? "primary" : ""} onClick={() => setAccessTab("whitelist")} disabled={!instanceId.trim()}>
                {t.tr("Whitelist", "白名单")}
              </button>
              <button type="button" className={accessTab === "ops" ? "primary" : ""} onClick={() => setAccessTab("ops")} disabled={!instanceId.trim()}>
                Ops
              </button>
            </div>

            {accessTab === "players" ? (
              <>
                <button type="button" className="iconBtn" onClick={refreshPlayers} disabled={!selectedDaemon?.connected || !instanceId.trim() || playersBusy}>
                  <Icon name="refresh" />
                  {t.tr("Refresh", "刷新")}
                </button>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={async () => {
                    const inst = instanceId.trim();
                    if (!inst) return;
                    setTab("files");
                    await openFileByPath(joinRelPath(inst, "usercache.json"));
                  }}
                  disabled={!selectedDaemon?.connected || !instanceId.trim()}
                >
                  {t.tr("Open file", "打开文件")}
                </button>
              </>
            ) : accessTab === "whitelist" ? (
              <>
                <button type="button" className="iconBtn" onClick={refreshWhitelist} disabled={!selectedDaemon?.connected || !instanceId.trim() || whitelistBusy}>
                  <Icon name="refresh" />
                  {t.tr("Refresh", "刷新")}
                </button>
                <button type="button" className="iconBtn" onClick={saveWhitelist} disabled={!selectedDaemon?.connected || !instanceId.trim() || whitelistBusy || !whitelistDirty}>
                  {t.tr("Save", "保存")}
                </button>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={async () => {
                    const inst = instanceId.trim();
                    if (!inst) return;
                    setTab("files");
                    await openFileByPath(joinRelPath(inst, "whitelist.json"));
                  }}
                  disabled={!selectedDaemon?.connected || !instanceId.trim()}
                >
                  {t.tr("Open file", "打开文件")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="iconBtn" onClick={refreshOps} disabled={!selectedDaemon?.connected || !instanceId.trim() || opsBusy}>
                  <Icon name="refresh" />
                  {t.tr("Refresh", "刷新")}
                </button>
                <button type="button" className="iconBtn" onClick={saveOps} disabled={!selectedDaemon?.connected || !instanceId.trim() || opsBusy || !opsDirty}>
                  {t.tr("Save", "保存")}
                </button>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={async () => {
                    const inst = instanceId.trim();
                    if (!inst) return;
                    setTab("files");
                    await openFileByPath(joinRelPath(inst, "ops.json"));
                  }}
                  disabled={!selectedDaemon?.connected || !instanceId.trim()}
                >
                  {t.tr("Open file", "打开文件")}
                </button>
              </>
            )}
          </div>
        </div>

        {accessTab === "players" ? (
          <>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div className="hint">
                <code>servers/&lt;instance&gt;/usercache.json</code>
                {playersStatus ? ` · ${playersStatus}` : ""}
              </div>
              <input
                value={playersQueryRaw}
                onChange={(e: any) => setPlayersQueryRaw(e.target.value)}
                placeholder={t.tr("Search players…", "搜索玩家…")}
                style={{ width: 260 }}
                disabled={!instanceId.trim()}
              />
            </div>
            {players.length ? (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>{t.tr("Name", "名称")}</th>
                    <th>UUID</th>
                    <th>{t.tr("Expires", "过期")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {players
                    .filter((p) => {
                      const q = String(playersQuery || "").trim().toLowerCase();
                      if (!q) return true;
                      return `${p.name} ${p.uuid} ${p.expiresOn}`.toLowerCase().includes(q);
                    })
                    .map((p) => (
                      <tr key={`${p.uuid}-${p.name}`}>
                        <td>
                          <code>{p.name || "-"}</code>
                        </td>
                        <td>
                          <code>{p.uuid || "-"}</code>
                        </td>
                        <td className="muted">{p.expiresOn || "-"}</td>
                        <td style={{ textAlign: "right" }}>
                          <button type="button" className="iconBtn iconOnly" title={t.tr("Copy", "复制")} aria-label={t.tr("Copy", "复制")} onClick={() => copyText(p.uuid || p.name)}>
                            <Icon name="copy" />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <div className="hint" style={{ marginTop: 10 }}>
                {playersStatus || t.tr("No players yet.", "暂无玩家。")}
              </div>
            )}
          </>
        ) : accessTab === "whitelist" ? (
          <>
            <div className="hint">
              <code>servers/&lt;instance&gt;/whitelist.json</code>
              {whitelistStatus ? ` · ${whitelistStatus}` : ""}
              {whitelistDirty ? ` · ${t.tr("unsaved", "未保存")}` : ""}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
              <input
                value={wlAddName}
                onChange={(e: any) => setWlAddName(e.target.value)}
                placeholder={t.tr("Name (optional)", "Name（可选）")}
                style={{ flex: 1, minWidth: 180 }}
                disabled={!instanceId.trim()}
              />
              <input
                value={wlAddUuid}
                onChange={(e: any) => setWlAddUuid(e.target.value)}
                placeholder={t.tr("UUID (optional)", "UUID（可选）")}
                style={{ flex: 1, minWidth: 260 }}
                disabled={!instanceId.trim()}
              />
              <button type="button" onClick={addWhitelistEntry} disabled={!instanceId.trim()}>
                <Icon name="plus" /> {t.tr("Add", "添加")}
              </button>
            </div>
            {wlErr ? (
              <div className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
                {wlErr}
              </div>
            ) : null}
            {whitelistEntries.length ? (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>{t.tr("Name", "名称")}</th>
                    <th>UUID</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {whitelistEntries.map((p) => (
                    <tr key={`${p.uuid}-${p.name}`}>
                      <td>
                        <code>{p.name || "-"}</code>
                      </td>
                      <td>
                        <code>{p.uuid || "-"}</code>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="btnGroup">
                          <button type="button" className="iconBtn iconOnly" title={t.tr("Copy", "复制")} aria-label={t.tr("Copy", "复制")} onClick={() => copyText(p.uuid || p.name)}>
                            <Icon name="copy" />
                          </button>
                          <button
                            type="button"
                            className="dangerBtn iconBtn iconOnly"
                            title={t.tr("Remove", "移除")}
                            aria-label={t.tr("Remove", "移除")}
                            onClick={() => {
                              setWhitelistEntries((prev) => (prev || []).filter((x) => !(x.uuid === p.uuid && x.name === p.name)));
                              setWhitelistDirty(true);
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint" style={{ marginTop: 10 }}>
                {t.tr("No whitelist entries yet.", "暂无白名单。")}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="hint">
              <code>servers/&lt;instance&gt;/ops.json</code>
              {opsStatus ? ` · ${opsStatus}` : ""}
              {opsDirty ? ` · ${t.tr("unsaved", "未保存")}` : ""}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
              <input
                value={opAddName}
                onChange={(e: any) => setOpAddName(e.target.value)}
                placeholder={t.tr("Name (optional)", "Name（可选）")}
                style={{ flex: 1, minWidth: 180 }}
                disabled={!instanceId.trim()}
              />
              <input
                value={opAddUuid}
                onChange={(e: any) => setOpAddUuid(e.target.value)}
                placeholder={t.tr("UUID (optional)", "UUID（可选）")}
                style={{ flex: 1, minWidth: 260 }}
                disabled={!instanceId.trim()}
              />
              <input
                type="number"
                value={opAddLevel}
                onChange={(e: any) => setOpAddLevel(Math.round(Number(e.target.value || 0)) || 4)}
                min={1}
                max={4}
                title={t.tr("level 1-4", "level 1-4")}
                style={{ width: 86 }}
                disabled={!instanceId.trim()}
              />
              <label className="checkRow" style={{ userSelect: "none" }}>
                <input type="checkbox" checked={opAddBypass} onChange={(e: any) => setOpAddBypass(!!e.target.checked)} />{" "}
                {t.tr("Bypass limit", "绕过人数限制")}
              </label>
              <button type="button" onClick={addOpEntry} disabled={!instanceId.trim()}>
                <Icon name="plus" /> {t.tr("Add", "添加")}
              </button>
            </div>
            {opErr ? (
              <div className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
                {opErr}
              </div>
            ) : null}
            {opsEntries.length ? (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>{t.tr("Name", "名称")}</th>
                    <th>UUID</th>
                    <th>{t.tr("Level", "等级")}</th>
                    <th>{t.tr("Bypass", "绕过")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {opsEntries.map((p) => (
                    <tr key={`${p.uuid}-${p.name}`}>
                      <td>
                        <code>{p.name || "-"}</code>
                      </td>
                      <td>
                        <code>{p.uuid || "-"}</code>
                      </td>
                      <td>
                        <code>{p.level}</code>
                      </td>
                      <td className="muted">{p.bypassesPlayerLimit ? t.tr("yes", "是") : t.tr("no", "否")}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="btnGroup">
                          <button type="button" className="iconBtn iconOnly" title={t.tr("Copy", "复制")} aria-label={t.tr("Copy", "复制")} onClick={() => copyText(p.uuid || p.name)}>
                            <Icon name="copy" />
                          </button>
                          <button
                            type="button"
                            className="dangerBtn iconBtn iconOnly"
                            title={t.tr("Remove", "移除")}
                            aria-label={t.tr("Remove", "移除")}
                            onClick={() => {
                              setOpsEntries((prev) => (prev || []).filter((x) => !(x.uuid === p.uuid && x.name === p.name)));
                              setOpsDirty(true);
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint" style={{ marginTop: 10 }}>
                {t.tr("No ops yet.", "暂无 OP。")}
              </div>
            )}
          </>
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
            {logsLoading ? (
              <div className="stack" style={{ padding: 12, gap: 10 }}>
                {Array.from({ length: 14 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ minHeight: 18, borderRadius: 10 }} />
                ))}
              </div>
            ) : (
              <>
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
              </>
            )}
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
          {logScrollTop > 520 ? (
            <button
              type="button"
              className="logTopPill"
              onClick={() => {
                const el = logScrollRef.current;
                if (!el) return;
                el.scrollTop = 0;
                setLogScrollTop(0);
              }}
              title={t.tr("Back to top", "回到顶部")}
            >
              {t.tr("Top", "顶部")}
            </button>
          ) : null}
        </div>
        <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
          <div className="hint">{t.tr("Tip: All shows current game + FRP logs.", "提示：All 会显示当前游戏 + FRP 的日志。")}</div>
          {logRangeLabel ? (
            <span className="muted">
              {t.tr("Range", "范围")}: <code>{logRangeLabel}</code>
            </span>
          ) : null}
        </div>

        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
          <span className="muted">{t.tr("Quick", "快捷")}:</span>
          <Select
            value=""
            onChange={async (v) => {
              if (v === "stop") {
                const ok = await confirmDialog(
                  t.tr("Send 'stop' to the server console? The server will shut down.", "向服务端控制台发送 'stop'？服务器将关闭。"),
                  { title: t.tr("Stop", "停止"), confirmLabel: t.tr("Stop", "停止"), cancelLabel: t.tr("Cancel", "取消"), danger: true }
                );
                if (!ok) return;
                await sendQuickCommand("stop");
                return;
              }
              if (v === "reload") {
                const ok = await confirmDialog(
                  t.tr(
                    "Send 'reload' to the server console? This is risky on many servers/plugins.",
                    "向服务端控制台发送 'reload'？这在很多服务端/插件上都有风险。"
                  ),
                  { title: "reload", confirmLabel: "reload", cancelLabel: t.tr("Cancel", "取消"), danger: true }
                );
                if (!ok) return;
                await sendQuickCommand("reload");
              }
            }}
            placeholder={t.tr("Danger Zone", "危险区")}
            options={[
              { value: "stop", label: t.tr("Stop", "停止"), disabled: !selectedDaemon?.connected || !instanceId.trim() },
              { value: "reload", label: "reload", disabled: !selectedDaemon?.connected || !instanceId.trim() },
            ]}
            style={{ width: 160 }}
          />
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

        {cmdCapture || cmdOutputs.length ? (
          <div className="itemCard" style={{ marginTop: 12 }}>
            <div className="itemCardHeader">
              <div style={{ minWidth: 0 }}>
                <div className="itemTitle">{t.tr("Command output", "命令输出")}</div>
                <div className="itemMeta">
                  {cmdCapture ? (
                    <>
                      {t.tr("capturing", "抓取中")}: <code>{cmdCapture.cmd}</code>
                    </>
                  ) : cmdOutputs[0] ? (
                    <>
                      {fmtUnix(cmdOutputs[0].startedUnix)} · <code>{cmdOutputs[0].cmd}</code>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="btnGroup">
                <button
                  type="button"
                  className="iconBtn"
                  onClick={() => {
                    const lines = cmdCapture ? cmdCaptureLines : cmdOutputs[0]?.lines || [];
                    copyText((lines || []).join("\n") || "<empty>");
                  }}
                  disabled={!(cmdCapture ? cmdCaptureLines.length : cmdOutputs[0]?.lines?.length)}
                >
                  <Icon name="copy" />
                  {t.tr("Copy", "复制")}
                </button>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={() => {
                    setCmdOutputs([]);
                    setCmdCapture(null);
                    setCmdCaptureLines([]);
                    cmdCaptureLinesRef.current = [];
                  }}
                  disabled={!cmdCapture && !cmdOutputs.length}
                >
                  {t.tr("Clear", "清空")}
                </button>
              </div>
            </div>
            <pre style={{ margin: 0, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>
              {(cmdCapture ? cmdCaptureLines : cmdOutputs[0]?.lines || []).slice(-120).join("\n") || t.tr("<no output captured>", "<未捕获到输出>")}
            </pre>
          </div>
        ) : null}
      </div>

      {backupNewOpen ? (
        <div className="modalOverlay" onClick={() => (!gameActionBusy ? setBackupNewOpen(false) : null)}>
          <div className="modal" style={{ width: "min(720px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>{t.tr("Create Backup", "创建备份")}</div>
                <div className="hint">
                  {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code>
                </div>
              </div>
              <button type="button" onClick={() => setBackupNewOpen(false)} disabled={gameActionBusy}>
                {t.tr("Close", "关闭")}
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>{t.tr("Format", "格式")}</label>
                <Select
                  value={backupNewFormat}
                  onChange={(v) => setBackupNewFormat((v as any) === "zip" ? "zip" : "tar.gz")}
                  options={[
                    { value: "tar.gz", label: "tar.gz" },
                    { value: "zip", label: "zip" },
                  ]}
                />
                <div className="hint">{t.tr("tar.gz is smaller; zip is faster for small worlds.", "tar.gz 更小；zip 在小世界可能更快。")}</div>
              </div>
              <div className="field">
                <label>{t.tr("Keep last", "保留最近")}</label>
                <input
                  type="number"
                  value={Number.isFinite(backupNewKeepLast) ? backupNewKeepLast : 0}
                  onChange={(e) => setBackupNewKeepLast(Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0))))}
                  min={0}
                  max={1000}
                />
                <div className="hint">{t.tr("0 = keep everything (no prune).", "0 = 全部保留（不自动清理）。")}</div>
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Comment (optional)", "备注（可选）")}</label>
                <input
                  value={backupNewComment}
                  onChange={(e) => setBackupNewComment(e.target.value)}
                  placeholder={t.tr("e.g. before upgrading jar", "例如：升级 jar 前")}
                />
                <div className="hint">{t.tr("Stored as a .meta.json sidecar next to the archive.", "会写入到备份文件旁的 .meta.json。")}</div>
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Stop server", "停止服务器")}</label>
                <label className="checkRow">
                  <input type="checkbox" checked={backupNewStop} onChange={(e) => setBackupNewStop(e.target.checked)} />{" "}
                  {t.tr("Stop the instance before backup (recommended).", "备份前停止实例（推荐）。")}
                </label>
              </div>
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div className="hint">{gameActionBusy ? t.tr("working…", "处理中…") : ""}</div>
              <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setBackupNewOpen(false)} disabled={gameActionBusy}>
                  {t.tr("Cancel", "取消")}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={async () => {
                    const inst = instanceId.trim();
                    if (!inst) return;
                    const format = backupNewFormat === "zip" ? "zip" : "tar.gz";
                    const keepLast = Math.max(0, Math.min(1000, Math.round(Number(backupNewKeepLast || 0) || 0)));
                    const comment = String(backupNewComment || "").trim();
                    await backupServer(inst, { format, keep_last: keepLast, stop: backupNewStop, comment });
                    setBackupNewOpen(false);
                  }}
                  disabled={!canControl}
                >
                  {t.tr("Create", "创建")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
