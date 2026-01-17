"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppCtxProvider } from "./appCtx";
import AdvancedView from "./views/AdvancedView";
import FilesView from "./views/FilesView";
import FrpView from "./views/FrpView";
import GamesView from "./views/GamesView";
import NodesView from "./views/NodesView";

type Daemon = {
  id: string;
  connected: boolean;
  connectedAtUnix: number | null;
  lastSeenUnix: number | null;
  hello: any;
  heartbeat: any;
  history?: any[];
};

type McVersion = {
  id: string;
  type?: string;
  releaseTime?: string;
};

type FrpProfile = {
  id: string;
  name: string;
  server_addr: string;
  server_port: number;
  token?: string;
  created_at_unix?: number;
  status?: {
    checkedAtUnix?: number;
    online?: boolean | null;
    latencyMs?: number;
    error?: string;
  };
};

type Tab = "nodes" | "games" | "frp" | "files" | "advanced";

type ThemeMode = "auto" | "dark" | "light";

type GameSettingsSnapshot = {
  jarPath: string;
  javaPath: string;
  gamePort: number;
  xms: string;
  xmx: string;
  enableFrp: boolean;
  frpProfileId: string;
  frpRemotePort: number;
};

type InstallForm = {
  instanceId: string;
  kind: "vanilla" | "paper";
  version: string;
  paperBuild: number;
  xms: string;
  xmx: string;
  gamePort: number;
  jarName: string;
  javaPath: string;
  acceptEula: boolean;
  enableFrp: boolean;
  frpProfileId: string;
  frpRemotePort: number;
};

type StartOverride = Partial<{
  jarPath: string;
  javaPath: string;
  gamePort: number;
  xms: string;
  xmx: string;
  enableFrp: boolean;
  frpProfileId: string;
  frpRemotePort: number;
}>;

const INSTANCE_CONFIG_NAME = ".elegantmc.json";

function joinRelPath(a: string, b: string) {
  const left = (a || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const right = (b || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

function parentRelPath(p: string) {
  const norm = (p || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!norm) return "";
  const parts = norm.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function b64EncodeUtf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64DecodeUtf8(b64: string) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64EncodeBytes(bytes: Uint8Array) {
  const parts: string[] = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const chunk = bytes.subarray(i, i + step);
    const chars = new Array(chunk.length);
    for (let j = 0; j < chunk.length; j++) chars[j] = String.fromCharCode(chunk[j]);
    parts.push(chars.join(""));
  }
  return btoa(parts.join(""));
}

function fmtUnix(ts?: number | null) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function fmtBytes(n?: number) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function pct(used?: number, total?: number) {
  const u = Number(used || 0);
  const t = Number(total || 0);
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, (u * 100) / t));
}

function clamp(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function Sparkline({
  values,
  width = 120,
  height = 28,
  stroke = "rgba(147, 197, 253, 0.95)",
}: {
  values: Array<number | null | undefined>;
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const vals = values.slice(-60).map((v) => (typeof v === "number" ? clamp(v, 0, 100) : 0));
  const n = vals.length;
  const step = n > 1 ? width / (n - 1) : width;
  const pts = vals
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function isLocalLikeHost(hostname: string) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (![a, b, c, d].every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function stripPortFromHost(host: string) {
  const v = String(host || "").trim();
  if (!v) return "";

  // [ipv6]:port
  if (v.startsWith("[") && v.includes("]")) {
    const idx = v.indexOf("]");
    const inside = v.slice(1, idx);
    return inside || v;
  }

  // host:port (single colon)
  const firstColon = v.indexOf(":");
  const lastColon = v.lastIndexOf(":");
  if (firstColon > 0 && firstColon === lastColon) {
    const port = v.slice(lastColon + 1);
    if (/^\d+$/.test(port)) return v.slice(0, lastColon);
  }

  return v;
}

function pickBestLocalHost(uiHost: string, preferredAddrs: string[], daemonIPv4: string[]) {
  const host = String(uiHost || "").trim();
  const preferred = Array.isArray(preferredAddrs)
    ? preferredAddrs.map((v) => stripPortFromHost(String(v || "").trim())).filter(Boolean)
    : [];
  const ips = Array.isArray(daemonIPv4) ? daemonIPv4.map((v) => String(v || "").trim()).filter(Boolean) : [];

  if (preferred.length) return preferred[0];
  if (isLocalLikeHost(host)) return host;

  const preferredIP = ips.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("169.254."));
  if (preferredIP) return preferredIP;

  const first = ips.find((ip) => !ip.startsWith("127.")) || ips[0] || "";
  if (first) {
    // In docker-compose, daemon may only see container IPs (172.17-31.*). When panel is accessed via a public hostname,
    // the published ports are typically on the panel host instead of the container IP.
    if (host && !isLocalLikeHost(host) && /^172\.(1[7-9]|2\d|3[01])\./.test(first)) return host;
    return first;
  }

  return host || "127.0.0.1";
}

function maskToken(token?: string) {
  const t = String(token || "");
  if (!t) return "(none)";
  if (t.length <= 4) return "****";
  return `${"*".repeat(Math.min(12, t.length - 4))}${t.slice(-4)}`;
}

function normalizeJarName(raw: string) {
  const v = String(raw || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "");
  const parts = v.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "server.jar";
}

function normalizeJarPath(instanceId: string, jarPath: string) {
  const inst = String(instanceId || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  let jar = String(jarPath || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "");
  jar = jar.replace(/^(\.\/)+/, "");
  while (inst && jar.startsWith(`${inst}/`)) jar = jar.slice(inst.length + 1);
  return jar || "server.jar";
}

function getPropValue(text: string, key: string) {
  const k = `${key}=`;
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith(k)) return t.slice(k.length).trim();
  }
  return null;
}

function upsertProp(text: string, key: string, value: string) {
  const k = `${key}=`;
  const lines = String(text || "").split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    if (t.startsWith(k)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join("\n").replace(/\n+$/, "\n");
}

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("games");
  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");

  const [daemons, setDaemons] = useState<Daemon[]>([]);
  const [selected, setSelected] = useState<string>("");
  const selectedDaemon = useMemo(() => daemons.find((d) => d.id === selected) || null, [daemons, selected]);

  const [error, setError] = useState<string>("");
  const [uiHost, setUiHost] = useState<string>("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginStatus, setLoginStatus] = useState<string>("");

  // UI dialogs (avoid browser confirm/prompt)
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [confirmTitle, setConfirmTitle] = useState<string>("Confirm");
  const [confirmMessage, setConfirmMessage] = useState<string>("");
  const [confirmDanger, setConfirmDanger] = useState<boolean>(false);
  const [confirmConfirmLabel, setConfirmConfirmLabel] = useState<string>("Confirm");
  const [confirmCancelLabel, setConfirmCancelLabel] = useState<string>("Cancel");
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const [copyOpen, setCopyOpen] = useState<boolean>(false);
  const [copyValue, setCopyValue] = useState<string>("");

  // Logs
  const [logs, setLogs] = useState<any[]>([]);

  // Files
  const [fsPath, setFsPath] = useState<string>("");
  const [fsEntries, setFsEntries] = useState<any[]>([]);
  const [fsSelectedFile, setFsSelectedFile] = useState<string>("");
  const [fsFileText, setFsFileText] = useState<string>("");
  const [fsStatus, setFsStatus] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState<number>(0);
  const [uploadStatus, setUploadStatus] = useState<string>("");

  // Server controls
  const [instanceId, setInstanceId] = useState<string>("");
  const [jarPath, setJarPath] = useState<string>("server.jar");
  const [javaPath, setJavaPath] = useState<string>("");
  const [gamePort, setGamePort] = useState<number>(25565);
  const [xms, setXms] = useState<string>("1G");
  const [xmx, setXmx] = useState<string>("2G");
  const [consoleLine, setConsoleLine] = useState<string>("");
  const [serverOpStatus, setServerOpStatus] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsSnapshot, setSettingsSnapshot] = useState<GameSettingsSnapshot | null>(null);
  const [installOpen, setInstallOpen] = useState<boolean>(false);
  const [installRunning, setInstallRunning] = useState<boolean>(false);
  const [installStartUnix, setInstallStartUnix] = useState<number>(0);
  const [installInstance, setInstallInstance] = useState<string>("");
  const [installForm, setInstallForm] = useState<InstallForm>(() => ({
    instanceId: "",
    kind: "vanilla",
    version: "1.20.1",
    paperBuild: 0,
    xms: "1G",
    xmx: "2G",
    gamePort: 25565,
    jarName: "server.jar",
    javaPath: "",
    acceptEula: true,
    enableFrp: true,
    frpProfileId: "",
    frpRemotePort: 25566,
  }));
  const [logView, setLogView] = useState<"all" | "mc" | "install" | "frp">("all");

  // Server list (directories under servers/)
  const [serverDirs, setServerDirs] = useState<string[]>([]);
  const [serverDirsStatus, setServerDirsStatus] = useState<string>("");

  // Vanilla versions
  const [versions, setVersions] = useState<McVersion[]>([]);
  const [versionsStatus, setVersionsStatus] = useState<string>("");

  // FRP profiles (saved on panel)
  const [profiles, setProfiles] = useState<FrpProfile[]>([]);
  const [profilesStatus, setProfilesStatus] = useState<string>("");
  const [addFrpOpen, setAddFrpOpen] = useState<boolean>(false);
  const [newProfileName, setNewProfileName] = useState<string>("");
  const [newProfileAddr, setNewProfileAddr] = useState<string>("");
  const [newProfilePort, setNewProfilePort] = useState<number>(7000);
  const [newProfileToken, setNewProfileToken] = useState<string>("");

  // FRP start params (per action)
  const [enableFrp, setEnableFrp] = useState<boolean>(true);
  const [frpProfileId, setFrpProfileId] = useState<string>("");
  const [frpRemotePort, setFrpRemotePort] = useState<number>(25566);
  const [frpOpStatus, setFrpOpStatus] = useState<string>("");

  // Node management
  const [nodes, setNodes] = useState<any[]>([]);
  const [nodesStatus, setNodesStatus] = useState<string>("");
  const [nodeDetailsOpen, setNodeDetailsOpen] = useState<boolean>(false);
  const [nodeDetailsId, setNodeDetailsId] = useState<string>("");
  const [addNodeOpen, setAddNodeOpen] = useState<boolean>(false);
  const [createdNode, setCreatedNode] = useState<{ id: string; token: string } | null>(null);
  const [newNodeId, setNewNodeId] = useState<string>("");
  const [newNodeToken, setNewNodeToken] = useState<string>("");

  // Advanced command runner
  const [cmdName, setCmdName] = useState<string>("ping");
  const [cmdArgs, setCmdArgs] = useState<string>("{}");
  const [cmdResult, setCmdResult] = useState<any>(null);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === frpProfileId) || null,
    [profiles, frpProfileId]
  );

  const nodeDetailsNode = useMemo(() => nodes.find((n: any) => n?.id === nodeDetailsId) || null, [nodes, nodeDetailsId]);

  const instanceStatus = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.instances || [];
    return list.find((i: any) => i?.id === instanceId) || null;
  }, [selectedDaemon, instanceId]);

  const frpStatus = useMemo(() => selectedDaemon?.heartbeat?.frp || null, [selectedDaemon]);
  const daemonIPv4 = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.net?.ipv4;
    return Array.isArray(list) ? list.map((v: any) => String(v || "").trim()).filter(Boolean) : [];
  }, [selectedDaemon]);
  const preferredConnectAddrs = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.net?.preferred_connect_addrs;
    return Array.isArray(list) ? list.map((v: any) => String(v || "").trim()).filter(Boolean) : [];
  }, [selectedDaemon]);
  const localHost = useMemo(() => pickBestLocalHost(uiHost, preferredConnectAddrs, daemonIPv4), [uiHost, preferredConnectAddrs, daemonIPv4]);
  const fsBreadcrumbs = useMemo(() => {
    const norm = String(fsPath || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const parts = norm ? norm.split("/").filter(Boolean) : [];
    const out: { label: string; path: string }[] = [{ label: "servers", path: "" }];
    let cur = "";
    for (const p of parts) {
      cur = joinRelPath(cur, p);
      out.push({ label: p, path: cur });
    }
    return out;
  }, [fsPath]);

  // Theme (auto/light/dark)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("elegantmc_theme_mode") || "auto";
      if (saved === "dark" || saved === "light" || saved === "auto") setThemeMode(saved);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mode: ThemeMode = themeMode === "dark" || themeMode === "light" ? themeMode : "auto";
    try {
      localStorage.setItem("elegantmc_theme_mode", mode);
    } catch {
      // ignore
    }
    try {
      const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
      const apply = () => {
        const sys = mql && mql.matches ? "light" : "dark";
        const theme = mode === "auto" ? sys : mode;
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.themeMode = mode;
      };
      apply();
      if (mode !== "auto" || !mql) return;
      const onChange = () => apply();
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      // eslint-disable-next-line deprecation/deprecation
      if (typeof (mql as any).addListener === "function") {
        // eslint-disable-next-line deprecation/deprecation
        (mql as any).addListener(onChange);
        // eslint-disable-next-line deprecation/deprecation
        return () => (mql as any).removeListener(onChange);
      }
    } catch {
      // ignore
    }
  }, [themeMode]);

  // Modal keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmOpen) {
          e.preventDefault();
          closeConfirm(false);
          return;
        }
        if (copyOpen) {
          e.preventDefault();
          setCopyOpen(false);
          return;
        }
        if (installOpen && !installRunning) {
          e.preventDefault();
          setInstallOpen(false);
          return;
        }
        if (settingsOpen) {
          e.preventDefault();
          cancelEditSettings();
          return;
        }
        if (nodeDetailsOpen) {
          e.preventDefault();
          setNodeDetailsOpen(false);
          return;
        }
        if (addNodeOpen) {
          e.preventDefault();
          setAddNodeOpen(false);
          return;
        }
        if (addFrpOpen) {
          e.preventDefault();
          setAddFrpOpen(false);
          return;
        }
      }
      if (e.key === "Enter" && confirmOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const tag = String((e.target as any)?.tagName || "").toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          closeConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen, copyOpen, installOpen, installRunning, settingsOpen, nodeDetailsOpen, addNodeOpen, addFrpOpen]);

  // Panel auth (cookie-based)
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store", credentials: "include" });
        if (!cancelled) setAuthed(res.ok);
      } catch {
        if (!cancelled) setAuthed(false);
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function apiFetch(url: string, init: RequestInit = {}) {
    const nextInit: RequestInit = { ...init };
    if (!nextInit.cache) nextInit.cache = "no-store";
    if (!nextInit.credentials) nextInit.credentials = "include";
    const res = await fetch(url, nextInit);
    if (res.status === 401) setAuthed(false);
    return res;
  }

  async function login() {
    setLoginStatus("Logging in...");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword }),
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "login failed");
      setAuthed(true);
      setLoginPassword("");
      setLoginStatus("");
      setError("");
    } catch (e: any) {
      setLoginStatus(String(e?.message || e));
      setAuthed(false);
    }
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setAuthed(false);
  }

  async function callCommand(name: string, args: any, timeoutMs = 60_000) {
    if (!selected) throw new Error("no daemon selected");
    const res = await apiFetch(`/api/daemons/${encodeURIComponent(selected)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, timeoutMs }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "request failed");
    return json.result;
  }

  async function callOkCommand(name: string, args: any, timeoutMs = 60_000) {
    const result = await callCommand(name, args, timeoutMs);
    if (!result?.ok) throw new Error(result?.error || "command failed");
    return result?.output || {};
  }

  async function openNodeDetails(id: string) {
    setNodeDetailsId(id);
    setNodeDetailsOpen(true);
  }

  function openAddNodeModal() {
    setCreatedNode(null);
    setNewNodeId("");
    setNewNodeToken("");
    setNodesStatus("");
    setAddNodeOpen(true);
  }

  function openAddFrpModal() {
    setNewProfileName("");
    setNewProfileAddr("");
    setNewProfilePort(7000);
    setNewProfileToken("");
    setProfilesStatus("");
    setAddFrpOpen(true);
  }

  async function refreshServerDirs() {
    if (!selected) return;
    setServerDirsStatus("Loading...");
    try {
      const out = await callOkCommand("fs_list", { path: "" }, 30_000);
      const dirs = (out.entries || [])
        .filter((e: any) => e?.isDir && e?.name && !String(e.name).startsWith("."))
        .map((e: any) => String(e.name));
      dirs.sort((a: string, b: string) => a.localeCompare(b));
      setServerDirs(dirs);
      setServerDirsStatus("");
    } catch (e: any) {
      setServerDirs([]);
      setServerDirsStatus(String(e?.message || e));
    }
  }

  async function applyServerPort(instance: string, port: number) {
    const p = Math.round(Number(port || 0));
    if (!Number.isFinite(p) || p < 1 || p > 65535) throw new Error("port invalid (1-65535)");
    const path = joinRelPath(instance, "server.properties");

    let cur = "";
    try {
      const out = await callOkCommand("fs_read", { path }, 10_000);
      cur = b64DecodeUtf8(String(out.b64 || ""));
    } catch {
      cur = "";
    }

    const next = upsertProp(cur, "server-port", String(p));
    await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(next) }, 10_000);
  }

  async function writeInstanceConfig(inst: string, cfg: any) {
    const cleanInst = String(inst || "").trim();
    if (!cleanInst) throw new Error("instance_id 不能为空");
    const jar = normalizeJarPath(cleanInst, String(cfg?.jar_path ?? jarPath));
    const java = String(cfg?.java_path ?? javaPath).trim();
    const gamePortRaw = Math.round(Number(cfg?.game_port ?? gamePort));
    const gamePortVal = Number.isFinite(gamePortRaw) && gamePortRaw >= 1 && gamePortRaw <= 65535 ? gamePortRaw : 25565;
    const frpRemoteRaw = Math.round(Number(cfg?.frp_remote_port ?? frpRemotePort));
    const frpRemoteVal = Number.isFinite(frpRemoteRaw) && frpRemoteRaw >= 0 && frpRemoteRaw <= 65535 ? frpRemoteRaw : 0;
    const payload = {
      jar_path: jar,
      ...(java ? { java_path: java } : {}),
      game_port: gamePortVal,
      xms: String(cfg?.xms ?? xms).trim(),
      xmx: String(cfg?.xmx ?? xmx).trim(),
      enable_frp: !!(cfg?.enable_frp ?? enableFrp),
      frp_profile_id: String(cfg?.frp_profile_id ?? frpProfileId),
      frp_remote_port: frpRemoteVal,
      updated_at_unix: Math.floor(Date.now() / 1000),
    };
    const path = joinRelPath(cleanInst, INSTANCE_CONFIG_NAME);
    await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(JSON.stringify(payload, null, 2) + "\n") }, 10_000);
  }

  function closeConfirm(ok: boolean) {
    setConfirmOpen(false);
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    if (resolve) resolve(ok);
  }

  async function confirmDialog(
    message: string,
    opts: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}
  ) {
    const msg = String(message || "");
    if (!msg) return false;
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmTitle(opts.title || "Confirm");
      setConfirmMessage(msg);
      setConfirmDanger(!!opts.danger);
      setConfirmConfirmLabel(opts.confirmLabel || (opts.danger ? "Delete" : "OK"));
      setConfirmCancelLabel(opts.cancelLabel || "Cancel");
      setConfirmOpen(true);
    });
  }

  function openCopyModal(text: string) {
    setCopyValue(String(text || ""));
    setCopyOpen(true);
  }

  async function copyText(text: string) {
    const t = String(text || "");
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setServerOpStatus("Copied");
      return;
    } catch {
      // ignore
    }
    openCopyModal(t);
  }

  // Daemon polling
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await apiFetch("/api/daemons", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || "failed");
        setDaemons(json.daemons || []);
        if (!selected && (json.daemons || []).length > 0) setSelected(json.daemons[0].id);
        setError("");
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      }
    }
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selected, authed]);

  // UI host (used for nicer socket display on local/LAN deployments).
  useEffect(() => {
    try {
      setUiHost(window.location.hostname || "");
    } catch {
      // ignore
    }
  }, []);

  // Server dirs polling (only when useful)
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function tickServers() {
      if (!selected) return;
      try {
        const out = await callOkCommand("fs_list", { path: "" }, 30_000);
        if (cancelled) return;
        const dirs = (out.entries || [])
          .filter((e: any) => e?.isDir && e?.name && !String(e.name).startsWith("."))
          .map((e: any) => String(e.name));
        dirs.sort((a: string, b: string) => a.localeCompare(b));
        setServerDirs(dirs);
        setServerDirsStatus("");
      } catch (e: any) {
        if (cancelled) return;
        setServerDirs([]);
        setServerDirsStatus(String(e?.message || e));
      }
    }
    if (tab === "games") {
      tickServers();
      const t = setInterval(tickServers, 5000);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [tab, selected, authed]);

  // Keep selected game valid when the installed list changes.
  useEffect(() => {
    if (tab !== "games") return;
    if (!serverDirs.length) {
      if (instanceId) setInstanceId("");
      return;
    }
    if (!instanceId || !serverDirs.includes(instanceId)) setInstanceId(serverDirs[0]);
  }, [tab, serverDirs, instanceId]);

  // Try to prefill server port from server.properties when instance changes.
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function loadPort() {
      const inst = instanceId.trim();
      if (!selected || !inst) return;
      try {
        const out = await callOkCommand("fs_read", { path: joinRelPath(inst, "server.properties") }, 10_000);
        if (cancelled) return;
        const text = b64DecodeUtf8(String(out.b64 || ""));
        const v = getPropValue(text, "server-port");
        if (!v) return;
        const p = Number(v);
        if (Number.isFinite(p) && p >= 1 && p <= 65535) setGamePort(p);
      } catch {
        // ignore
      }
    }
    if (tab === "games") loadPort();
    return () => {
      cancelled = true;
    };
  }, [tab, selected, instanceId, authed]);

  // Load per-instance settings from servers/<instance_id>/.elegantmc.json (best-effort).
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function loadCfg() {
      const inst = instanceId.trim();
      if (!selected || !inst) return;
      try {
        const out = await callOkCommand("fs_read", { path: joinRelPath(inst, INSTANCE_CONFIG_NAME) }, 10_000);
        if (cancelled) return;
        const raw = b64DecodeUtf8(String(out.b64 || ""));
        const cfg = raw ? JSON.parse(raw) : null;
        if (!cfg || typeof cfg !== "object") return;
        const c: any = cfg;
        if (typeof c.jar_path === "string" && c.jar_path.trim()) setJarPath(normalizeJarPath(inst, c.jar_path));
        if (typeof c.java_path === "string") setJavaPath(c.java_path);
        if (typeof c.xms === "string" && c.xms.trim()) setXms(c.xms);
        if (typeof c.xmx === "string" && c.xmx.trim()) setXmx(c.xmx);
        if (typeof c.enable_frp === "boolean") setEnableFrp(c.enable_frp);
        if (typeof c.frp_profile_id === "string") setFrpProfileId(c.frp_profile_id);
        if (Number.isFinite(Number(c.frp_remote_port))) setFrpRemotePort(Number(c.frp_remote_port));
        if (Number.isFinite(Number(c.game_port))) setGamePort(Number(c.game_port));
      } catch {
        // ignore
      }
    }
    if (tab === "games") loadCfg();
    return () => {
      cancelled = true;
    };
  }, [tab, selected, instanceId, authed]);

  // Switching games should exit edit mode to avoid mixing settings between instances.
  useEffect(() => {
    if (tab !== "games") return;
    setSettingsOpen(false);
    setSettingsSnapshot(null);
    setServerOpStatus("");
    setConsoleLine("");
    // Reset to defaults, then load per-instance config/props best-effort.
    setJarPath("server.jar");
    setJavaPath("");
    setGamePort(25565);
    setXms("1G");
    setXmx("2G");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  // Nodes polling (only when needed)
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function tickNodes() {
      try {
        const res = await apiFetch("/api/nodes", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || "failed");
        setNodes(json.nodes || []);
        setNodesStatus("");
      } catch (e: any) {
        if (cancelled) return;
        setNodes([]);
        setNodesStatus(String(e?.message || e));
      }
    }
    if (tab === "nodes") {
      tickNodes();
      const t = setInterval(tickNodes, 4000);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [tab, authed]);

  // Logs polling (only when useful)
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function tickLogs() {
      if (!selected) return;
      try {
        const res = await apiFetch(`/api/daemons/${encodeURIComponent(selected)}/logs?limit=300`, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) setLogs(json.logs || []);
      } catch {
        // ignore
      }
    }
    if (tab === "games" || tab === "advanced" || installOpen) {
      tickLogs();
      const t = setInterval(tickLogs, 1500);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [selected, tab, installOpen, authed]);

  // Load Vanilla versions list (server-side fetch; avoids CORS)
  useEffect(() => {
    let cancelled = false;
    async function loadVersions() {
      setVersionsStatus("Loading...");
      try {
        const res = await fetch("/api/mc/versions", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || "failed");
        setVersions(json.versions || []);
        setVersionsStatus("");
      } catch (e: any) {
        if (cancelled) return;
        setVersions([]);
        setVersionsStatus(String(e?.message || e));
      }
    }
    loadVersions();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshProfiles() {
    setProfilesStatus("Loading...");
    try {
      const res = await apiFetch("/api/frp/profiles", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "failed");
      const list = (json.profiles || []) as FrpProfile[];
      setProfiles(list);
      if (!frpProfileId && list.length) setFrpProfileId(list[0].id);
      if (frpProfileId && !list.find((p) => p.id === frpProfileId)) setFrpProfileId(list[0]?.id || "");
      setProfilesStatus("");
    } catch (e: any) {
      setProfiles([]);
      setProfilesStatus(String(e?.message || e));
    }
  }

  useEffect(() => {
    if (authed !== true) return;
    refreshProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Files listing
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function refresh() {
      if (!selected) return;
      setFsStatus("Loading...");
      try {
        const payload = await callOkCommand("fs_list", { path: fsPath });
        if (cancelled) return;
        setFsEntries(payload.entries || []);
        setFsStatus("");
      } catch (e: any) {
        if (cancelled) return;
        setFsEntries([]);
        setFsStatus(String(e?.message || e));
      }
    }
    if (tab === "files") refresh();
    return () => {
      cancelled = true;
    };
  }, [selected, fsPath, tab]);

  async function refreshFsNow(pathOverride?: string) {
    if (!selected) return;
    const p = pathOverride != null ? String(pathOverride) : fsPath;
    setFsStatus("Loading...");
    try {
      const payload = await callOkCommand("fs_list", { path: p });
      setFsEntries(payload.entries || []);
      setFsStatus("");
    } catch (e: any) {
      setFsEntries([]);
      setFsStatus(String(e?.message || e));
    }
  }

	  async function deleteFsEntry(entry: any) {
	    const name = String(entry?.name || "");
	    if (!name) return;
	    const isDir = !!entry?.isDir;
	    const target = joinRelPath(fsPath, name);
	    const label = isDir ? `folder ${target} (recursive)` : `file ${target}`;
	    const ok = await confirmDialog(`Delete ${label}?`, { title: "Delete", confirmLabel: "Delete", danger: true });
	    if (!ok) return;

	    setFsStatus(`Deleting ${target} ...`);
	    try {
	      await callOkCommand("fs_delete", { path: target }, 60_000);
      if (fsSelectedFile === target || fsSelectedFile.startsWith(`${target}/`)) {
        setFsSelectedFile("");
        setFsFileText("");
      }
      await refreshFsNow();
      setFsStatus("Deleted");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function openEntry(entry: any) {
    const name = entry?.name || "";
    if (!name) return;
    if (entry?.isDir) {
      setFsSelectedFile("");
      setFsFileText("");
      setFsPath(joinRelPath(fsPath, name));
      return;
    }
    const size = Number(entry?.size || 0);
    const lower = String(name).toLowerCase();
    const filePath = joinRelPath(fsPath, name);
    if (size > 512 * 1024 || lower.endsWith(".jar") || lower.endsWith(".zip")) {
      setFsSelectedFile(filePath);
      setFsFileText("");
      setFsStatus("Binary/large file: not opened in editor");
      return;
    }
    setFsStatus(`Reading ${filePath} ...`);
    try {
      const payload = await callOkCommand("fs_read", { path: filePath });
      const text = b64DecodeUtf8(payload.b64 || "");
      setFsSelectedFile(filePath);
      setFsFileText(text);
      setFsStatus("");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function saveFile() {
    if (!fsSelectedFile) {
      setFsStatus("No file selected");
      return;
    }
    setFsStatus(`Saving ${fsSelectedFile} ...`);
    try {
      await callOkCommand("fs_write", { path: fsSelectedFile, b64: b64EncodeUtf8(fsFileText) });
      setFsStatus("Saved");
      setTimeout(() => setFsStatus(""), 800);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function uploadSelectedFile() {
    if (!uploadFile) {
      setUploadStatus("请选择文件");
      return;
    }
    if (!selected) {
      setUploadStatus("请选择 Daemon");
      return;
    }

    const file = uploadFile;
    const destPath = joinRelPath(fsPath, file.name);
    const chunkSize = 256 * 1024; // 256KB

    let uploadID = "";
    setUploadStatus(`Begin: ${destPath} (${file.size} bytes)`);

    try {
      const begin = await callOkCommand("fs_upload_begin", { path: destPath });
      uploadID = String(begin.upload_id || "");
      if (!uploadID) throw new Error("upload_id missing");

      for (let off = 0; off < file.size; off += chunkSize) {
        const end = Math.min(off + chunkSize, file.size);
        const ab = await file.slice(off, end).arrayBuffer();
        const b64 = b64EncodeBytes(new Uint8Array(ab));
        await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 });
        setUploadStatus(`Uploading ${destPath}: ${end}/${file.size} bytes`);
      }

      const commit = await callOkCommand("fs_upload_commit", { upload_id: uploadID });
      setUploadStatus(`Done: ${commit.path || destPath} (${commit.bytes || file.size} bytes)`);
      setUploadFile(null);
      setUploadInputKey((k) => k + 1);

      try {
        const payload = await callOkCommand("fs_list", { path: fsPath });
        setFsEntries(payload.entries || []);
      } catch {
        // ignore
      }
    } catch (e: any) {
      if (uploadID) {
        try {
          await callOkCommand("fs_upload_abort", { upload_id: uploadID });
        } catch {
          // ignore
        }
      }
      setUploadStatus(`Upload failed: ${String(e?.message || e)}`);
    }
  }

  function suggestInstanceId(existing: string[]) {
    const set = new Set((existing || []).map((v) => String(v || "").trim()).filter(Boolean));
    for (let i = 1; i <= 999; i++) {
      const id = `server${i}`;
      if (!set.has(id)) return id;
    }
    return `server-${Math.floor(Date.now() / 1000)}`;
  }

  function openInstallModal() {
    const suggested = suggestInstanceId(serverDirs);
    const jarName = normalizeJarName(jarPath);
    const profileId =
      profiles.find((p) => p.id === frpProfileId)?.id || profiles[0]?.id || "";
    setInstallForm((prev) => ({
      instanceId: suggested,
      kind: prev?.kind === "paper" ? "paper" : "vanilla",
      version: String(prev?.version || "1.20.1"),
      paperBuild: Number.isFinite(Number(prev?.paperBuild)) ? Number(prev?.paperBuild) : 0,
      xms,
      xmx,
      gamePort,
      jarName,
      javaPath,
      acceptEula: prev?.acceptEula ?? true,
      enableFrp,
      frpProfileId: profileId,
      frpRemotePort,
    }));
    setInstallStartUnix(0);
    setInstallInstance("");
    setInstallOpen(true);
  }

  async function runInstall(andStart: boolean) {
    setServerOpStatus("");
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const inst = installForm.instanceId.trim();
    if (!inst) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }
    const ver = String(installForm.version || "").trim();
    if (!ver) {
      setServerOpStatus("version 不能为空");
      return;
    }

    setInstallInstance(inst);
    setInstallStartUnix(Math.floor(Date.now() / 1000));
    setInstallRunning(true);

    try {
      const jarName = normalizeJarName(installForm.jarName);
      const kind = installForm.kind === "paper" ? "paper" : "vanilla";
      const build = Math.round(Number(installForm.paperBuild || 0));
      const cmdName = kind === "paper" ? "mc_install_paper" : "mc_install_vanilla";
      setServerOpStatus(
        kind === "paper" && build > 0 ? `Installing Paper ${ver} (build ${build}) ...` : `Installing ${kind === "paper" ? "Paper" : "Vanilla"} ${ver} ...`
      );
      const out = await callOkCommand(
        cmdName,
        {
          instance_id: inst,
          version: ver,
          ...(kind === "paper" ? { build: Number.isFinite(build) ? build : 0 } : {}),
          jar_name: jarName,
          accept_eula: !!installForm.acceptEula,
        },
        10 * 60_000
      );
      const installedJar = String(out.jar_path || jarName);

      // Apply port right after install so the server listens on the expected port.
      await applyServerPort(inst, installForm.gamePort);

      // Refresh installed games list.
      await refreshServerDirs();

      setInstanceId(inst);
      setJarPath(installedJar);
      setJavaPath(String(installForm.javaPath || "").trim());
      setGamePort(installForm.gamePort);
      setXms(installForm.xms);
      setXmx(installForm.xmx);
      setEnableFrp(!!installForm.enableFrp);
      setFrpProfileId(installForm.frpProfileId);
      setFrpRemotePort(installForm.frpRemotePort);
      setSettingsOpen(false);
      setSettingsSnapshot(null);
      await writeInstanceConfig(inst, {
        jar_path: installedJar,
        java_path: String(installForm.javaPath || "").trim(),
        game_port: installForm.gamePort,
        xms: installForm.xms,
        xmx: installForm.xmx,
        enable_frp: !!installForm.enableFrp,
        frp_profile_id: installForm.frpProfileId,
        frp_remote_port: installForm.frpRemotePort,
      });

      setServerOpStatus(`Installed: ${installedJar}`);
      if (andStart) {
        await startServer(inst, {
          jarPath: installedJar,
          javaPath: String(installForm.javaPath || "").trim(),
          gamePort: installForm.gamePort,
          xms: installForm.xms,
          xmx: installForm.xmx,
          enableFrp: !!installForm.enableFrp,
          frpProfileId: installForm.frpProfileId,
          frpRemotePort: installForm.frpRemotePort,
        });
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setInstallRunning(false);
    }
  }

  function openSettingsModal() {
    if (!instanceId.trim()) return;
    setSettingsSnapshot({
      jarPath,
      javaPath,
      gamePort,
      xms,
      xmx,
      enableFrp,
      frpProfileId,
      frpRemotePort,
    });
    setSettingsOpen(true);
    setServerOpStatus("");
  }

  function cancelEditSettings() {
    if (settingsSnapshot) {
      setJarPath(settingsSnapshot.jarPath);
      setJavaPath(settingsSnapshot.javaPath);
      setGamePort(settingsSnapshot.gamePort);
      setXms(settingsSnapshot.xms);
      setXmx(settingsSnapshot.xmx);
      setEnableFrp(settingsSnapshot.enableFrp);
      setFrpProfileId(settingsSnapshot.frpProfileId);
      setFrpRemotePort(settingsSnapshot.frpRemotePort);
    }
    setSettingsOpen(false);
    setSettingsSnapshot(null);
    setServerOpStatus("");
  }

  async function saveEditSettings() {
    setServerOpStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error("daemon offline");
      const inst = instanceId.trim();
      if (!inst) throw new Error("instance_id 不能为空");
      await applyServerPort(inst, gamePort);
      await writeInstanceConfig(inst, {});
      setSettingsOpen(false);
      setSettingsSnapshot(null);
      setServerOpStatus("Saved");
      setTimeout(() => setServerOpStatus(""), 900);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

  async function startServer(instanceOverride?: string, override?: StartOverride) {
    setServerOpStatus("");
    setFrpOpStatus("");
    try {
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setServerOpStatus("instance_id 不能为空");
        return;
      }

      const portRaw = override?.gamePort ?? gamePort;
      const port = Math.round(Number(portRaw || 25565));

      // Ensure server.properties has the selected port before first start.
      await applyServerPort(inst, port);

      const jar = normalizeJarPath(inst, String(override?.jarPath ?? jarPath));
      const xmsVal = String(override?.xms ?? xms);
      const xmxVal = String(override?.xmx ?? xmx);
      const java = String(override?.javaPath ?? javaPath).trim();
      const enable = !!(override?.enableFrp ?? enableFrp);
      const pid = String(override?.frpProfileId ?? frpProfileId);
      const remotePort = Math.round(Number(override?.frpRemotePort ?? frpRemotePort ?? 0));

      await writeInstanceConfig(inst, {
        jar_path: jar,
        ...(java ? { java_path: java } : {}),
        game_port: port,
        xms: xmsVal,
        xmx: xmxVal,
        enable_frp: enable,
        frp_profile_id: pid,
        frp_remote_port: Number.isFinite(remotePort) ? remotePort : 0,
      });

      await callOkCommand(
        "mc_start",
        { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms: xmsVal, xmx: xmxVal },
        30_000
      );
      setServerOpStatus("MC started");

      if (enable) {
        const profile = profiles.find((p) => p.id === pid) || null;
        if (!profile) {
          setFrpOpStatus("FRP enabled but no profile selected");
          return;
        }
        const args: any = {
          name: "mc",
          server_addr: profile.server_addr,
          server_port: Number(profile.server_port),
          token: profile.token || "",
          local_port: port,
          remote_port: Number.isFinite(remotePort) ? remotePort : 0,
        };
        await callOkCommand("frp_start", args, 30_000);
        setFrpOpStatus("FRP started");
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

  async function stopServer(instanceOverride?: string) {
    setServerOpStatus("");
    try {
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setServerOpStatus("instance_id 不能为空");
        return;
      }
      if (enableFrp) {
        try {
          await callOkCommand("frp_stop", {});
          setFrpOpStatus("FRP stopped");
        } catch {
          // ignore
        }
      }
      await callOkCommand("mc_stop", { instance_id: inst }, 30_000);
      setServerOpStatus("MC stopped");
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

	  async function deleteServer(instanceOverride?: string) {
	    setServerOpStatus("");
	    try {
	      const id = String(instanceOverride ?? instanceId).trim();
	      if (!id) {
	        setServerOpStatus("instance_id 不能为空");
	        return;
	      }
	      const ok = await confirmDialog(`Delete server ${id}? This will remove its folder under servers/`, {
	        title: "Delete Server",
	        confirmLabel: "Delete",
	        danger: true,
	      });
	      if (!ok) return;

	      if (enableFrp) {
	        try {
	          await callOkCommand("frp_stop", {});
	          setFrpOpStatus("FRP stopped");
        } catch {
          // ignore
        }
      }
      try {
        await callOkCommand("mc_stop", { instance_id: id }, 30_000);
      } catch {
        // ignore
      }
      await callOkCommand("mc_delete", { instance_id: id }, 60_000);
      setServerOpStatus(`Deleted: ${id}`);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

  async function restartServer(instanceOverride?: string) {
    setServerOpStatus("");
    try {
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setServerOpStatus("instance_id 不能为空");
        return;
      }
      await applyServerPort(inst, gamePort);
      const jar = normalizeJarPath(inst, jarPath);
      const java = String(javaPath || "").trim();
      await writeInstanceConfig(inst, { jar_path: jar, ...(java ? { java_path: java } : {}), game_port: gamePort });
      await callOkCommand("mc_restart", { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms, xmx }, 60_000);
      setServerOpStatus("MC restarted");
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

  async function sendConsoleLine() {
    if (!consoleLine.trim()) return;
    try {
      await callOkCommand("mc_console", { instance_id: instanceId.trim(), line: consoleLine.trim() }, 10_000);
      setConsoleLine("");
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    }
  }

  async function addFrpProfile() {
    setProfilesStatus("");
    try {
      const res = await apiFetch("/api/frp/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProfileName,
          server_addr: newProfileAddr,
          server_port: newProfilePort,
          token: newProfileToken,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "failed");
      setNewProfileName("");
      setNewProfileAddr("");
      setNewProfilePort(7000);
      setNewProfileToken("");
      await refreshProfiles();
      setProfilesStatus("Saved");
      setTimeout(() => setProfilesStatus(""), 800);
      setAddFrpOpen(false);
    } catch (e: any) {
      setProfilesStatus(String(e?.message || e));
    }
  }

  async function removeFrpProfile(id: string) {
    setProfilesStatus("");
    try {
      const res = await apiFetch(`/api/frp/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "failed");
      await refreshProfiles();
    } catch (e: any) {
      setProfilesStatus(String(e?.message || e));
    }
  }

  async function runAdvancedCommand() {
    setError("");
    setCmdResult(null);
    if (!selected) {
      setError("请选择一个 Daemon");
      return;
    }
    let argsObj: any = {};
    try {
      argsObj = cmdArgs ? JSON.parse(cmdArgs) : {};
    } catch {
      setError("args 不是合法 JSON");
      return;
    }
    try {
      const result = await callCommand(cmdName, argsObj, 30_000);
      setCmdResult(result);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "nodes", label: "Nodes" },
    { id: "games", label: "Games" },
    { id: "frp", label: "FRP" },
    { id: "files", label: "Files" },
    { id: "advanced", label: "Advanced" },
  ];

  const activeTab = useMemo(() => tabs.find((t) => t.id === tab) || tabs[0], [tab]);

  const appCtxValue = {
    tab,
    setTab,
    daemons,
    selected,
    setSelected,
    selectedDaemon,

    // Nodes
    nodes,
    setNodes,
    nodesStatus,
    setNodesStatus,
    openNodeDetails,
    openAddNodeModal,

    // Games
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceId,
    setInstanceId,
    openSettingsModal,
    openInstallModal,
    startServer,
    stopServer,
    restartServer,
    deleteServer,
    frpOpStatus,
    serverOpStatus,
    instanceStatus,
    frpStatus,
    localHost,
    gamePort,
    enableFrp,
    selectedProfile,
    frpRemotePort,
    logView,
    setLogView,
    logs,
    consoleLine,
    setConsoleLine,
    sendConsoleLine,

    // FRP
    profiles,
    profilesStatus,
    setProfilesStatus,
    refreshProfiles,
    openAddFrpModal,
    removeFrpProfile,
    setEnableFrp,
    setFrpProfileId,

    // Files
    fsPath,
    setFsPath,
    fsBreadcrumbs,
    fsStatus,
    fsEntries,
    fsSelectedFile,
    setFsSelectedFile,
    fsFileText,
    setFsFileText,
    openEntry,
    saveFile,
    uploadInputKey,
    uploadFile,
    setUploadFile,
    uploadSelectedFile,
    uploadStatus,
    refreshFsNow,
    deleteFsEntry,

    // Advanced
    cmdName,
    setCmdName,
    cmdArgs,
    setCmdArgs,
    cmdResult,
    runAdvancedCommand,

	    // Helpers
	    apiFetch,
	    copyText,
	    confirmDialog,
	    maskToken,
	    pct,
	    fmtUnix,
	    fmtBytes,
	    joinRelPath,
	    parentRelPath,
	  };

  return (
    <AppCtxProvider value={appCtxValue}>
      {authed !== true ? (
        <div className="modalOverlay">
          <div className="modal" style={{ width: "min(560px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>Admin Login</div>
                <div className="hint">
                  Set <code>ELEGANTMC_PANEL_ADMIN_PASSWORD</code> in your env (docker: <code>.env</code>). If you did not set it, check
                  the Panel logs for the generated password.
                </div>
              </div>
            </div>

            <form
              className="grid2"
              onSubmit={(e) => {
                e.preventDefault();
                login();
              }}
              style={{ alignItems: "end" }}
            >
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  autoFocus
                />
                {loginStatus ? <div className="hint">{loginStatus}</div> : authed === null ? <div className="hint">Checking session...</div> : null}
              </div>

              <div className="btnGroup" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
                <button className="primary" type="submit" disabled={!loginPassword.trim()}>
                  Login
                </button>
              </div>
            </form>
          </div>
        </div>
	      ) : null}

	      {confirmOpen ? (
	        <div className="modalOverlay" onClick={() => closeConfirm(false)}>
	          <div className="modal" style={{ width: "min(520px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>{confirmTitle}</div>
	                <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
	                  {confirmMessage}
	                </div>
	              </div>
	              <button type="button" onClick={() => closeConfirm(false)}>
	                Close
	              </button>
	            </div>
	            <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
	              <button type="button" onClick={() => closeConfirm(false)}>
	                {confirmCancelLabel}
	              </button>
	              <button type="button" className={confirmDanger ? "dangerBtn" : "primary"} onClick={() => closeConfirm(true)}>
	                {confirmConfirmLabel}
	              </button>
	            </div>
	          </div>
	        </div>
	      ) : null}

	      {copyOpen ? (
	        <div className="modalOverlay" onClick={() => setCopyOpen(false)}>
	          <div className="modal" style={{ width: "min(720px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>Copy</div>
	                <div className="hint">Clipboard API 不可用，请手动复制下面内容。</div>
	              </div>
	              <button type="button" onClick={() => setCopyOpen(false)}>
	                Close
	              </button>
	            </div>
	            <textarea
	              readOnly
	              value={copyValue}
	              rows={6}
	              style={{ width: "100%" }}
	              onFocus={(e) => e.currentTarget.select()}
	            />
	            <div className="btnGroup" style={{ marginTop: 10, justifyContent: "flex-end" }}>
	              <button
	                type="button"
	                className="primary"
	                onClick={async () => {
	                  try {
	                    await navigator.clipboard.writeText(copyValue);
	                    setServerOpStatus("Copied");
	                    setCopyOpen(false);
	                  } catch {
	                    // ignore
	                  }
	                }}
	              >
	                Try Copy
	              </button>
	            </div>
	          </div>
	        </div>
	      ) : null}

	      <div className="appShell">
	      <aside className="sidebar">
        <div className="sidebarHeader">
          <img className="logo" src="/logo.svg" alt="ElegantMC" />
          <div style={{ minWidth: 0 }}>
            <div className="brandName">ElegantMC</div>
            <div className="brandTagline">Remote Minecraft Server Manager</div>
          </div>
        </div>

        <nav className="nav">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`navItem ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              {t.id === "games" && instanceStatus?.running ? <span className="badge ok">running</span> : null}
              {t.id === "nodes" && nodes.length ? <span className="badge">{nodes.length}</span> : null}
            </button>
          ))}
        </nav>

	        <div className="sidebarFooter">
	          <div className="hint">Panel MVP · Daemon 出站连接 · Vanilla 安装 · FRP 配置复用 · 文件管理（沙箱）</div>
	          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
	            <span className={`badge ${authed === true ? "ok" : ""}`}>{authed === true ? "admin" : "locked"}</span>
	            {authed === true ? (
	              <button type="button" onClick={logout}>
	                Logout
	              </button>
	            ) : null}
	          </div>
	          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
	            <span className="muted">Theme</span>
	            <select value={themeMode} onChange={(e) => setThemeMode(e.target.value as ThemeMode)} style={{ width: 140 }}>
	              <option value="auto">Auto (System)</option>
	              <option value="light">Light</option>
	              <option value="dark">Dark</option>
	            </select>
	          </div>
	        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="topbarTitle">
            <div className="pageTitle">{activeTab.label}</div>
            <div className="pageSubtitle">
              daemon: <code>{selectedDaemon?.id || "-"}</code> ·{" "}
              {selectedDaemon?.connected ? <span>online</span> : <span>offline</span>} · last:{" "}
              {fmtUnix(selectedDaemon?.lastSeenUnix)}
            </div>
          </div>

	          <div className="row" style={{ alignItems: "flex-end" }}>
	            <div className="field" style={{ minWidth: 220 }}>
	              <label>Daemon</label>
	              <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={authed !== true}>
                {daemons.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} {d.connected ? "(online)" : "(offline)"}
                  </option>
                ))}
	              </select>
	            </div>
	            <span className={`statusDot ${selectedDaemon?.connected ? "ok" : ""}`} title={selectedDaemon?.connected ? "online" : "offline"} />
	          </div>
	        </div>

        <div className="content">
          {error ? (
            <div className="card danger">
              <b>错误：</b> {error}
            </div>
          ) : null}

          {installOpen ? (
            <div className="modalOverlay" onClick={() => (!installRunning ? setInstallOpen(false) : null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
	                  <div>
	                    <div style={{ fontWeight: 700 }}>Install</div>
	                    <div className="hint">
	                      node: <code>{selectedDaemon?.id || "-"}</code> · instance: <code>{installForm.instanceId.trim() || "-"}</code>
	                    </div>
	                  </div>
	                  <button type="button" onClick={() => setInstallOpen(false)} disabled={installRunning}>
	                    Close
	                  </button>
	                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
	                  <div className="field">
	                    <label>Instance ID</label>
	                    <input
	                      value={installForm.instanceId}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, instanceId: e.target.value }))}
	                      placeholder="my-server"
	                    />
	                    <div className="hint">建议：A-Z a-z 0-9 . _ -（最长 64）</div>
	                  </div>
	                  <div className="field">
	                    <label>Type</label>
	                    <select value={installForm.kind} onChange={(e) => setInstallForm((f) => ({ ...f, kind: e.target.value as any }))}>
	                      <option value="vanilla">Vanilla</option>
	                      <option value="paper">Paper</option>
	                    </select>
	                    <div className="hint">Paper 支持插件且性能更好；Vanilla 为官方原版</div>
	                  </div>

	                  <div className="field" style={{ gridColumn: installForm.kind === "paper" ? undefined : "1 / -1" }}>
	                    <label>Version</label>
	                    <input
	                      value={installForm.version}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, version: e.target.value }))}
	                      list="mc-versions"
	                      placeholder="1.20.1"
	                    />
                    <datalist id="mc-versions">
                      {versions.map((v) => (
                        <option key={`${v.id}-${v.type || ""}`} value={v.id}>
                          {v.type || ""}
                        </option>
                      ))}
                    </datalist>
                    {versionsStatus ? <div className="hint">版本列表：{versionsStatus}</div> : <div className="hint">可直接手输任意版本号</div>}
                  </div>
                  {installForm.kind === "paper" ? (
                    <div className="field">
                      <label>Paper Build (optional)</label>
                      <input
                        type="number"
                        value={Number.isFinite(installForm.paperBuild) ? installForm.paperBuild : 0}
                        onChange={(e) => setInstallForm((f) => ({ ...f, paperBuild: Number(e.target.value) }))}
                        placeholder="0 (latest)"
                        min={0}
                      />
                      <div className="hint">填 0 表示下载最新 build</div>
                    </div>
                  ) : null}

	                  <div className="field">
	                    <label>Memory</label>
	                    <div className="row">
	                      <input
	                        value={installForm.xms}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, xms: e.target.value }))}
	                        placeholder="Xms (e.g. 1G)"
	                      />
	                      <input
	                        value={installForm.xmx}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, xmx: e.target.value }))}
	                        placeholder="Xmx (e.g. 2G)"
	                      />
	                    </div>
	                  </div>
	                  <div className="field">
	                    <label>Game Port</label>
	                    <input
	                      type="number"
	                      value={Number.isFinite(installForm.gamePort) ? installForm.gamePort : 25565}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, gamePort: Number(e.target.value) }))}
	                      placeholder="25565"
	                      min={1}
	                      max={65535}
	                    />
	                    <div className="hint">写入 server.properties 的 server-port（Docker 默认映射 25565-25600）</div>
	                  </div>

	                  <div className="field">
	                    <label>Jar name</label>
	                    <input
	                      value={installForm.jarName}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, jarName: e.target.value }))}
	                      placeholder="server.jar"
	                    />
	                  </div>
	                  <div className="field">
	                    <label>Java (optional)</label>
	                    <input
	                      value={installForm.javaPath}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, javaPath: e.target.value }))}
	                      placeholder="java / /opt/jdk21/bin/java"
	                    />
	                    <div className="hint">留空则由 Daemon 自动选择（推荐）</div>
	                  </div>
	                  <div className="field">
	                    <label>EULA</label>
	                    <label className="checkRow">
	                      <input
	                        type="checkbox"
	                        checked={!!installForm.acceptEula}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, acceptEula: e.target.checked }))}
	                      />
	                      自动写入 eula.txt（推荐）
	                    </label>
	                  </div>

	                  <div className="field">
	                    <label>FRP (optional)</label>
	                    <label className="checkRow">
	                      <input
	                        type="checkbox"
	                        checked={!!installForm.enableFrp}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, enableFrp: e.target.checked }))}
	                      />
	                      安装完成后启动时自动开启 FRP
	                    </label>
	                  </div>
	                  <div className="field">
	                    <label>FRP Remote Port</label>
	                    <input
	                      type="number"
	                      value={Number.isFinite(installForm.frpRemotePort) ? installForm.frpRemotePort : 0}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, frpRemotePort: Number(e.target.value) }))}
	                      placeholder="25566"
	                      min={0}
	                      max={65535}
	                      disabled={!installForm.enableFrp}
	                    />
	                    <div className="hint">填 0 表示不指定（由 FRP 服务端策略分配）</div>
	                  </div>
	                  <div className="field" style={{ gridColumn: "1 / -1" }}>
	                    <label>FRP Server</label>
	                    <select
	                      value={installForm.frpProfileId}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, frpProfileId: e.target.value }))}
	                      disabled={!installForm.enableFrp || !profiles.length}
	                    >
	                      {profiles.map((p) => (
	                        <option key={p.id} value={p.id}>
	                          {p.name} ({p.server_addr}:{p.server_port})
	                        </option>
	                      ))}
	                    </select>
                    <div className="hint">
                      没有可用服务器？去{" "}
                      <button className="linkBtn" onClick={() => setTab("frp")}>
                        FRP
                      </button>{" "}
                      添加（不会关闭此窗口）
                    </div>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <button className="primary" onClick={() => runInstall(false)} disabled={!selectedDaemon?.connected || installRunning}>
                    Install
                  </button>
                  <button className="primary" onClick={() => runInstall(true)} disabled={!selectedDaemon?.connected || installRunning}>
                    Install & Start
                  </button>
                  <button
                    type="button"
	                    onClick={() => {
	                      setInstallStartUnix(0);
	                      setInstallInstance(installForm.instanceId.trim());
	                    }}
                    disabled={installRunning}
                  >
                    Reset Logs
                  </button>
                  {installRunning ? <span className="badge">installing…</span> : null}
                  {serverOpStatus ? <span className="muted">{serverOpStatus}</span> : null}
                </div>

                <h3 style={{ marginTop: 12 }}>Install Logs</h3>
                <pre style={{ maxHeight: 360, overflow: "auto" }}>
                  {logs
                    .filter((l) => {
                      if (l.source !== "install") return false;
                      if (installInstance && l.instance !== installInstance) return false;
                      if (installStartUnix > 0 && (l.ts_unix || 0) < installStartUnix - 1) return false;
                      return true;
                    })
                    .slice(-500)
                    .map((l) => {
                      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
                      return `[${ts}] ${l.line || ""}`;
                    })
                    .join("\n") || "<no install logs>"}
                </pre>
              </div>
            </div>
          ) : null}

          {settingsOpen ? (
            <div className="modalOverlay" onClick={cancelEditSettings}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 700 }}>Settings</div>
                    <div className="hint">
                      game: <code>{instanceId.trim() || "-"}</code>
                    </div>
                    <div className="hint">
                      saved: <code>{joinRelPath(instanceId.trim() || ".", INSTANCE_CONFIG_NAME)}</code>
                    </div>
                  </div>
                  <button type="button" onClick={cancelEditSettings}>
                    Close
                  </button>
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  <div className="field">
                    <label>Jar path (relative)</label>
                    <input value={jarPath} onChange={(e) => setJarPath(e.target.value)} placeholder="server.jar" />
                  </div>
                  <div className="field">
                    <label>Java (optional)</label>
                    <input value={javaPath} onChange={(e) => setJavaPath(e.target.value)} placeholder="java / /opt/jdk21/bin/java" />
                    <div className="hint">留空则由 Daemon 自动选择（推荐）</div>
                  </div>
                  <div className="field">
                    <label>Memory</label>
                    <div className="row">
                      <input value={xms} onChange={(e) => setXms(e.target.value)} placeholder="Xms (e.g. 1G)" />
                      <input value={xmx} onChange={(e) => setXmx(e.target.value)} placeholder="Xmx (e.g. 2G)" />
                    </div>
                  </div>
                  <div className="field">
                    <label>Port</label>
                    <input
                      type="number"
                      value={Number.isFinite(gamePort) ? gamePort : 25565}
                      onChange={(e) => setGamePort(Number(e.target.value))}
                      min={1}
                      max={65535}
                    />
                    <div className="hint">保存后会写入 server.properties（运行中需要重启生效）</div>
                  </div>

                  <div className="field">
                    <label>FRP</label>
                    <label className="checkRow">
                      <input type="checkbox" checked={enableFrp} onChange={(e) => setEnableFrp(e.target.checked)} />
                      启动时自动开启
                    </label>
                  </div>
                  <div className="field">
                    <label>FRP Remote Port</label>
                    <input
                      type="number"
                      value={Number.isFinite(frpRemotePort) ? frpRemotePort : 0}
                      onChange={(e) => setFrpRemotePort(Number(e.target.value))}
                      placeholder="25566"
                      min={0}
                      max={65535}
                      disabled={!enableFrp}
                    />
                    <div className="hint">填 0 表示不指定（由 FRP 服务端策略分配）</div>
                  </div>
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label>FRP Server</label>
                    <select value={frpProfileId} onChange={(e) => setFrpProfileId(e.target.value)} disabled={!enableFrp || !profiles.length}>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.server_addr}:{p.server_port})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <button className="primary" type="button" onClick={saveEditSettings} disabled={!selectedDaemon?.connected || !instanceId.trim()}>
                    Save
                  </button>
                  <button type="button" onClick={cancelEditSettings}>
                    Cancel
                  </button>
                  {serverOpStatus ? <span className="muted">{serverOpStatus}</span> : null}
                </div>
              </div>
            </div>
          ) : null}

	      {nodeDetailsOpen ? (
	        <div className="modalOverlay" onClick={() => setNodeDetailsOpen(false)}>
	          <div className="modal" onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 700 }}>Node Details</div>
	                <div className="hint">
	                  node: <code>{nodeDetailsId || "-"}</code>
	                </div>
	              </div>
	              <button type="button" onClick={() => setNodeDetailsOpen(false)}>
	                Close
	              </button>
	            </div>

	            {nodeDetailsNode ? (
	              <>
	                <div className="grid2" style={{ marginBottom: 12 }}>
	                  <div className="card">
                    <h3>Overview</h3>
                    <div className="row">
                      {nodeDetailsNode.connected ? <span className="badge ok">online</span> : <span className="badge">offline</span>}
                      <span className="badge">last: {fmtUnix(nodeDetailsNode.lastSeenUnix)}</span>
                    </div>
                    <div className="hint" style={{ marginTop: 8 }}>
                      {nodeDetailsNode.hello?.os ? `os: ${nodeDetailsNode.hello.os}` : ""}
                      {nodeDetailsNode.hello?.arch ? ` · arch: ${nodeDetailsNode.hello.arch}` : ""}
                    </div>
	                    <div className="hint" style={{ marginTop: 8 }}>
	                      CPU:{" "}
	                      {typeof nodeDetailsNode.heartbeat?.cpu?.usage_percent === "number"
	                        ? `${nodeDetailsNode.heartbeat.cpu.usage_percent.toFixed(1)}%`
	                        : "-"}
	                      {" · "}
	                      MEM:{" "}
	                      {nodeDetailsNode.heartbeat?.mem?.total_bytes
	                        ? `${pct(nodeDetailsNode.heartbeat.mem.used_bytes, nodeDetailsNode.heartbeat.mem.total_bytes).toFixed(0)}%`
	                        : "-"}
	                      {" · "}
	                      DISK:{" "}
	                      {nodeDetailsNode.heartbeat?.disk?.total_bytes
	                        ? `${pct(nodeDetailsNode.heartbeat.disk.used_bytes, nodeDetailsNode.heartbeat.disk.total_bytes).toFixed(0)}%`
	                        : "-"}
	                    </div>
	                    {Array.isArray(nodeDetailsNode.heartbeat?.net?.ipv4) && nodeDetailsNode.heartbeat.net.ipv4.length ? (
	                      <div className="hint" style={{ marginTop: 8 }}>
	                        IPv4: {nodeDetailsNode.heartbeat.net.ipv4.slice(0, 6).join(", ")}
	                      </div>
	                    ) : null}
	                    {Array.isArray(nodeDetailsNode.heartbeat?.net?.preferred_connect_addrs) &&
	                    nodeDetailsNode.heartbeat.net.preferred_connect_addrs.length ? (
	                      <div className="hint" style={{ marginTop: 8 }}>
	                        Connect: {nodeDetailsNode.heartbeat.net.preferred_connect_addrs.slice(0, 6).join(", ")}
	                      </div>
	                    ) : null}
	                  </div>

	                  <div className="card">
	                    <h3>Charts</h3>
                    <div className="hint">CPU%</div>
                    <Sparkline
                      values={(Array.isArray(nodeDetailsNode.history) ? nodeDetailsNode.history : []).map((p: any) => p?.cpu_percent)}
                      width={460}
                      height={80}
                      stroke="rgba(147, 197, 253, 0.95)"
                    />
                    <div className="hint" style={{ marginTop: 10 }}>
                      MEM%
                    </div>
	                    <Sparkline
	                      values={(Array.isArray(nodeDetailsNode.history) ? nodeDetailsNode.history : []).map((p: any) => p?.mem_percent)}
	                      width={460}
	                      height={80}
	                      stroke="rgba(34, 197, 94, 0.9)"
	                    />
	                  </div>
	                </div>

	                <div className="card">
	                  <h3>Instances</h3>
	                  <table>
	                    <thead>
	                      <tr>
	                        <th>ID</th>
	                        <th>Status</th>
	                      </tr>
	                    </thead>
	                    <tbody>
	                      {(nodeDetailsNode.heartbeat?.instances || []).map((i: any) => (
	                        <tr key={i.id}>
	                          <td style={{ fontWeight: 650 }}>{i.id}</td>
	                          <td>
	                            {i.running ? (
	                              <span className="badge ok">running (pid {i.pid || "-"})</span>
	                            ) : (
	                              <span className="badge">stopped</span>
	                            )}
	                          </td>
	                        </tr>
	                      ))}
	                      {!(nodeDetailsNode.heartbeat?.instances || []).length ? (
	                        <tr>
	                          <td colSpan={2} className="muted">
	                            No instances reported yet
	                          </td>
	                        </tr>
	                      ) : null}
	                    </tbody>
	                  </table>
	                </div>
	              </>
	            ) : (
	              <div className="hint">No data</div>
	            )}
	          </div>
	        </div>
	      ) : null}

      {addNodeOpen ? (
        <div className="modalOverlay" onClick={() => setAddNodeOpen(false)}>
          <div className="modal" style={{ width: "min(640px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>Add Node</div>
                <div className="hint">创建后会生成/保存 token；如需换 token，请先删除再创建。</div>
                {nodesStatus ? <div className="hint">{nodesStatus}</div> : null}
              </div>
              <button type="button" onClick={() => setAddNodeOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>daemon_id</label>
                <input value={newNodeId} onChange={(e) => setNewNodeId(e.target.value)} placeholder="my-node" />
                <div className="hint">建议：A-Z a-z 0-9 . _ -（最长 64）</div>
              </div>
              <div className="field">
                <label>token (optional)</label>
                <input value={newNodeToken} onChange={(e) => setNewNodeToken(e.target.value)} placeholder="留空则自动生成" />
              </div>
            </div>

            <div className="btnGroup" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button
                className="primary"
                type="button"
                disabled={!newNodeId.trim()}
                onClick={async () => {
                  setNodesStatus("");
                  setCreatedNode(null);
                  try {
                    const res = await apiFetch("/api/nodes", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: newNodeId, token: newNodeToken }),
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json?.error || "failed");
                    const node = json.node;
                    setCreatedNode({ id: node.id, token: node.token });
                    setNewNodeId("");
                    setNewNodeToken("");
                    setNodesStatus(`Created: ${node.id}`);
                    const res2 = await apiFetch("/api/nodes", { cache: "no-store" });
                    const json2 = await res2.json();
                    if (res2.ok) setNodes(json2.nodes || []);
                  } catch (e: any) {
                    setNodesStatus(String(e?.message || e));
                  }
                }}
              >
                Create
              </button>
            </div>

            {createdNode ? (
              <div className="card" style={{ marginTop: 12 }}>
                <h3>Token</h3>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <code>{createdNode.token}</code>
                  <button
                    type="button"
                    onClick={async () => {
                      await copyText(createdNode.token);
                      setNodesStatus("Copied");
                      setTimeout(() => setNodesStatus(""), 800);
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {addFrpOpen ? (
        <div className="modalOverlay" onClick={() => setAddFrpOpen(false)}>
          <div className="modal" style={{ width: "min(720px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>Add FRP Server</div>
                <div className="hint">保存后可在 Games 一键复用。</div>
                {profilesStatus ? <div className="hint">{profilesStatus}</div> : null}
              </div>
              <button type="button" onClick={() => setAddFrpOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>Name</label>
                <input value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="My FRP" />
              </div>
              <div className="field">
                <label>Server Addr</label>
                <input value={newProfileAddr} onChange={(e) => setNewProfileAddr(e.target.value)} placeholder="frp.example.com" />
              </div>
              <div className="field">
                <label>Server Port</label>
                <input
                  type="number"
                  value={Number.isFinite(newProfilePort) ? newProfilePort : 7000}
                  onChange={(e) => setNewProfilePort(Number(e.target.value))}
                  placeholder="7000"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="field">
                <label>Token (optional)</label>
                <input value={newProfileToken} onChange={(e) => setNewProfileToken(e.target.value)} placeholder="******" />
              </div>
            </div>

            <div className="btnGroup" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="primary" type="button" disabled={!newProfileName.trim() || !newProfileAddr.trim()} onClick={addFrpProfile}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "nodes" ? <NodesView /> : null}

      {tab === "games" ? <GamesView /> : null}

      {tab === "frp" ? <FrpView /> : null}

      {tab === "files" ? <FilesView /> : null}

      {tab === "advanced" ? <AdvancedView /> : null}
        </div>
      </div>
      </div>
    </AppCtxProvider>
  );
}
