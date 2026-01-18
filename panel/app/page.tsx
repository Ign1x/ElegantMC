"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppCtxProvider } from "./appCtx";
import { createT, normalizeLocale, type Locale } from "./i18n";
import Icon from "./ui/Icon";
import ErrorBoundary from "./ui/ErrorBoundary";
import Select from "./ui/Select";
import AdvancedView from "./views/AdvancedView";
import FilesView from "./views/FilesView";
import FrpView from "./views/FrpView";
import GamesView from "./views/GamesView";
import NodesView from "./views/NodesView";
import PanelView from "./views/PanelView";

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

const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateInstanceIDUI(id: string) {
  const v = String(id || "").trim();
  if (!v) return "instance_id is required";
  if (!INSTANCE_ID_RE.test(v)) return "only A-Z a-z 0-9 . _ - (max 64), must start with alnum";
  return "";
}

function validatePortUI(port: any, { allowZero }: { allowZero: boolean }) {
  const n = Math.round(Number(port ?? 0));
  if (!Number.isFinite(n)) return "port must be a number";
  if (allowZero && n === 0) return "";
  if (n < 1 || n > 65535) return "port must be in 1-65535";
  return "";
}

function validateJarNameUI(name: string) {
  const v = String(name || "").trim();
  if (!v) return "jar_name is required";
  if (v.length > 128) return "jar_name too long";
  if (v.includes("/") || v.includes("\\")) return "jar_name must be a filename (no /)";
  if (v.startsWith(".")) return "jar_name should not start with '.'";
  return "";
}

function validateJarPathUI(jarPath: string) {
  const raw = String(jarPath || "").trim();
  if (!raw) return "jar_path is required";
  if (raw.length > 256) return "jar_path too long";
  const v = raw
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");
  if (!v) return "jar_path is required";
  if (v.startsWith(".")) return "jar_path should not start with '.'";
  if (v.endsWith("/")) return "jar_path must be a file path";
  const parts = v.split("/").filter(Boolean);
  if (!parts.length) return "jar_path is required";
  for (const p of parts) {
    if (p === "." || p === "..") return "jar_path must not contain '.' or '..'";
  }
  return "";
}

type FrpProfile = {
  id: string;
  name: string;
  server_addr: string;
  server_port: number;
  has_token?: boolean;
  token_masked?: string;
  created_at_unix?: number;
  status?: {
    checkedAtUnix?: number;
    online?: boolean | null;
    latencyMs?: number;
    error?: string;
  };
};

type Tab = "nodes" | "games" | "frp" | "files" | "panel" | "advanced";

type ThemeMode = "auto" | "dark" | "light" | "contrast";

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
  kind: "vanilla" | "paper" | "zip" | "zip_url" | "modrinth" | "curseforge";
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
  remoteUrl: string;
  remoteFileName: string;
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

function b64DecodeBytes(b64: string) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isProbablyBinary(bytes: Uint8Array) {
  const len = Math.min(bytes.length, 4096);
  if (!len) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32) || b === 127) suspicious++;
  }
  return suspicious / len > 0.2;
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
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
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

function isDockerBridgeLikeIPv4(hostname: string) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return false;
  return /^172\.(1[7-9]|2\d|3[01])\./.test(h);
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
  const dockerishHost = isDockerBridgeLikeIPv4(host);
  const preferred = Array.isArray(preferredAddrs)
    ? preferredAddrs.map((v) => stripPortFromHost(String(v || "").trim())).filter(Boolean)
    : [];
  const ips = Array.isArray(daemonIPv4) ? daemonIPv4.map((v) => String(v || "").trim()).filter(Boolean) : [];

  if (preferred.length) {
    const nonDocker = preferred.find((h) => !isDockerBridgeLikeIPv4(h));
    return nonDocker || preferred[0];
  }
  if (isLocalLikeHost(host) && !dockerishHost) return host;

  const preferredIP = ips.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("169.254."));
  if (preferredIP) return preferredIP;

  const nonDockerIP = ips.find((ip) => !ip.startsWith("127.") && !isDockerBridgeLikeIPv4(ip));
  if (nonDockerIP) return nonDockerIP;

  const first = ips.find((ip) => !ip.startsWith("127.")) || ips[0] || "";
  if (first) {
    // In docker-compose, daemon may only see container IPs (172.17-31.*). When panel is accessed via a public hostname,
    // the published ports are typically on the panel host instead of the container IP.
    if (host && !isLocalLikeHost(host) && /^172\.(1[7-9]|2\d|3[01])\./.test(first)) return host;
    if (dockerishHost && /^172\.(1[7-9]|2\d|3[01])\./.test(first)) return "127.0.0.1";
    return first;
  }

  if (dockerishHost) return "127.0.0.1";
  return host || "127.0.0.1";
}

function maskToken(token?: string) {
  const t = String(token || "");
  if (!t) return "(none)";
  if (t.length <= 4) return "****";
  return `${"*".repeat(Math.min(12, t.length - 4))}${t.slice(-4)}`;
}

function sanitizeForToast(value: any): any {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeForToast(v));
  if (typeof value !== "object") return String(value);

  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || "").toLowerCase();
    if (key.includes("token") || key.includes("password") || key.includes("secret") || key.includes("api_key") || key.includes("apikey")) {
      out[k] = typeof v === "string" ? maskToken(v) : "(redacted)";
      continue;
    }
    out[k] = sanitizeForToast(v);
  }
  return out;
}

function yamlQuote(v: string) {
  const s = String(v ?? "");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function makeDaemonComposeYml(opts: { daemonId: string; token: string; panelWsUrl: string }) {
  const daemonId = String(opts.daemonId || "").trim();
  const token = String(opts.token || "").trim();
  const panelWsUrl = String(opts.panelWsUrl || "").trim();
  return [
    "services:",
    "  daemon:",
    `    image: ${yamlQuote("ign1x/elegantmc-daemon:latest")}`,
    "    network_mode: host",
    "    restart: unless-stopped",
    "    environment:",
    `      ELEGANTMC_PANEL_WS_URL: ${yamlQuote(panelWsUrl || "wss://YOUR_PANEL/ws/daemon")}`,
    `      ELEGANTMC_DAEMON_ID: ${yamlQuote(daemonId || "my-node")}`,
    `      ELEGANTMC_TOKEN: ${yamlQuote(token || "your-token")}`,
    `      ELEGANTMC_BASE_DIR: ${yamlQuote("/data")}`,
    "    volumes:",
    "      - ./data:/data",
    "",
  ].join("\n");
}

function normalizeJarName(raw: string) {
  const v = String(raw || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "");
  const parts = v.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "server.jar";
}

function normalizeDownloadName(raw: string, fallback: string) {
  let v = String(raw || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "");
  const parts = v.split("/").filter(Boolean);
  v = parts.length ? parts[parts.length - 1] : "";
  if (!v) v = String(fallback || "download.zip");
  v = v.replace(/[^\w.\-+() ]+/g, "_");
  if (!v || v.startsWith(".")) v = String(fallback || "download.zip");
  if (v.length > 128) v = v.slice(0, 128);
  return v;
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

function normalizeRelFilePath(raw: string) {
  const v = String(raw || "")
    .trim()
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");
  const parts = v.split("/").filter(Boolean);
  if (!parts.length) return "";
  for (const p of parts) {
    if (p === "." || p === "..") return "";
  }
  return parts.join("/");
}

function isHex40(v: string) {
  return /^[0-9a-f]{40}$/i.test(String(v || "").trim());
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
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [sidebarFooterCollapsed, setSidebarFooterCollapsed] = useState<boolean>(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
  const themePrefsReadyRef = useRef<boolean>(false);
  const [enableAdvanced, setEnableAdvanced] = useState<boolean>(false);
  const [panelInfo, setPanelInfo] = useState<{ id: string; version: string; revision: string; buildDate: string } | null>(null);
  const [panelSettings, setPanelSettings] = useState<any | null>(null);
  const [panelSettingsStatus, setPanelSettingsStatus] = useState<string>("");

  const [daemons, setDaemons] = useState<Daemon[]>([]);
  const [selected, setSelected] = useState<string>("");
  const selectedDaemon = useMemo(() => daemons.find((d) => d.id === selected) || null, [daemons, selected]);

  const [error, setError] = useState<string>("");
  const [uiHost, setUiHost] = useState<string>("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginStatus, setLoginStatus] = useState<string>("");
  const [locale, setLocale] = useState<Locale>("en");
  const t = useMemo(() => createT(locale), [locale]);
  const localeTag = useMemo(() => (locale === "zh" ? "zh-CN" : "en-US"), [locale]);
  const dateTimeFmt = useMemo(() => new Intl.DateTimeFormat(localeTag, { dateStyle: "medium", timeStyle: "medium" }), [localeTag]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(localeTag, { timeStyle: "medium" }), [localeTag]);
  const num0 = useMemo(() => new Intl.NumberFormat(localeTag, { maximumFractionDigits: 0 }), [localeTag]);
  const num1 = useMemo(() => new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }), [localeTag]);

  const fmtUnix = useCallback(
    (ts?: number | null) => {
      if (!ts) return "-";
      return dateTimeFmt.format(new Date(ts * 1000));
    },
    [dateTimeFmt]
  );

  const fmtTime = useCallback(
    (ts?: number | null) => {
      if (!ts) return "--:--:--";
      return timeFmt.format(new Date(ts * 1000));
    },
    [timeFmt]
  );

  const fmtBytes = useCallback(
    (n?: number) => {
      const v = Number(n || 0);
      if (!Number.isFinite(v) || v <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let x = v;
      let i = 0;
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
      }
      const formatted = i === 0 ? num0.format(x) : num1.format(x);
      return `${formatted} ${units[i]}`;
    },
    [num0, num1]
  );

  // UI dialogs (avoid browser confirm/prompt)
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [confirmTitle, setConfirmTitle] = useState<string>("Confirm");
  const [confirmMessage, setConfirmMessage] = useState<string>("");
  const [confirmDanger, setConfirmDanger] = useState<boolean>(false);
  const [confirmConfirmLabel, setConfirmConfirmLabel] = useState<string>("Confirm");
  const [confirmCancelLabel, setConfirmCancelLabel] = useState<string>("Cancel");
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const [promptOpen, setPromptOpen] = useState<boolean>(false);
  const [promptTitle, setPromptTitle] = useState<string>("Input");
  const [promptMessage, setPromptMessage] = useState<string>("");
  const [promptPlaceholder, setPromptPlaceholder] = useState<string>("");
  const [promptValue, setPromptValue] = useState<string>("");
  const [promptOkLabel, setPromptOkLabel] = useState<string>("OK");
  const [promptCancelLabel, setPromptCancelLabel] = useState<string>("Cancel");
  const promptResolveRef = useRef<((value: string | null) => void) | null>(null);

  const [copyOpen, setCopyOpen] = useState<boolean>(false);
  const [copyValue, setCopyValue] = useState<string>("");

  // Toasts
  const [toasts, setToasts] = useState<{ id: string; kind: "info" | "ok" | "error"; message: string; detail?: string; expiresAtMs: number }[]>([]);
  const toastSeq = useRef<number>(0);
  const [toastsPaused, setToastsPaused] = useState<boolean>(false);
  const toastPauseStartRef = useRef<number | null>(null);

  // Command palette (Ctrl+K / /)
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState<boolean>(false);
  const [cmdPaletteQuery, setCmdPaletteQuery] = useState<string>("");
  const [cmdPaletteIdx, setCmdPaletteIdx] = useState<number>(0);
  const cmdPaletteInputRef = useRef<HTMLInputElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [changelogOpen, setChangelogOpen] = useState<boolean>(false);
  const [changelogStatus, setChangelogStatus] = useState<string>("");
  const [changelogText, setChangelogText] = useState<string>("");
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [helpDoc, setHelpDoc] = useState<string>("");
  const [helpDocTitle, setHelpDocTitle] = useState<string>("");
  const [helpDocText, setHelpDocText] = useState<string>("");
  const [helpDocStatus, setHelpDocStatus] = useState<string>("");

  // Logs
  const [logs, setLogs] = useState<any[]>([]);

  // Files
  const [fsPath, setFsPath] = useState<string>("");
  const [fsEntries, setFsEntries] = useState<any[]>([]);
  const [fsSelectedFile, setFsSelectedFile] = useState<string>("");
  const [fsSelectedFileMode, setFsSelectedFileMode] = useState<"none" | "text" | "binary">("none");
  const [fsFileText, setFsFileText] = useState<string>("");
  const [fsFileTextSaved, setFsFileTextSaved] = useState<string>("");
  const [fsStatus, setFsStatus] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState<number>(0);
  const [uploadStatus, setUploadStatus] = useState<string>("");

  // Server controls
  const [instanceId, setInstanceId] = useState<string>("");
  const [jarPath, setJarPath] = useState<string>("server.jar");
  const [jarCandidates, setJarCandidates] = useState<string[]>([]);
  const [jarCandidatesStatus, setJarCandidatesStatus] = useState<string>("");
  const [javaPath, setJavaPath] = useState<string>("");
  const [gamePort, setGamePort] = useState<number>(25565);
  const [xms, setXms] = useState<string>("1G");
  const [xmx, setXmx] = useState<string>("2G");
  const [consoleLine, setConsoleLine] = useState<string>("");
  const [serverOpStatus, setServerOpStatus] = useState<string>("");
  const [gameActionBusy, setGameActionBusy] = useState<boolean>(false);
  const [instanceUsageBytes, setInstanceUsageBytes] = useState<number | null>(null);
  const [instanceUsageStatus, setInstanceUsageStatus] = useState<string>("");
  const [instanceUsageBusy, setInstanceUsageBusy] = useState<boolean>(false);
  const [restoreOpen, setRestoreOpen] = useState<boolean>(false);
  const [restoreStatus, setRestoreStatus] = useState<string>("");
  const [restoreCandidates, setRestoreCandidates] = useState<string[]>([]);
  const [restoreZipPath, setRestoreZipPath] = useState<string>("");
  const [trashOpen, setTrashOpen] = useState<boolean>(false);
  const [trashStatus, setTrashStatus] = useState<string>("");
  const [trashItems, setTrashItems] = useState<any[]>([]);
  const [trashShowAll, setTrashShowAll] = useState<boolean>(false);
  const [serverPropsOpen, setServerPropsOpen] = useState<boolean>(false);
  const [serverPropsStatus, setServerPropsStatus] = useState<string>("");
  const [serverPropsRaw, setServerPropsRaw] = useState<string>("");
  const [serverPropsMotd, setServerPropsMotd] = useState<string>("");
  const [serverPropsMaxPlayers, setServerPropsMaxPlayers] = useState<number>(20);
  const [serverPropsOnlineMode, setServerPropsOnlineMode] = useState<boolean>(true);
  const [serverPropsWhitelist, setServerPropsWhitelist] = useState<boolean>(false);
  const [serverPropsSaving, setServerPropsSaving] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsSearch, setSettingsSearch] = useState<string>("");
  const [settingsSnapshot, setSettingsSnapshot] = useState<GameSettingsSnapshot | null>(null);
  const [installOpen, setInstallOpen] = useState<boolean>(false);
  const [installRunning, setInstallRunning] = useState<boolean>(false);
  const [installStep, setInstallStep] = useState<1 | 2 | 3>(1);
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
    remoteUrl: "",
    remoteFileName: "",
  }));
  const [installZipFile, setInstallZipFile] = useState<File | null>(null);
  const [installZipInputKey, setInstallZipInputKey] = useState<number>(0);
  const [marketQuery, setMarketQuery] = useState<string>("");
  const [marketStatus, setMarketStatus] = useState<string>("");
  const [marketResults, setMarketResults] = useState<any[]>([]);
  const [marketSelected, setMarketSelected] = useState<any>(null);
  const [marketVersions, setMarketVersions] = useState<any[]>([]);
  const [marketSelectedVersionId, setMarketSelectedVersionId] = useState<string>("");
  const [cfResolveStatus, setCfResolveStatus] = useState<string>("");
  const [cfResolveBusy, setCfResolveBusy] = useState<boolean>(false);
  const [modpackProviders, setModpackProviders] = useState<any[]>([]);
  const [modpackProvidersStatus, setModpackProvidersStatus] = useState<string>("");
  const [logView, setLogView] = useState<"all" | "mc" | "install" | "frp">("all");

  useEffect(() => {
    try {
      const k = String((installForm as any)?.kind || "").trim();
      if (k) localStorage.setItem("elegantmc_install_kind", k);
    } catch {
      // ignore
    }
  }, [(installForm as any)?.kind]);

  // Server list (directories under servers/)
  const [serverDirs, setServerDirs] = useState<string[]>([]);
  const [serverDirsStatus, setServerDirsStatus] = useState<string>("");
  const [instanceTagsById, setInstanceTagsById] = useState<Record<string, string[]>>({});

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

  const globalBusy = gameActionBusy || instanceUsageBusy || installRunning || serverPropsSaving || cfResolveBusy;

  // Node management
  const [nodes, setNodes] = useState<any[]>([]);
  const [nodesStatus, setNodesStatus] = useState<string>("");
  const [nodeDetailsOpen, setNodeDetailsOpen] = useState<boolean>(false);
  const [nodeDetailsId, setNodeDetailsId] = useState<string>("");
  const [nodeDetailsRangeSec, setNodeDetailsRangeSec] = useState<number>(15 * 60);
  const [addNodeOpen, setAddNodeOpen] = useState<boolean>(false);
  const [createdNode, setCreatedNode] = useState<{ id: string; token: string } | null>(null);
  const [newNodeId, setNewNodeId] = useState<string>("");
  const [newNodeToken, setNewNodeToken] = useState<string>("");
  const [deployAfterCreate, setDeployAfterCreate] = useState<boolean>(false);
  const [deployOpen, setDeployOpen] = useState<boolean>(false);
  const [deployNodeId, setDeployNodeId] = useState<string>("");
  const [deployToken, setDeployToken] = useState<string>("");
  const [deployPanelWsUrl, setDeployPanelWsUrl] = useState<string>("");

  // Advanced command runner
  const [cmdName, setCmdName] = useState<string>("ping");
  const [cmdArgs, setCmdArgs] = useState<string>("{}");
  const [cmdResult, setCmdResult] = useState<any>(null);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === frpProfileId) || null,
    [profiles, frpProfileId]
  );

  const curseforgeEnabled = useMemo(() => {
    const hit = (Array.isArray(modpackProviders) ? modpackProviders : []).find((p: any) => String(p?.id || "") === "curseforge");
    if (hit && typeof hit.enabled === "boolean") return !!hit.enabled;
    return !!String(panelSettings?.curseforge_api_key || "").trim();
  }, [modpackProviders, panelSettings]);

	  const installValidation = useMemo(() => {
	    const instErr = validateInstanceIDUI(installForm.instanceId);
	    const verErr = installForm.kind === "vanilla" || installForm.kind === "paper" ? (String(installForm.version || "").trim() ? "" : "version is required") : "";
	    const kindErr = "";
	    const jarErr =
	      installForm.kind === "zip" || installForm.kind === "zip_url" || installForm.kind === "modrinth" || installForm.kind === "curseforge"
	        ? validateJarPathUI(installForm.jarName)
	        : validateJarNameUI(installForm.jarName);
	    const zipErr = installForm.kind === "zip" && !installZipFile ? "zip/mrpack file is required" : "";
	    const remoteErr = (() => {
	      const url = String(installForm.remoteUrl || "").trim();
	      if (installForm.kind === "zip_url") return url ? "" : "remote url is required";
	      if (installForm.kind === "modrinth" || installForm.kind === "curseforge") return url ? "" : "select a modpack file first";
	      return "";
	    })();
	    const portErr = validatePortUI(installForm.gamePort, { allowZero: false });
	    const frpRemoteErr = validatePortUI(installForm.frpRemotePort, { allowZero: true });
	    const frpProfileErr =
	      installForm.enableFrp && (!String(installForm.frpProfileId || "").trim() || !profiles.length)
	        ? "select a FRP server (or disable FRP)"
	        : "";
	    const canInstall = !kindErr && !instErr && !verErr && !jarErr && !zipErr && !remoteErr && !portErr && !frpRemoteErr;
	    const canInstallAndStart = canInstall && (!installForm.enableFrp || !frpProfileErr);
	    return { kindErr, instErr, verErr, jarErr, zipErr, remoteErr, portErr, frpRemoteErr, frpProfileErr, canInstall, canInstallAndStart };
	  }, [installForm, installZipFile, profiles]);

	  const installWizardStep1Ok = useMemo(() => {
	    return (
	      !installValidation.kindErr &&
	      !installValidation.instErr &&
	      !installValidation.verErr &&
	      !installValidation.zipErr &&
	      !installValidation.remoteErr &&
	      !installValidation.portErr
	    );
	  }, [installValidation]);

	  const installWizardStep2Ok = useMemo(() => {
	    return !installValidation.jarErr;
	  }, [installValidation]);

  const marketSelectedVersion = useMemo(() => {
    const id = String(marketSelectedVersionId || "").trim();
    if (!id) return null;
    const list = Array.isArray(marketVersions) ? marketVersions : [];
    return list.find((v: any) => String(v?.id || "").trim() === id) || null;
  }, [marketSelectedVersionId, marketVersions]);

  const settingsValidation = useMemo(() => {
    const jar = String(jarPath || "").trim();
    const jarErr = jar ? "" : "jar_path is required";
    const portErr = validatePortUI(gamePort, { allowZero: false });
    const frpRemoteErr = validatePortUI(frpRemotePort, { allowZero: true });
    const ok = !jarErr && !portErr && !frpRemoteErr;
    return { jarErr, portErr, frpRemoteErr, ok };
  }, [jarPath, gamePort, frpRemotePort]);

  const settingsSearchQ = settingsSearch.trim().toLowerCase();
  const showSettingsField = (...terms: string[]) =>
    !settingsSearchQ || terms.some((t) => String(t || "").toLowerCase().includes(settingsSearchQ));

  const nodeDetailsNode = useMemo(() => nodes.find((n: any) => n?.id === nodeDetailsId) || null, [nodes, nodeDetailsId]);
  const nodeDetailsHistory = useMemo(() => {
    const hist = Array.isArray(nodeDetailsNode?.history) ? nodeDetailsNode.history : [];
    const rangeSec = Math.max(0, Math.round(Number(nodeDetailsRangeSec || 0)));
    if (!rangeSec) return hist;
    const now = Math.floor(Date.now() / 1000);
    return hist.filter((p: any) => typeof p?.ts_unix === "number" && p.ts_unix >= now - rangeSec);
  }, [nodeDetailsNode, nodeDetailsRangeSec]);
  const nodeDetailsHistoryMeta = useMemo(() => {
    const hist = Array.isArray(nodeDetailsHistory) ? nodeDetailsHistory : [];
    const last = hist.length ? hist[hist.length - 1] : null;
    return {
      points: hist.length,
      fromUnix: hist.length ? (hist[0]?.ts_unix ?? null) : null,
      toUnix: hist.length ? (hist[hist.length - 1]?.ts_unix ?? null) : null,
      cpuLatest: typeof last?.cpu_percent === "number" ? last.cpu_percent : null,
      memLatest: typeof last?.mem_percent === "number" ? last.mem_percent : null,
      diskLatest: typeof last?.disk_percent === "number" ? last.disk_percent : null,
    };
  }, [nodeDetailsHistory]);

  const instanceStatus = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.instances || [];
    return list.find((i: any) => i?.id === instanceId) || null;
  }, [selectedDaemon, instanceId]);

  const frpStatus = useMemo(() => {
    const inst = String(instanceId || "").trim();
    const list = selectedDaemon?.heartbeat?.frp_proxies;
    if (inst && Array.isArray(list)) {
      const hit = list.find((p: any) => String(p?.proxy_name || "").trim() === inst) || null;
      if (hit) return hit;
    }
    return selectedDaemon?.heartbeat?.frp || null;
  }, [selectedDaemon, instanceId]);
  const daemonIPv4 = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.net?.ipv4;
    return Array.isArray(list) ? list.map((v: any) => String(v || "").trim()).filter(Boolean) : [];
  }, [selectedDaemon]);
  const preferredConnectAddrs = useMemo(() => {
    const list = selectedDaemon?.heartbeat?.net?.preferred_connect_addrs;
    return Array.isArray(list) ? list.map((v: any) => String(v || "").trim()).filter(Boolean) : [];
  }, [selectedDaemon]);
  const localHost = useMemo(() => pickBestLocalHost(uiHost, preferredConnectAddrs, daemonIPv4), [uiHost, preferredConnectAddrs, daemonIPv4]);
  const deployComposeYml = useMemo(
    () => makeDaemonComposeYml({ daemonId: deployNodeId, token: deployToken, panelWsUrl: deployPanelWsUrl }),
    [deployNodeId, deployToken, deployPanelWsUrl]
  );

  function makeDeployComposeYml(daemonId: string, token: string) {
    return makeDaemonComposeYml({ daemonId, token, panelWsUrl: deployPanelWsUrl });
  }
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

  const fsDirty = useMemo(() => {
    if (!fsSelectedFile) return false;
    if (fsSelectedFileMode !== "text") return false;
    return fsFileText !== fsFileTextSaved;
  }, [fsSelectedFile, fsSelectedFileMode, fsFileText, fsFileTextSaved]);

  // Theme (auto/light/dark/contrast)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("elegantmc_theme_mode") || "auto";
      if (saved === "dark" || saved === "light" || saved === "contrast" || saved === "auto") setThemeMode(saved);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Locale (en/zh)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("elegantmc_locale") || "";
      if (saved) {
        setLocale(normalizeLocale(saved));
        return;
      }
    } catch {
      // ignore
    }
    try {
      const lang = String(navigator.language || "");
      setLocale(lang.toLowerCase().startsWith("zh") ? "zh" : "en");
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("elegantmc_locale", locale);
    } catch {
      // ignore
    }
  }, [locale]);

  useEffect(() => {
    const mode: ThemeMode = themeMode === "dark" || themeMode === "light" || themeMode === "contrast" ? themeMode : "auto";
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

  useEffect(() => {
    if (authed !== true) return;
    if (!themePrefsReadyRef.current) return;
    const mode: ThemeMode = themeMode === "dark" || themeMode === "light" || themeMode === "contrast" ? themeMode : "auto";
    const t = window.setTimeout(() => {
      apiFetch("/api/ui/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme_mode: mode }),
      }).catch(() => {});
    }, 260);
    return () => window.clearTimeout(t);
  }, [authed, themeMode]);

  // Persist mobile sidebar open state (per session).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("elegantmc_sidebar_open") || "0";
      if (raw === "1" && (window.innerWidth || 0) < 900) setSidebarOpen(true);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("elegantmc_sidebar_open", sidebarOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [sidebarOpen]);

  // Sidebar footer collapse
  useEffect(() => {
    try {
      const raw = localStorage.getItem("elegantmc_sidebar_footer_collapsed") || "0";
      setSidebarFooterCollapsed(raw === "1");
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("elegantmc_sidebar_footer_collapsed", sidebarFooterCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [sidebarFooterCollapsed]);

  // Hash deep links: #tab=games&daemon=...&instance=...
  useEffect(() => {
    try {
      const raw = String(window.location.hash || "").replace(/^#/, "");
      if (!raw) return;
      const p = new URLSearchParams(raw);
      const tab0 = String(p.get("tab") || "");
      if (tab0 === "nodes" || tab0 === "games" || tab0 === "frp" || tab0 === "files" || tab0 === "panel") {
        setTab(tab0 as any);
      }
      const daemon0 = String(p.get("daemon") || "").trim();
      if (daemon0) setSelected(daemon0);
      const inst0 = String(p.get("instance") || "").trim();
      if (inst0) setInstanceId(inst0);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist selected tab/daemon/game across refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("elegantmc_ui_state_v1");
      if (!raw) return;
      const st = JSON.parse(raw);

      const savedTab = String(st?.tab || "");
      if (savedTab === "nodes" || savedTab === "games" || savedTab === "frp" || savedTab === "files" || savedTab === "panel") {
        setTab(savedTab as any);
      }

      const savedDaemon = String(st?.daemon || "").trim();
      if (savedDaemon) setSelected(savedDaemon);

      const savedInst = String(st?.instance || "").trim();
      if (savedInst) setInstanceId(savedInst);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        "elegantmc_ui_state_v1",
        JSON.stringify({ tab, daemon: String(selected || ""), instance: String(instanceId || "").trim() })
      );
    } catch {
      // ignore
    }
  }, [tab, selected, instanceId]);

  useEffect(() => {
    try {
      const p = new URLSearchParams();
      if (tab) p.set("tab", tab);
      if (String(selected || "").trim()) p.set("daemon", String(selected || "").trim());
      if (String(instanceId || "").trim()) p.set("instance", String(instanceId || "").trim());
      const next = p.toString();
      const cur = String(window.location.hash || "").replace(/^#/, "");
      if (cur === next) return;
      const base = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", next ? `${base}#${next}` : base);
    } catch {
      // ignore
    }
  }, [tab, selected, instanceId]);

  // Instance tags (per daemon, stored in localStorage)
  useEffect(() => {
    if (!selected) {
      setInstanceTagsById({});
      return;
    }
    try {
      const raw = localStorage.getItem(`elegantmc_instance_tags_v1:${selected}`);
      const parsed = raw ? JSON.parse(raw) : {};
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed || {})) {
        const inst = String(k || "").trim();
        if (!inst) continue;
        const tags = Array.isArray(v) ? v : [];
        const cleaned = tags.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 12);
        if (cleaned.length) out[inst] = cleaned;
      }
      setInstanceTagsById(out);
    } catch {
      setInstanceTagsById({});
    }
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(`elegantmc_instance_tags_v1:${selected}`, JSON.stringify(instanceTagsById || {}));
    } catch {
      // ignore
    }
  }, [selected, instanceTagsById]);

  useEffect(() => {
    const name = String(panelSettings?.brand_name || "").trim();
    if (!name) return;
    try {
      document.title = name;
    } catch {
      // ignore
    }
  }, [panelSettings?.brand_name]);

  // Modal keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = String((e.target as any)?.tagName || "").toUpperCase();
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(e.target as any)?.isContentEditable;
      const key = String(e.key || "");

      if (!typing) {
        if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "k") {
          e.preventDefault();
          if (cmdPaletteOpen) {
            setCmdPaletteOpen(false);
          } else {
            setCmdPaletteQuery("");
            setCmdPaletteIdx(0);
            setCmdPaletteOpen(true);
          }
          return;
        }
        if (key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setShortcutsOpen((v) => !v);
          return;
        }
        if (key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setCmdPaletteQuery("");
          setCmdPaletteIdx(0);
          setCmdPaletteOpen(true);
          return;
        }
      }

      if (e.key === "Escape") {
        if (confirmOpen) {
          e.preventDefault();
          closeConfirm(false);
          return;
        }
        if (promptOpen) {
          e.preventDefault();
          closePrompt(null);
          return;
        }
        if (copyOpen) {
          e.preventDefault();
          setCopyOpen(false);
          return;
        }
        if (shortcutsOpen) {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
        if (changelogOpen) {
          e.preventDefault();
          setChangelogOpen(false);
          return;
        }
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
          return;
        }
        if (cmdPaletteOpen) {
          e.preventDefault();
          setCmdPaletteOpen(false);
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
        if (sidebarOpen) {
          e.preventDefault();
          setSidebarOpen(false);
          return;
        }
      }
      if (e.key === "Enter" && confirmOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          closeConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    confirmOpen,
    promptOpen,
    copyOpen,
    shortcutsOpen,
    changelogOpen,
    helpOpen,
    cmdPaletteOpen,
    installOpen,
    installRunning,
    settingsOpen,
    nodeDetailsOpen,
    addNodeOpen,
    addFrpOpen,
    sidebarOpen,
  ]);

  useEffect(() => {
    if (!cmdPaletteOpen) return;
    const t = window.setTimeout(() => cmdPaletteInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [cmdPaletteOpen]);

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

  async function refreshUiPrefs() {
    try {
      const res = await apiFetch("/api/ui/prefs", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) return;
      const mode = String(json?.prefs?.theme_mode || "").trim();
      if (mode === "dark" || mode === "light" || mode === "contrast" || mode === "auto") {
        setThemeMode(mode as ThemeMode);
      }
    } catch {
      // ignore
    } finally {
      themePrefsReadyRef.current = true;
    }
  }

  async function refreshModpackProviders() {
    setModpackProvidersStatus("Loading...");
    try {
      const res = await apiFetch("/api/modpacks/providers", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");
      setModpackProviders(Array.isArray(json?.providers) ? json.providers : []);
      setModpackProvidersStatus("");
    } catch (e: any) {
      setModpackProviders([]);
      setModpackProvidersStatus(String(e?.message || e));
    }
  }

  async function refreshPanelSettings() {
    setPanelSettingsStatus("Loading...");
    try {
      const res = await apiFetch("/api/panel/settings", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");
      setPanelSettings(json?.settings || null);
      setPanelSettingsStatus("");
      refreshModpackProviders();
    } catch (e: any) {
      setPanelSettings(null);
      setPanelSettingsStatus(String(e?.message || e));
    }
  }

  async function savePanelSettings(next: any) {
    setPanelSettingsStatus("Saving...");
    try {
      const res = await apiFetch("/api/panel/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ?? {}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");
      setPanelSettings(json?.settings || null);
      refreshModpackProviders();
      setPanelSettingsStatus("Saved");
      setTimeout(() => setPanelSettingsStatus(""), 900);
    } catch (e: any) {
      setPanelSettingsStatus(String(e?.message || e));
    }
  }

  async function loadSchedule() {
    if (!selectedDaemon?.connected) throw new Error("daemon offline");
    return await callOkCommand("schedule_get", {}, 30_000);
  }

  async function saveScheduleJson(jsonText: string) {
    if (!selectedDaemon?.connected) throw new Error("daemon offline");
    const text = String(jsonText || "").trim();
    if (!text) throw new Error("json is required");
    return await callOkCommand("schedule_set", { json: text }, 30_000);
  }

  async function runScheduleTask(taskId: string) {
    if (!selectedDaemon?.connected) throw new Error("daemon offline");
    const id = String(taskId || "").trim();
    if (!id) throw new Error("task_id is required");
    return await callOkCommand("schedule_run_task", { task_id: id }, 60 * 60_000);
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
    const daemonId = String(selected || "").trim();
    if (!daemonId) {
      pushToast("No daemon selected", "error", 7000, `command=${name}`);
      throw new Error("no daemon selected");
    }

    let res: Response;
    let json: any = null;
    try {
      res = await apiFetch(`/api/daemons/${encodeURIComponent(daemonId)}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args, timeoutMs }),
      });
      json = await res.json().catch(() => null);
    } catch (e: any) {
      const msg = String(e?.message || e);
      pushToast(
        `Command ${name} failed`,
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw e;
    }

    if (!res.ok) {
      const msg = String(json?.error || "request failed");
      pushToast(
        `Command ${name} failed: ${msg}`,
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, status: res.status, error: msg }, null, 2)
      );
      throw new Error(msg);
    }

    return json.result;
  }

  async function callAdvancedCommand(name: string, args: any, timeoutMs = 60_000) {
    if (!enableAdvanced) throw new Error("advanced is disabled");
    const daemonId = String(selected || "").trim();
    if (!daemonId) {
      pushToast("No daemon selected", "error", 7000, `command=${name}`);
      throw new Error("no daemon selected");
    }

    let res: Response;
    let json: any = null;
    try {
      res = await apiFetch(`/api/daemons/${encodeURIComponent(daemonId)}/advanced-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args, timeoutMs }),
      });
      json = await res.json().catch(() => null);
    } catch (e: any) {
      const msg = String(e?.message || e);
      pushToast(
        `Advanced command ${name} failed`,
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw e;
    }

    if (!res.ok) {
      const msg = String(json?.error || "request failed");
      pushToast(
        `Advanced command ${name} failed: ${msg}`,
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, status: res.status, error: msg }, null, 2)
      );
      throw new Error(msg);
    }

    return json.result;
  }

  async function callOkCommand(name: string, args: any, timeoutMs = 60_000) {
    const result = await callCommand(name, args, timeoutMs);
    if (!result?.ok) {
      const msg = String(result?.error || "command failed");
      pushToast(
        `Command ${name} failed: ${msg}`,
        "error",
        9000,
        JSON.stringify({ daemon: String(selected || "").trim(), name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw new Error(msg);
    }
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
    setDeployAfterCreate(false);
    setAddNodeOpen(true);
  }

  function openAddNodeAndDeploy() {
    setCreatedNode(null);
    setNewNodeId("");
    setNewNodeToken("");
    setNodesStatus("");
    setDeployAfterCreate(true);
    setAddNodeOpen(true);
  }

  function openDeployDaemonModal(nodeId: string, token: string) {
    setDeployNodeId(String(nodeId || "").trim());
    setDeployToken(String(token || "").trim());
    setDeployOpen(true);
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
        .filter((e: any) => e?.isDir && e?.name && !String(e.name).startsWith(".") && !String(e.name).startsWith("_"))
        .map((e: any) => String(e.name));
      dirs.sort((a: string, b: string) => a.localeCompare(b));
      setServerDirs(dirs);
      setServerDirsStatus("");
    } catch (e: any) {
      setServerDirs([]);
      setServerDirsStatus(String(e?.message || e));
    }
  }

  function normalizeTags(tags: string[]) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of tags) {
      let t = String(raw || "").trim();
      if (!t) continue;
      if (t.length > 24) t = t.slice(0, 24);
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= 12) break;
    }
    return out;
  }

  function updateInstanceTags(instance: string, tags: string[]) {
    const inst = String(instance || "").trim();
    if (!inst) return;
    const nextTags = normalizeTags(Array.isArray(tags) ? tags : []);
    setInstanceTagsById((prev) => {
      const cur = prev || {};
      const next = { ...cur };
      if (!nextTags.length) delete next[inst];
      else next[inst] = nextTags;
      return next;
    });
  }

  async function refreshJarCandidates(instOverride?: string) {
    const inst = String(instOverride ?? instanceId).trim();
    if (!inst || !selectedDaemon?.connected) {
      setJarCandidates([]);
      setJarCandidatesStatus(inst ? "daemon offline" : "");
      return;
    }
    setJarCandidatesStatus("Scanning jars...");
    try {
      const out = await callOkCommand("mc_detect_jar", { instance_id: inst }, 30_000);
      const jars = (Array.isArray(out?.jars) ? out.jars : []).map((j: any) => String(j || "")).filter(Boolean);
      setJarCandidates(jars);
      setJarCandidatesStatus(jars.length ? "" : "No .jar files found");
    } catch (e: any) {
      setJarCandidates([]);
      setJarCandidatesStatus(String(e?.message || e));
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

  function closePrompt(value: string | null) {
    setPromptOpen(false);
    const resolve = promptResolveRef.current;
    promptResolveRef.current = null;
    if (resolve) resolve(value);
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

  async function promptDialog(
    opts: {
      title?: string;
      message?: string;
      placeholder?: string;
      defaultValue?: string;
      okLabel?: string;
      cancelLabel?: string;
    } = {}
  ) {
    return new Promise<string | null>((resolve) => {
      promptResolveRef.current = resolve;
      setPromptTitle(opts.title || "Input");
      setPromptMessage(String(opts.message || ""));
      setPromptPlaceholder(String(opts.placeholder || ""));
      setPromptValue(String(opts.defaultValue || ""));
      setPromptOkLabel(opts.okLabel || "OK");
      setPromptCancelLabel(opts.cancelLabel || "Cancel");
      setPromptOpen(true);
    });
  }

  function openCopyModal(text: string) {
    setCopyValue(String(text || ""));
    setCopyOpen(true);
  }

  async function openChangelogModal() {
    setChangelogOpen(true);
    setChangelogStatus("");
    if (changelogText) return;
    setChangelogStatus("Loading...");
    try {
      const res = await apiFetch("/api/changelog", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");
      setChangelogText(String(json?.latest || json?.full || "").trim());
      setChangelogStatus("");
    } catch (e: any) {
      setChangelogStatus(String(e?.message || e));
    }
  }

  function defaultHelpDocForTab(t: Tab) {
    if (t === "advanced") return "security";
    if (t === "panel") return "panel_readme";
    return "readme";
  }

  async function loadHelpDoc(name: string) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return;
    setHelpDoc(key);
    setHelpDocStatus("Loading...");
    try {
      const res = await apiFetch(`/api/docs?name=${encodeURIComponent(key)}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");
      setHelpDocTitle(String(json?.title || key));
      setHelpDocText(String(json?.text || ""));
      setHelpDocStatus("");
    } catch (e: any) {
      setHelpDocTitle("");
      setHelpDocText("");
      setHelpDocStatus(String(e?.message || e));
    }
  }

  async function openHelpModal() {
    setHelpOpen(true);
    const doc = defaultHelpDocForTab(tab);
    if (helpDocText && helpDoc === doc) return;
    await loadHelpDoc(doc);
  }

  async function copyText(text: string) {
    const t = String(text || "");
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setServerOpStatus("Copied");
      pushToast("Copied", "ok");
      return;
    } catch {
      // ignore
    }
    openCopyModal(t);
  }

  function pushToast(message: string, kind: "info" | "ok" | "error" = "info", ttlMs?: number, detail?: string) {
    const msg = String(message || "").trim();
    if (!msg) return;
    const now = Date.now();
    const id = `${now}-${toastSeq.current++}`;
    const d = String(detail || "").trim();

    const defaultTtl = kind === "error" ? 9000 : 2200;
    const ttlNum = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : defaultTtl;
    const ttl = Math.max(800, Math.min(20_000, Math.round(ttlNum)));

    setToasts((prev) =>
      [...prev, { id, kind, message: msg, expiresAtMs: now + ttl, ...(d ? { detail: d } : {}) }].slice(-6)
    );
  }

  useEffect(() => {
    if (!toasts.length) return;
    const t = window.setInterval(() => {
      if (toastsPaused) return;
      const now = Date.now();
      setToasts((prev) => prev.filter((x) => x.expiresAtMs > now));
    }, 250);
    return () => window.clearInterval(t);
  }, [toasts.length, toastsPaused]);

  function pauseToasts() {
    if (toastPauseStartRef.current != null) return;
    toastPauseStartRef.current = Date.now();
    setToastsPaused(true);
  }

  function resumeToasts() {
    const started = toastPauseStartRef.current;
    if (started == null) return;
    toastPauseStartRef.current = null;
    setToastsPaused(false);
    const delta = Date.now() - started;
    if (delta <= 0) return;
    setToasts((prev) => prev.map((t) => ({ ...t, expiresAtMs: t.expiresAtMs + delta })));
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
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const wsUrl = `${proto}://${window.location.host}/ws/daemon`;
      setDeployPanelWsUrl((prev) => prev || wsUrl);
    } catch {
      // ignore
    }
  }, []);

  // Runtime config (server-side env)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        setEnableAdvanced(!!json?.enable_advanced);
        setPanelInfo({
          id: String(json?.panel_id || ""),
          version: String(json?.panel_version || "dev"),
          revision: String(json?.panel_revision || ""),
          buildDate: String(json?.panel_build_date || ""),
        });
      } catch {
        // ignore
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // If advanced is disabled, never allow landing on that tab.
  useEffect(() => {
    if (!enableAdvanced && tab === "advanced") setTab("games");
  }, [enableAdvanced, tab]);

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
    setInstanceUsageBytes(null);
    setInstanceUsageStatus("");
    setInstanceUsageBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    if (!settingsOpen) return;
    refreshJarCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, selected, instanceId]);

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

  async function refreshProfiles(opts: { force?: boolean } = {}) {
    setProfilesStatus("Loading...");
    try {
      const qs = opts.force ? "?force=1" : "";
      const res = await apiFetch(`/api/frp/profiles${qs}`, { cache: "no-store" });
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

  async function fetchFrpProfileToken(profileId: string) {
    const id = String(profileId || "").trim();
    if (!id) return "";
    const res = await apiFetch(`/api/frp/profiles/${encodeURIComponent(id)}/token`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "failed to load frp token");
    return String(json?.token || "");
  }

  useEffect(() => {
    if (authed !== true) return;
    refreshUiPrefs();
    refreshProfiles();
    refreshPanelSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  useEffect(() => {
    if (!fsSelectedFile) setFsSelectedFileMode("none");
  }, [fsSelectedFile]);

  // Persist Files view state per daemon + instance.
  useEffect(() => {
    const daemonId = String(selected || "").trim();
    if (!daemonId) return;
    const inst = String(instanceId || "").trim() || "_";
    try {
      localStorage.setItem(
        `elegantmc_files_state_v1:${daemonId}:${inst}`,
        JSON.stringify({
          path: String(fsPath || ""),
          file: String(fsSelectedFile || ""),
          updated_at_unix: Math.floor(Date.now() / 1000),
        })
      );
    } catch {
      // ignore
    }
  }, [selected, instanceId, fsPath, fsSelectedFile]);

  useEffect(() => {
    const daemonId = String(selected || "").trim();
    if (!daemonId) return;
    const inst = String(instanceId || "").trim() || "_";
    try {
      const raw = localStorage.getItem(`elegantmc_files_state_v1:${daemonId}:${inst}`) || "";
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const path = String(parsed?.path || "");
      const file = String(parsed?.file || "");
      if (file) {
        if (tab === "files" && selectedDaemon?.connected) {
          const p = openFileByPath(file);
          if (p && typeof (p as any).catch === "function") (p as any).catch(() => null);
        }
        return;
      }
      if (path && path !== fsPath) setFsPath(path);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, instanceId, tab, selectedDaemon?.connected]);

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

  function validateFsNameSegment(name: string) {
    const v = String(name || "").trim();
    if (!v) return "name is required";
    if (v.length > 128) return "name too long";
    if (v === "." || v === "..") return "invalid name";
    if (v.includes("/") || v.includes("\\")) return "name must not contain '/'";
    if (v.includes("\u0000")) return "name contains invalid characters";
    return "";
  }

  async function mkdirFsHere() {
    if (!selected) {
      setFsStatus("请选择 Daemon");
      return;
    }
    const name = await promptDialog({
      title: "New Folder",
      message: `Create a folder under servers/${fsPath || ""}`,
      placeholder: "folder name",
      okLabel: "Create",
      cancelLabel: "Cancel",
    });
    if (name == null) return;
    const err = validateFsNameSegment(name);
    if (err) {
      setFsStatus(err);
      return;
    }
    const target = joinRelPath(fsPath, name);
    setFsStatus(`Creating ${target} ...`);
    try {
      await callOkCommand("fs_mkdir", { path: target }, 30_000);
      await refreshFsNow();
      setFsStatus("Created");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function createFileHere() {
    if (!selected) {
      setFsStatus("请选择 Daemon");
      return;
    }
    const name = await promptDialog({
      title: "New File",
      message: `Create a file under servers/${fsPath || ""}`,
      placeholder: "filename (e.g. server.properties)",
      okLabel: "Create",
      cancelLabel: "Cancel",
    });
    if (name == null) return;
    const err = validateFsNameSegment(name);
    if (err) {
      setFsStatus(err);
      return;
    }
    const fileName = String(name || "").trim();
    if (fsEntries.find((e: any) => String(e?.name || "") === fileName)) {
      setFsStatus("File already exists");
      return;
    }

    const target = joinRelPath(fsPath, fileName);
    setFsStatus(`Creating ${target} ...`);
    try {
      await callOkCommand("fs_write", { path: target, b64: b64EncodeUtf8("") }, 30_000);
      await refreshFsNow();
      setFsSelectedFile(target);
      setFsFileText("");
      setFsSelectedFileMode("text");
      setFsStatus("Created");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function renameFsEntry(entry: any) {
    const name = String(entry?.name || "").trim();
    if (!name) return;
    const from = joinRelPath(fsPath, name);
    const next = await promptDialog({
      title: "Rename",
      message: `Rename ${entry?.isDir ? "folder" : "file"}:\n${from}`,
      defaultValue: name,
      placeholder: "new name",
      okLabel: "Rename",
      cancelLabel: "Cancel",
    });
    if (next == null) return;
    const toName = String(next || "").trim();
    const err = validateFsNameSegment(toName);
    if (err) {
      setFsStatus(err);
      return;
    }
    if (toName === name) {
      setFsStatus("No changes");
      setTimeout(() => setFsStatus(""), 700);
      return;
    }
    const to = joinRelPath(fsPath, toName);
    setFsStatus(`Renaming ${from} -> ${to} ...`);
    try {
      await callOkCommand("fs_move", { from, to }, 60_000);
      if (fsSelectedFile === from || fsSelectedFile.startsWith(`${from}/`)) {
        const suffix = fsSelectedFile.slice(from.length);
        setFsSelectedFile(`${to}${suffix}`);
      }
      await refreshFsNow();
      setFsStatus("Renamed");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function moveFsEntry(entry: any) {
    const name = String(entry?.name || "").trim();
    if (!name) return;
    const from = joinRelPath(fsPath, name);

    const next = await promptDialog({
      title: "Move",
      message: `Move ${entry?.isDir ? "folder" : "file"}:\n${from}\n\nTarget path is relative to servers/ (use /).`,
      defaultValue: from,
      placeholder: "target/path",
      okLabel: "Move",
      cancelLabel: "Cancel",
    });
    if (next == null) return;
    const toRaw = normalizeRelFilePath(next);
    if (!toRaw) {
      setFsStatus("invalid target path");
      return;
    }
    const to = toRaw;
    if (to === from) {
      setFsStatus("No changes");
      setTimeout(() => setFsStatus(""), 700);
      return;
    }

    setFsStatus(`Moving ${from} -> ${to} ...`);
    try {
      try {
        await callOkCommand("fs_stat", { path: to }, 10_000);
        setFsStatus("destination exists");
        return;
      } catch {
        // ok: target not found
      }
      await callOkCommand("fs_move", { from, to }, 60_000);
      if (fsSelectedFile === from || fsSelectedFile.startsWith(`${from}/`)) {
        const suffix = fsSelectedFile.slice(from.length);
        setFsSelectedFile(`${to}${suffix}`);
      }
      await refreshFsNow();
      setFsStatus("Moved");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function downloadFsEntry(entry: any) {
    const name = String(entry?.name || "").trim();
    if (!name || entry?.isDir) return;
    const path = joinRelPath(fsPath, name);
    const size = Math.max(0, Number(entry?.size || 0));
    const max = 15 * 1024 * 1024;
    if (size > max) {
      setFsStatus(`File too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)})`);
      return;
    }

    setFsStatus(`Downloading ${path} ...`);
    try {
      const payload = await callOkCommand("fs_read", { path }, 60_000);
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setFsStatus("");
      pushToast(`Downloaded: ${name}`, "ok");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function downloadFsFolderAsZip(entry: any) {
    const name = String(entry?.name || "").trim();
    if (!name || !entry?.isDir) return;
    const dirPath = joinRelPath(fsPath, name);

    setFsStatus(`Zipping ${dirPath} ...`);
    let zipPath = "";
    try {
      const out = await callOkCommand("fs_zip", { path: dirPath }, 10 * 60_000);
      zipPath = String(out?.zip_path || "").trim();
      if (!zipPath) throw new Error("zip_path missing");

      const st = await callOkCommand("fs_stat", { path: zipPath }, 10_000);
      const size = Math.max(0, Number(st?.size || 0));
      const max = 50 * 1024 * 1024;
      if (size > max) {
        throw new Error(`Zip too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)}). File: ${zipPath}`);
      }

      setFsStatus(`Downloading ${zipPath} ...`);
      const payload = await callOkCommand("fs_read", { path: zipPath }, 5 * 60_000);
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipPath.split("/").pop() || `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setFsStatus("");
      pushToast(`Downloaded: ${a.download}`, "ok");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    } finally {
      if (zipPath) {
        try {
          await callOkCommand("fs_delete", { path: zipPath }, 60_000);
        } catch {
          // ignore
        }
      }
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

	    const inTrash = target === "_trash" || target.startsWith("_trash/");
	    setFsStatus(inTrash ? `Deleting ${target} ...` : `Moving to trash: ${target} ...`);
	    try {
	      if (inTrash) {
	        await callOkCommand("fs_delete", { path: target }, 60_000);
	      } else {
	        await callOkCommand("fs_trash", { path: target }, 60_000);
	      }
      if (fsSelectedFile === target || fsSelectedFile.startsWith(`${target}/`)) {
        setFsSelectedFile("");
        setFsFileText("");
      }
      await refreshFsNow();
      setFsStatus(inTrash ? "Deleted" : "Moved to trash");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function openEntry(entry: any) {
    const name = entry?.name || "";
    if (!name) return;
    if (fsDirty) {
      const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
        title: "Unsaved Changes",
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;
    }
    if (entry?.isDir) {
      setFsSelectedFile("");
      setFsFileText("");
      setFsFileTextSaved("");
      setFsSelectedFileMode("none");
      setFsPath(joinRelPath(fsPath, name));
      return;
    }
    const size = Number(entry?.size || 0);
    const lower = String(name).toLowerCase();
    const filePath = joinRelPath(fsPath, name);
    const likelyBinaryExt =
      lower.endsWith(".jar") ||
      lower.endsWith(".zip") ||
      lower.endsWith(".png") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".gif") ||
      lower.endsWith(".webp") ||
      lower.endsWith(".ico") ||
      lower.endsWith(".pdf") ||
      lower.endsWith(".mp3") ||
      lower.endsWith(".mp4") ||
      lower.endsWith(".mkv") ||
      lower.endsWith(".wav") ||
      lower.endsWith(".ogg") ||
      lower.endsWith(".class") ||
      lower.endsWith(".dll") ||
      lower.endsWith(".exe") ||
      lower.endsWith(".so") ||
      lower.endsWith(".dat") ||
      lower.endsWith(".nbt");

    if (size > 512 * 1024 || likelyBinaryExt) {
      setFsSelectedFile(filePath);
      setFsFileText("");
      setFsFileTextSaved("");
      setFsSelectedFileMode("binary");
      setFsStatus("Binary/large file: download-only");
      return;
    }
    setFsStatus(`Reading ${filePath} ...`);
    try {
      const payload = await callOkCommand("fs_read", { path: filePath });
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
      if (isProbablyBinary(bytes)) {
        setFsSelectedFile(filePath);
        setFsFileText("");
        setFsFileTextSaved("");
        setFsSelectedFileMode("binary");
        setFsStatus("Binary file: download-only");
        return;
      }
      const text = new TextDecoder().decode(bytes);
      setFsSelectedFile(filePath);
      setFsSelectedFileMode("text");
      setFsFileText(text);
      setFsFileTextSaved(text);
      setFsStatus("");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function openFileByPath(path: string) {
    const p = String(path || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p) return;
    if (!selected) {
      setFsStatus("请选择 Daemon");
      return;
    }
    if (fsDirty) {
      const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
        title: "Unsaved Changes",
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;
    }

    const dir = parentRelPath(p);
    const name = p.split("/").filter(Boolean).pop() || "";
    if (!name) return;

    setFsPath(dir);
    setFsSelectedFile("");
    setFsFileText("");
    setFsFileTextSaved("");
    setFsSelectedFileMode("none");
    setFsStatus(`Opening ${p} ...`);

    try {
      const payload = await callOkCommand("fs_list", { path: dir }, 30_000);
      setFsEntries(payload.entries || []);

      const entry = (payload.entries || []).find((e: any) => String(e?.name || "") === name) || null;
      if (!entry) throw new Error("file not found");
      if (entry?.isDir) {
        setFsPath(p);
        setFsStatus("");
        return;
      }

      const size = Number(entry?.size || 0);
      const lower = String(name).toLowerCase();
      const filePath = joinRelPath(dir, name);
      const likelyBinaryExt =
        lower.endsWith(".jar") ||
        lower.endsWith(".zip") ||
        lower.endsWith(".png") ||
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".gif") ||
        lower.endsWith(".webp") ||
        lower.endsWith(".ico") ||
        lower.endsWith(".pdf") ||
        lower.endsWith(".mp3") ||
        lower.endsWith(".mp4") ||
        lower.endsWith(".mkv") ||
        lower.endsWith(".wav") ||
        lower.endsWith(".ogg") ||
        lower.endsWith(".class") ||
        lower.endsWith(".dll") ||
        lower.endsWith(".exe") ||
        lower.endsWith(".so") ||
        lower.endsWith(".dat") ||
        lower.endsWith(".nbt");

      if (size > 512 * 1024 || likelyBinaryExt) {
        setFsSelectedFile(filePath);
        setFsFileText("");
        setFsFileTextSaved("");
        setFsSelectedFileMode("binary");
        setFsStatus("Binary/large file: download-only");
        return;
      }

      const file = await callOkCommand("fs_read", { path: filePath }, 30_000);
      const bytes = b64DecodeBytes(String(file?.b64 || ""));
      if (isProbablyBinary(bytes)) {
        setFsSelectedFile(filePath);
        setFsFileText("");
        setFsFileTextSaved("");
        setFsSelectedFileMode("binary");
        setFsStatus("Binary file: download-only");
        return;
      }
      const text = new TextDecoder().decode(bytes);
      setFsSelectedFile(filePath);
      setFsSelectedFileMode("text");
      setFsFileText(text);
      setFsFileTextSaved(text);
      setFsStatus("");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function setServerJarFromFile(filePath: string) {
    const inst = instanceId.trim();
    if (!inst) {
      setFsStatus("Select a game first");
      return;
    }
    if (!selectedDaemon?.connected) {
      setFsStatus("daemon offline");
      return;
    }
    const p = String(filePath || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p || !p.toLowerCase().endsWith(".jar")) {
      setFsStatus("Not a .jar file");
      return;
    }
    if (p !== inst && !p.startsWith(`${inst}/`)) {
      setFsStatus(`Jar must be under servers/${inst}/`);
      return;
    }
    const jarRel = normalizeJarPath(inst, p);
    setFsStatus(`Setting server jar: ${jarRel} ...`);
    try {
      await writeInstanceConfig(inst, { jar_path: jarRel });
      setJarPath(jarRel);
      setFsStatus("Server jar updated");
      pushToast(`Server jar: ${jarRel}`, "ok");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function saveFile() {
    if (!fsSelectedFile) {
      setFsStatus("No file selected");
      return;
    }
    if (fsSelectedFileMode !== "text") {
      setFsStatus("Binary file: edit disabled (download instead)");
      return;
    }
    setFsStatus(`Saving ${fsSelectedFile} ...`);
    try {
      await callOkCommand("fs_write", { path: fsSelectedFile, b64: b64EncodeUtf8(fsFileText) });
      setFsFileTextSaved(fsFileText);
      setFsStatus("Saved");
      setTimeout(() => setFsStatus(""), 800);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function uploadFilesNow(filesLike: File[] | FileList) {
    const files = Array.isArray(filesLike) ? filesLike : Array.from(filesLike || []);
    const list = files.filter(Boolean);
    if (!list.length) {
      setUploadStatus("请选择文件");
      return;
    }
    if (!selected) {
      setUploadStatus("请选择 Daemon");
      return;
    }

    for (const file of list) {
      const err = validateFsNameSegment(file.name);
      if (err) {
        setUploadStatus(err);
        return;
      }

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
      } catch (e: any) {
        if (uploadID) {
          try {
            await callOkCommand("fs_upload_abort", { upload_id: uploadID });
          } catch {
            // ignore
          }
        }
        setUploadStatus(`Upload failed: ${String(e?.message || e)}`);
        return;
      }
    }

    setUploadFile(null);
    setUploadInputKey((k) => k + 1);
    try {
      const payload = await callOkCommand("fs_list", { path: fsPath });
      setFsEntries(payload.entries || []);
    } catch {
      // ignore
    }
  }

  async function uploadSelectedFile() {
    if (!uploadFile) {
      setUploadStatus("请选择文件");
      return;
    }
    await uploadFilesNow([uploadFile]);
  }

  async function uploadZipAndExtractHere() {
    if (!uploadFile) {
      setUploadStatus("请选择 zip 文件");
      return;
    }
    if (!selected) {
      setUploadStatus("请选择 Daemon");
      return;
    }
    if (!fsPath) {
      setUploadStatus("请选择一个目标文件夹（不能解压到 servers/ 根目录）");
      return;
    }

    const file = uploadFile;
    const name = String(file.name || "").toLowerCase();
    if (!name.endsWith(".zip")) {
      setUploadStatus("只支持 .zip 文件");
      return;
    }

    const destPath = joinRelPath(fsPath, file.name);
    try {
      await uploadFilesNow([file]);
      setUploadStatus(`Extracting ${destPath} ...`);
      await callOkCommand("fs_unzip", { zip_path: destPath, dest_dir: fsPath, instance_id: fsPath, strip_top_level: false }, 10 * 60_000);
      try {
        await callOkCommand("fs_delete", { path: destPath }, 60_000);
      } catch {
        // ignore
      }
      await refreshFsNow();
      setUploadStatus("Extracted");
      setTimeout(() => setUploadStatus(""), 1200);
    } catch (e: any) {
      setUploadStatus(String(e?.message || e));
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

  async function runMarketSearch() {
    if (installRunning) return;
    const provider = installForm.kind;
    if (provider !== "modrinth" && provider !== "curseforge") return;
    if (provider === "curseforge" && !curseforgeEnabled) {
      setMarketStatus("CurseForge is disabled (configure API key in Panel settings)");
      return;
    }
    const q = String(marketQuery || "").trim();
    if (!q) return;

    setMarketStatus("Searching...");
    setMarketResults([]);
    setMarketSelected(null);
    setMarketVersions([]);
    setMarketSelectedVersionId("");
    setCfResolveStatus("");
    setInstallForm((f) => ({ ...f, remoteUrl: "", remoteFileName: "" }));

    try {
      const params = new URLSearchParams();
      params.set("provider", provider);
      params.set("query", q);
      params.set("limit", "12");
      params.set("offset", "0");
      const res = await apiFetch(`/api/modpacks/search?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "search failed");
      const results = Array.isArray(json?.results) ? json.results : [];
      setMarketResults(results);
      setMarketStatus(results.length ? `Found ${results.length} result(s)` : "No results");
    } catch (e: any) {
      setMarketStatus(String(e?.message || e));
    }
  }

  async function resolveCurseForgeUrl() {
    if (installRunning) return;
    const inputUrl = String(installForm.remoteUrl || "").trim();
    if (!inputUrl) return;

    setCfResolveBusy(true);
    setCfResolveStatus("Resolving...");
    try {
      const params = new URLSearchParams();
      params.set("url", inputUrl);
      const res = await apiFetch(`/api/modpacks/curseforge/resolve-url?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "resolve failed");

      const resolved = String(json?.resolved || "").trim();
      const fileName = String(json?.file_name || "").trim();
      if (!resolved) throw new Error("no resolved url");
      setInstallForm((f) => ({
        ...f,
        remoteUrl: resolved,
        remoteFileName: f.remoteFileName || fileName,
      }));
      setCfResolveStatus("Resolved");
      window.setTimeout(() => setCfResolveStatus(""), 1200);
    } catch (e: any) {
      setCfResolveStatus(String(e?.message || e));
    } finally {
      setCfResolveBusy(false);
    }
  }

  async function pickJarFromInstanceRoot(inst: string, fallback: string) {
    const fb = normalizeJarPath(inst, fallback);
    try {
      const out = await callOkCommand("mc_detect_jar", { instance_id: inst }, 30_000);
      const best = String(out?.best || "").trim();
      if (best) return normalizeJarPath(inst, best);
    } catch {
      // ignore
    }
    return fb || "server.jar";
  }

  async function installModrinthMrpack(inst: string, mrpackRel: string, jarRel: string) {
    const tmpRoot = joinRelPath(inst, ".elegantmc_tmp");
    const tmpDir = joinRelPath(tmpRoot, "mrpack");

    // Clean old temp, then unzip to temp (avoid collisions with instance root).
    try {
      await callOkCommand("fs_delete", { path: tmpDir }, 30_000);
    } catch {
      // ignore
    }
    await callOkCommand("fs_mkdir", { path: tmpDir }, 30_000);
    await callOkCommand("fs_unzip", { zip_path: mrpackRel, dest_dir: tmpDir, instance_id: inst, strip_top_level: true }, 10 * 60_000);

    // Read modrinth index
    const indexPath = joinRelPath(tmpDir, "modrinth.index.json");
    const out = await callOkCommand("fs_read", { path: indexPath }, 20_000);
    const text = b64DecodeUtf8(String(out.b64 || ""));
    let index: any = null;
    try {
      index = JSON.parse(text);
    } catch {
      throw new Error("invalid modrinth.index.json");
    }

    const deps = index?.dependencies || {};
    const mc = String(deps.minecraft || "").trim();
    const fabricLoader = String(deps["fabric-loader"] || "").trim();
    const quiltLoader = String(deps["quilt-loader"] || "").trim();
    const forge = String(deps.forge || "").trim();
    const neoForge = String(deps.neoforge || deps["neo-forge"] || "").trim();

    if (!mc) throw new Error("mrpack missing dependencies.minecraft");
    if (!fabricLoader && !quiltLoader) {
      if (forge || neoForge) throw new Error("Forge/NeoForge mrpack is not supported yet (please use a server pack zip)");
      throw new Error("mrpack missing supported loader dependency (fabric-loader/quilt-loader)");
    }
    const loaderKind = fabricLoader ? "fabric" : quiltLoader ? "quilt" : "";
    const loaderVer = loaderKind === "fabric" ? fabricLoader : quiltLoader;

    // Apply overrides -> instance root (if present).
    const overridesDir = joinRelPath(tmpDir, "overrides");
    try {
      const ls = await callOkCommand("fs_list", { path: overridesDir }, 20_000);
      const entries = Array.isArray(ls?.entries) ? ls.entries : [];
      for (const ent of entries) {
        const name = String(ent?.name || "").trim();
        if (!name || name === "." || name === "..") continue;
        await callOkCommand("fs_move", { from: joinRelPath(overridesDir, name), to: joinRelPath(inst, name) }, 60_000);
      }
      try {
        await callOkCommand("fs_delete", { path: overridesDir }, 30_000);
      } catch {
        // ignore
      }
    } catch {
      // overrides are optional
    }

    // Download files (mods/config/etc) listed in the index.
    const files = Array.isArray(index?.files) ? index.files : [];
    const queue = files
      .map((f: any) => {
        const envServer = String(f?.env?.server || "").trim().toLowerCase();
        if (envServer === "unsupported") return null;
        const rel = normalizeRelFilePath(String(f?.path || ""));
        if (!rel) return null;
        const downloads = Array.isArray(f?.downloads) ? f.downloads : [];
        const url = String(downloads[0] || "").trim();
        if (!url) throw new Error(`mrpack file missing download url: ${rel}`);
        const sha1 = String(f?.hashes?.sha1 || "").trim();
        return { rel, url, sha1 };
      })
      .filter(Boolean) as { rel: string; url: string; sha1: string }[];

    const total = queue.length;
    let done = 0;
    if (total) setServerOpStatus(`Downloading mrpack files: 0/${total} ...`);

    const concurrency = Math.max(1, Math.min(4, total));
    let failed: any = null;
    const workers = Array.from({ length: concurrency }).map(async () => {
      while (queue.length && !failed) {
        const item = queue.shift();
        if (!item) break;
        try {
          await callOkCommand(
            "fs_download",
            { path: joinRelPath(inst, item.rel), url: item.url, ...(isHex40(item.sha1) ? { sha1: item.sha1 } : {}), instance_id: inst },
            10 * 60_000
          );
          done++;
          if (total) setServerOpStatus(`Downloading mrpack files: ${done}/${total} ...`);
        } catch (e) {
          failed = e || new Error("download failed");
          throw failed;
        }
      }
    });
    await Promise.all(workers);

    // Install loader server launcher jar.
    if (loaderKind === "quilt") {
      setServerOpStatus(`Installing Quilt server (${mc} / loader ${loaderVer}) ...`);
      const res = await apiFetch(
        `/api/mc/quilt/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`,
        { cache: "no-store" }
      );
      const resolved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(resolved?.error || "failed to resolve Quilt server jar");

      const serverJarUrl = String(resolved?.url || "").trim();
      if (!serverJarUrl) throw new Error("quilt server jar url missing");
      await callOkCommand("fs_download", { path: joinRelPath(inst, jarRel), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
    } else {
      setServerOpStatus(`Installing Fabric server (${mc} / loader ${loaderVer}) ...`);
      const res = await apiFetch(
        `/api/mc/fabric/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`,
        { cache: "no-store" }
      );
      const resolved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(resolved?.error || "failed to resolve Fabric server jar");

      const serverJarUrl = String(resolved?.url || "").trim();
      if (!serverJarUrl) throw new Error("fabric server jar url missing");
      await callOkCommand("fs_download", { path: joinRelPath(inst, jarRel), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
    }

    // Best-effort cleanup (keep tmpRoot for debugging if deletion fails).
    try {
      await callOkCommand("fs_delete", { path: tmpRoot }, 60_000);
    } catch {
      // ignore
    }
  }

  function pickModrinthVersion(versionId: string, listOverride?: any[]) {
    const id = String(versionId || "").trim();
    setMarketSelectedVersionId(id);
    const list = Array.isArray(listOverride) ? listOverride : marketVersions;
    const v = (Array.isArray(list) ? list : []).find((x: any) => String(x?.id || "") === id) || null;
    const files = Array.isArray(v?.files) ? v.files : [];
    const file = files.find((f: any) => !!f?.primary) || files[0] || null;
    const url = String(file?.url || "").trim();
    const name = String(file?.filename || "").trim();
    if (!url) {
      setInstallForm((f) => ({ ...f, remoteUrl: "", remoteFileName: "" }));
      setMarketStatus("No downloadable file for this version");
      return;
    }
    setInstallForm((f) => ({ ...f, remoteUrl: url, remoteFileName: name }));
    setMarketStatus("");
  }

  async function pickCurseForgeFile(fileId: string, listOverride?: any[]) {
    const id = String(fileId || "").trim();
    setMarketSelectedVersionId(id);
    setInstallForm((f) => ({ ...f, remoteUrl: "", remoteFileName: "" }));
    if (!id) return;

    const list = Array.isArray(listOverride) ? listOverride : marketVersions;
    const file = (Array.isArray(list) ? list : []).find((x: any) => String(x?.id || "") === id) || null;
    const name = String(file?.file_name || file?.display_name || "").trim();

    setMarketStatus("Resolving download url...");
    try {
      const res = await apiFetch(`/api/modpacks/curseforge/files/${encodeURIComponent(id)}/download-url`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
      const url = String(json?.url || "").trim();
      if (!url) throw new Error("no download url");
      setInstallForm((f) => ({ ...f, remoteUrl: url, remoteFileName: name }));
      setMarketStatus("");
    } catch (e: any) {
      setMarketStatus(String(e?.message || e));
    }
  }

  async function selectMarketPack(p: any) {
    if (installRunning) return;
    const provider = installForm.kind;
    if (provider !== "modrinth" && provider !== "curseforge") return;
    const id = String(p?.id || "").trim();
    if (!id) return;

    setMarketSelected(p);
    setMarketVersions([]);
    setMarketSelectedVersionId("");
    setInstallForm((f) => ({ ...f, remoteUrl: "", remoteFileName: "" }));

    try {
      if (provider === "modrinth") {
        setMarketStatus("Loading versions...");
        const res = await apiFetch(`/api/modpacks/modrinth/${encodeURIComponent(id)}/versions`);
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || "fetch versions failed");
        const versions = Array.isArray(json?.versions) ? json.versions : [];
        setMarketVersions(versions);
        const first = versions[0];
        if (first?.id) pickModrinthVersion(String(first.id), versions);
        else setMarketStatus("No versions");
        return;
      }

      setMarketStatus("Loading files...");
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("offset", "0");
      const res = await apiFetch(`/api/modpacks/curseforge/${encodeURIComponent(id)}/files?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "fetch files failed");
      const files = Array.isArray(json?.files) ? json.files : [];
      setMarketVersions(files);
      const first = files[0];
      if (first?.id) await pickCurseForgeFile(String(first.id), files);
      else setMarketStatus("No files");
    } catch (e: any) {
      setMarketStatus(String(e?.message || e));
    }
  }

	  function openInstallModal() {
	    refreshModpackProviders();
	    const suggested = suggestInstanceId(serverDirs);
	    const jarNameOnly = normalizeJarName(jarPath);
	    const jarRel = normalizeJarPath(suggested, jarPath);
	    const defaults = panelSettings?.defaults || {};
	    let preferredKind = "";
	    try {
	      preferredKind = String(localStorage.getItem("elegantmc_install_kind") || "").trim();
	    } catch {
	      preferredKind = "";
	    }
	    const defaultVersion = String(defaults.version || "1.20.1");
	    const defaultXms = String(defaults.xms || xms);
	    const defaultXmx = String(defaults.xmx || xmx);
	    const defaultGamePortRaw = Math.round(Number(defaults.game_port ?? gamePort));
	    const defaultGamePort = Number.isFinite(defaultGamePortRaw) && defaultGamePortRaw >= 1 && defaultGamePortRaw <= 65535 ? defaultGamePortRaw : gamePort;
	    const defaultAcceptEula = defaults.accept_eula == null ? true : !!defaults.accept_eula;
	    const defaultEnableFrp = defaults.enable_frp == null ? enableFrp : !!defaults.enable_frp;
	    const defaultFrpRemoteRaw = Math.round(Number(defaults.frp_remote_port ?? frpRemotePort));
	    const defaultFrpRemotePort =
	      Number.isFinite(defaultFrpRemoteRaw) && defaultFrpRemoteRaw >= 0 && defaultFrpRemoteRaw <= 65535 ? defaultFrpRemoteRaw : frpRemotePort;
	    const profileId =
	      profiles.find((p) => p.id === frpProfileId)?.id || profiles[0]?.id || "";
	    setInstallForm((prev) => {
	      const isKind = (k: any) =>
	        k === "paper" || k === "zip" || k === "zip_url" || k === "modrinth" || k === "curseforge" || k === "vanilla";
	      const chosenKind = isKind(preferredKind) ? preferredKind : isKind(prev?.kind) ? prev.kind : "vanilla";
	      const relJar =
	        chosenKind === "zip" || chosenKind === "zip_url" || chosenKind === "modrinth" || chosenKind === "curseforge" ? jarRel : jarNameOnly;
	      return {
	        instanceId: suggested,
	        kind: chosenKind,
	        version: String(prev?.version || defaultVersion),
	        paperBuild: Number.isFinite(Number(prev?.paperBuild)) ? Number(prev?.paperBuild) : 0,
	        xms: defaultXms,
	        xmx: defaultXmx,
	        gamePort: defaultGamePort,
	        jarName: relJar,
	        javaPath,
	        acceptEula: prev?.acceptEula ?? defaultAcceptEula,
	        enableFrp: defaultEnableFrp,
	        frpProfileId: profileId,
	        frpRemotePort: defaultFrpRemotePort,
	        remoteUrl: "",
	        remoteFileName: "",
	      };
	    });
	    setInstallZipFile(null);
	    setInstallZipInputKey((k) => k + 1);
	    setInstallStartUnix(0);
	    setInstallInstance("");
	    setInstallStep(1);
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
	    const kind = installForm.kind;
	    const ver = String(installForm.version || "").trim();
	    if ((kind === "vanilla" || kind === "paper") && !ver) {
	      setServerOpStatus("version 不能为空");
	      return;
	    }
	    const jarErr =
	      kind === "zip" || kind === "zip_url" || kind === "modrinth" || kind === "curseforge"
	        ? validateJarPathUI(installForm.jarName)
	        : validateJarNameUI(installForm.jarName);
	    if (jarErr) {
	      setServerOpStatus(jarErr);
	      return;
	    }

	    setInstallInstance(inst);
	    setInstallStartUnix(Math.floor(Date.now() / 1000));
	    setInstallRunning(true);

	    try {
	      const jarInput = String(installForm.jarName || "").trim();
	      const jarRel =
	        kind === "vanilla" || kind === "paper" ? normalizeJarName(jarInput) : normalizeJarPath(inst, jarInput);
	      let installedJar = jarRel;
	      if (kind === "zip") {
	        const file = installZipFile;
	        if (!file) throw new Error("zip/mrpack file is required");

	        // Ensure instance dir exists, then upload + extract.
	        await callOkCommand("fs_mkdir", { path: inst }, 30_000);

	        const uploadName = String(file.name || "").toLowerCase().endsWith(".mrpack") ? "modpack.mrpack" : "modpack.zip";
	        const zipRel = joinRelPath(inst, uploadName);
	        const chunkSize = 256 * 1024; // 256KB
	        let uploadID = "";
	        setServerOpStatus(`Uploading ${uploadName}: 0/${file.size} bytes`);
	        try {
	          const begin = await callOkCommand("fs_upload_begin", { path: zipRel }, 30_000);
	          uploadID = String(begin.upload_id || "");
	          if (!uploadID) throw new Error("upload_id missing");

	          for (let off = 0; off < file.size; off += chunkSize) {
	            const end = Math.min(off + chunkSize, file.size);
	            const ab = await file.slice(off, end).arrayBuffer();
	            const b64 = b64EncodeBytes(new Uint8Array(ab));
	            await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 }, 60_000);
	            setServerOpStatus(`Uploading ${uploadName}: ${end}/${file.size} bytes`);
	          }

	          await callOkCommand("fs_upload_commit", { upload_id: uploadID }, 60_000);
	        } catch (e) {
	          if (uploadID) {
	            try {
	              await callOkCommand("fs_upload_abort", { upload_id: uploadID }, 10_000);
	            } catch {
	              // ignore
	            }
	          }
	          throw e;
	        }

	        if (uploadName.toLowerCase().endsWith(".mrpack")) {
	          setServerOpStatus(`Installing ${uploadName} (.mrpack) ...`);
	          await installModrinthMrpack(inst, zipRel, jarRel);
	        } else {
	          setServerOpStatus(`Extracting ${uploadName} ...`);
	          await callOkCommand(
	            "fs_unzip",
	            { zip_path: zipRel, dest_dir: inst, instance_id: inst, strip_top_level: true },
	            10 * 60_000
	          );
	          installedJar = await pickJarFromInstanceRoot(inst, installedJar);
	        }
	        try {
	          await callOkCommand("fs_delete", { path: zipRel }, 30_000);
	        } catch {
	          // ignore
	        }
		        setInstallZipFile(null);
		        setInstallZipInputKey((k) => k + 1);
		      } else if (kind === "zip_url" || kind === "modrinth" || kind === "curseforge") {
		        const remoteUrl = String(installForm.remoteUrl || "").trim();
		        if (!remoteUrl) throw new Error("remote url is required");

		        // Ensure instance dir exists, then download + extract.
		        await callOkCommand("fs_mkdir", { path: inst }, 30_000);

		        const defaultName =
		          kind === "modrinth"
		            ? "modpack.mrpack"
		            : kind === "zip_url"
		              ? /\.mrpack(\?|$)/i.test(remoteUrl)
		                ? "modpack.mrpack"
		                : "modpack.zip"
		              : "modpack.zip";
		        const fileName = normalizeDownloadName(String(installForm.remoteFileName || "").trim(), defaultName);
		        const zipRel = joinRelPath(inst, fileName);

		        setServerOpStatus(`Downloading ${fileName} ...`);
		        await callOkCommand("fs_download", { path: zipRel, url: remoteUrl, instance_id: inst }, 10 * 60_000);

		        if ((kind === "modrinth" || kind === "zip_url") && fileName.toLowerCase().endsWith(".mrpack")) {
		          setServerOpStatus(`Installing ${fileName} (.mrpack) ...`);
		          await installModrinthMrpack(inst, zipRel, jarRel);
		        } else {
		          setServerOpStatus(`Extracting ${fileName} ...`);
		          await callOkCommand(
		            "fs_unzip",
		            { zip_path: zipRel, dest_dir: inst, instance_id: inst, strip_top_level: true },
		            10 * 60_000
		          );
		          installedJar = await pickJarFromInstanceRoot(inst, installedJar);
		        }
		        try {
		          await callOkCommand("fs_delete", { path: zipRel }, 30_000);
		        } catch {
		          // ignore
		        }
		      } else {
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
	            jar_name: jarRel,
	            accept_eula: !!installForm.acceptEula,
	          },
	          10 * 60_000
	        );
	        installedJar = String(out.jar_path || jarRel);
	      }

	      if ((kind === "zip" || kind === "zip_url" || kind === "modrinth" || kind === "curseforge") && installForm.acceptEula) {
	        setServerOpStatus("Writing eula.txt ...");
	        await callOkCommand(
	          "fs_write",
	          { path: joinRelPath(inst, "eula.txt"), b64: b64EncodeUtf8("eula=true\n") },
	          10_000
	        );
	      }

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

      // Refresh list + focus the newly installed instance.
      setInstanceId(inst);
      try {
        await refreshServerDirs();
      } catch {
        // ignore
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
    setSettingsSearch("");
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
    if (gameActionBusy) return;
    setGameActionBusy(true);
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

      const eulaPath = joinRelPath(inst, "eula.txt");
      try {
        const out = await callOkCommand("fs_read", { path: eulaPath }, 10_000);
        const text = b64DecodeUtf8(String(out?.b64 || ""));
        const v = String(getPropValue(text, "eula") || "").trim().toLowerCase();
        if (v !== "true") {
          const ok = await confirmDialog(
            `Minecraft requires accepting the Mojang EULA.\n\nWrite servers/${inst}/eula.txt with eula=true?`,
            { title: "Accept EULA", confirmLabel: "Accept", cancelLabel: "Cancel" }
          );
          if (!ok) {
            setServerOpStatus("Cancelled");
            return;
          }
          setServerOpStatus("Writing eula.txt ...");
          await callOkCommand("fs_write", { path: eulaPath, b64: b64EncodeUtf8("eula=true\n") }, 10_000);
        }
      } catch (e: any) {
        const ok = await confirmDialog(
          `Minecraft requires accepting the Mojang EULA.\n\nWrite servers/${inst}/eula.txt with eula=true?`,
          { title: "Accept EULA", confirmLabel: "Accept", cancelLabel: "Cancel" }
        );
        if (!ok) {
          setServerOpStatus("Cancelled");
          return;
        }
        setServerOpStatus("Writing eula.txt ...");
        await callOkCommand("fs_write", { path: eulaPath, b64: b64EncodeUtf8("eula=true\n") }, 10_000);
      }

      await callOkCommand(
        "mc_start",
        { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms: xmsVal, xmx: xmxVal },
        10 * 60_000
      );
      setServerOpStatus("MC started");

      if (enable) {
        const profile = profiles.find((p) => p.id === pid) || null;
        if (!profile) {
          setFrpOpStatus("FRP enabled but no profile selected");
          return;
        }
        let token = "";
        try {
          token = profile?.has_token ? await fetchFrpProfileToken(profile.id) : "";
        } catch (e: any) {
          throw new Error(`FRP token: ${String(e?.message || e)}`);
        }
        const args: any = {
          instance_id: inst,
          server_addr: profile.server_addr,
          server_port: Number(profile.server_port),
          token,
          local_port: port,
          remote_port: Number.isFinite(remotePort) ? remotePort : 0,
        };
        await callOkCommand("frp_start", args, 30_000);
        setFrpOpStatus("FRP started");
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function stopServer(instanceOverride?: string) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
    setServerOpStatus("");
    try {
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setServerOpStatus("instance_id 不能为空");
        return;
      }
      try {
        await callOkCommand("frp_stop", { instance_id: inst }, 30_000);
        setFrpOpStatus("FRP stopped");
      } catch {
        // ignore
      }
      await callOkCommand("mc_stop", { instance_id: inst }, 30_000);
      setServerOpStatus("MC stopped");
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

	  async function deleteServer(instanceOverride?: string) {
	    if (gameActionBusy) return;
	    setGameActionBusy(true);
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

	      try {
	        await callOkCommand("frp_stop", { instance_id: id }, 30_000);
	        setFrpOpStatus("FRP stopped");
      } catch {
        // ignore
      }
	      try {
	        await callOkCommand("mc_stop", { instance_id: id }, 30_000);
	      } catch {
	        // ignore
	      }

      const out = await callOkCommand("fs_trash", { path: id }, 60_000);
      const trashPath = String(out?.trash_path || "").trim();
      setServerOpStatus(trashPath ? `Moved to trash: ${trashPath}` : `Moved to trash`);
      setInstanceId("");
      if (fsPath === id || fsPath.startsWith(`${id}/`)) {
        setFsPath("");
        setFsSelectedFile("");
        setFsFileText("");
      }
      try {
        await refreshServerDirs();
      } catch {
        // ignore
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function restartServer(instanceOverride?: string) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
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
      await callOkCommand("mc_restart", { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms, xmx }, 10 * 60_000);
      setServerOpStatus("MC restarted");

      if (enableFrp) {
        const profile = profiles.find((p) => p.id === frpProfileId) || null;
        if (!profile) {
          setFrpOpStatus("FRP enabled but no profile selected");
          return;
        }
        let token = "";
        try {
          token = profile?.has_token ? await fetchFrpProfileToken(profile.id) : "";
        } catch (e: any) {
          throw new Error(`FRP token: ${String(e?.message || e)}`);
        }
        const remotePort = Math.round(Number(frpRemotePort ?? 0));
        await callOkCommand(
          "frp_start",
          {
            instance_id: inst,
            server_addr: profile.server_addr,
            server_port: Number(profile.server_port),
            token,
            local_port: Math.round(Number(gamePort || 25565)),
            remote_port: Number.isFinite(remotePort) ? remotePort : 0,
          },
          30_000
        );
        setFrpOpStatus("FRP started");
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function renameInstance() {
    if (gameActionBusy) return;
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const from = instanceId.trim();
    if (!from) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }

    const next = await promptDialog({
      title: "Rename Instance",
      message: `Rename ${from} → ?\n\nThis will move its folder under servers/ and may require restarting.`,
      defaultValue: from,
      placeholder: "new-instance-id",
      okLabel: "Continue",
      cancelLabel: "Cancel",
    });
    if (next == null) return;
    const to = String(next || "").trim();
    const err = validateInstanceIDUI(to);
    if (err) {
      setServerOpStatus(err);
      return;
    }
    if (to === from) {
      setServerOpStatus("No changes");
      setTimeout(() => setServerOpStatus(""), 700);
      return;
    }

    const ok = await confirmDialog(`Rename instance ${from} → ${to}?`, {
      title: "Rename Instance",
      confirmLabel: "Rename",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setGameActionBusy(true);
    setServerOpStatus(`Renaming ${from} -> ${to} ...`);
    try {
      try {
        await callOkCommand("frp_stop", { instance_id: from }, 30_000);
      } catch {
        // ignore
      }
      try {
        await callOkCommand("mc_stop", { instance_id: from }, 30_000);
      } catch {
        // ignore
      }

      await callOkCommand("fs_move", { from, to }, 60_000);
      try {
        await callOkCommand("fs_move", { from: joinRelPath("_backups", from), to: joinRelPath("_backups", to) }, 60_000);
      } catch {
        // ignore
      }

      if (fsPath === from || fsPath.startsWith(`${from}/`)) setFsPath(`${to}${fsPath.slice(from.length)}`);
      if (fsPath === joinRelPath("_backups", from) || fsPath.startsWith(`${joinRelPath("_backups", from)}/`)) {
        const prefix = joinRelPath("_backups", from);
        setFsPath(`${joinRelPath("_backups", to)}${fsPath.slice(prefix.length)}`);
      }
      if (fsSelectedFile === from || fsSelectedFile.startsWith(`${from}/`)) setFsSelectedFile(`${to}${fsSelectedFile.slice(from.length)}`);

      await refreshServerDirs();
      setInstanceId(to);
      setServerOpStatus("Renamed");
      setTimeout(() => setServerOpStatus(""), 900);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function cloneInstance() {
    if (gameActionBusy) return;
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const from = instanceId.trim();
    if (!from) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }

    const next = await promptDialog({
      title: "Clone Instance",
      message: `Clone ${from} → ?\n\nThis will create a backup then restore it into a new instance folder.`,
      placeholder: "new-instance-id",
      okLabel: "Continue",
      cancelLabel: "Cancel",
    });
    if (next == null) return;
    const to = String(next || "").trim();
    const err = validateInstanceIDUI(to);
    if (err) {
      setServerOpStatus(err);
      return;
    }
    if (to === from) {
      setServerOpStatus("Clone target must be different");
      return;
    }

    const ok = await confirmDialog(`Clone instance ${from} → ${to}?`, {
      title: "Clone Instance",
      confirmLabel: "Clone",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setGameActionBusy(true);
    setServerOpStatus("Cloning...");
    try {
      const backupName = `${from}-clone-${Date.now()}.zip`;
      const backup = await callOkCommand("mc_backup", { instance_id: from, stop: true, backup_name: backupName }, 10 * 60_000);
      const zip = String(backup?.path || "").trim();
      if (!zip) throw new Error("backup path missing");
      await callOkCommand("mc_restore", { instance_id: to, zip_path: zip }, 10 * 60_000);
      await refreshServerDirs();
      setInstanceId(to);
      setServerOpStatus(`Cloned: ${to}`);
      setTimeout(() => setServerOpStatus(""), 900);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function computeInstanceUsage(instanceOverride?: string) {
    if (instanceUsageBusy) return;
    if (!selectedDaemon?.connected) {
      setInstanceUsageStatus("daemon offline");
      return;
    }
    const inst = String(instanceOverride ?? instanceId).trim();
    if (!inst) {
      setInstanceUsageStatus("instance_id 不能为空");
      return;
    }

    setInstanceUsageBusy(true);
    setInstanceUsageBytes(null);
    setInstanceUsageStatus("Scanning...");
    try {
      const maxEntries = 25_000;
      let total = 0;
      let scanned = 0;
      const stack: string[] = [inst];

      while (stack.length) {
        const dir = stack.pop()!;
        const out = await callOkCommand("fs_list", { path: dir }, 30_000);
        for (const e of out.entries || []) {
          scanned++;
          if (scanned > maxEntries) throw new Error(`too many entries (> ${maxEntries}), abort`);
          const name = String(e?.name || "").trim();
          if (!name || name === "." || name === "..") continue;
          if (e?.isDir) stack.push(joinRelPath(dir, name));
          else total += Math.max(0, Number(e?.size || 0));
        }
      }

      setInstanceUsageBytes(total);
      setInstanceUsageStatus("");
    } catch (e: any) {
      setInstanceUsageBytes(null);
      setInstanceUsageStatus(String(e?.message || e));
    } finally {
      setInstanceUsageBusy(false);
    }
  }

  async function backupServer(instanceOverride?: string) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
    setServerOpStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error("daemon offline");
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) throw new Error("instance_id 不能为空");
      setServerOpStatus("Creating backup...");
      const out = await callOkCommand("mc_backup", { instance_id: inst, stop: true }, 10 * 60_000);
      const path = String(out?.path || "").trim();
      setServerOpStatus(path ? `Backup created: ${path}` : "Backup created");
      await refreshBackupZips(inst);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function exportInstanceZip() {
    if (gameActionBusy) return;
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }

    setGameActionBusy(true);
    setServerOpStatus("Exporting zip...");
    let zipPath = "";
    try {
      const out = await callOkCommand("fs_zip", { path: inst }, 10 * 60_000);
      zipPath = String(out?.zip_path || "").trim();
      if (!zipPath) throw new Error("zip_path missing");

      const st = await callOkCommand("fs_stat", { path: zipPath }, 10_000);
      const size = Math.max(0, Number(st?.size || 0));
      const max = 200 * 1024 * 1024;
      if (size > max) {
        throw new Error(`Zip too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)}). File: ${zipPath}`);
      }

      setServerOpStatus(`Downloading ${zipPath} ...`);
      const payload = await callOkCommand("fs_read", { path: zipPath }, 10 * 60_000);
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${inst}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast(`Exported: ${inst}.zip`, "ok");
      setServerOpStatus("Exported");
      setTimeout(() => setServerOpStatus(""), 900);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      if (zipPath) {
        try {
          await callOkCommand("fs_delete", { path: zipPath }, 60_000);
        } catch {
          // ignore
        }
      }
      setGameActionBusy(false);
    }
  }

  async function refreshRestoreCandidates(inst: string) {
    const id = String(inst || "").trim();
    if (!id) return;
    setRestoreStatus("Loading backups...");
    try {
      const base = joinRelPath("_backups", id);
      const out = await callOkCommand("fs_list", { path: base }, 30_000);
      const list = (out.entries || [])
        .filter((e: any) => !e?.isDir && e?.name && String(e.name).toLowerCase().endsWith(".zip"))
        .map((e: any) => joinRelPath(base, String(e.name)));
      list.sort((a: string, b: string) => b.localeCompare(a));
      setRestoreCandidates(list);
      setRestoreZipPath(list[0] || "");
      setRestoreStatus(list.length ? "" : "No backups found");
    } catch {
      setRestoreCandidates([]);
      setRestoreZipPath("");
      setRestoreStatus("No backups found");
    }
  }

  async function refreshBackupZips(instanceOverride?: string) {
    const inst = String(instanceOverride ?? instanceId).trim();
    if (!inst) return;
    await refreshRestoreCandidates(inst);
  }

  async function openRestoreModal() {
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }
    setRestoreCandidates([]);
    setRestoreZipPath("");
    setRestoreStatus("");
    setRestoreOpen(true);
    await refreshBackupZips(inst);
  }

  async function restoreFromBackup() {
    if (gameActionBusy) return;
    const inst = instanceId.trim();
    const zip = String(restoreZipPath || "").trim();
    if (!inst) {
      setRestoreStatus("instance_id 不能为空");
      return;
    }
    if (!zip) {
      setRestoreStatus("Select a backup first");
      return;
    }

    const ok = await confirmDialog(`Restore ${inst} from ${zip}?\n\nThis will OVERWRITE servers/${inst}/`, {
      title: "Restore Backup",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    const typed = await promptDialog({
      title: "Confirm Restore",
      message: `Type "${inst}" to confirm restoring from backup.`,
      placeholder: inst,
      defaultValue: "",
      okLabel: "Restore",
      cancelLabel: "Cancel",
    });
    if (typed !== inst) {
      setRestoreStatus("Cancelled");
      return;
    }

    setGameActionBusy(true);
    setRestoreStatus("Stopping server...");
    setServerOpStatus("");
    try {
      try {
        await callOkCommand("frp_stop", { instance_id: inst }, 30_000);
      } catch {
        // ignore
      }
      try {
        await callOkCommand("mc_stop", { instance_id: inst }, 30_000);
      } catch {
        // ignore
      }

      setRestoreStatus("Restoring...");
      await callOkCommand("mc_restore", { instance_id: inst, zip_path: zip }, 10 * 60_000);
      setRestoreStatus(`Restored: ${zip}`);
      setServerOpStatus("Restored");
      setRestoreOpen(false);
    } catch (e: any) {
      setRestoreStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function refreshTrashItems(showAllOverride?: boolean) {
    const showAll = showAllOverride != null ? !!showAllOverride : trashShowAll;
    if (!selectedDaemon?.connected) {
      setTrashStatus("daemon offline");
      setTrashItems([]);
      return;
    }
    setTrashStatus("Loading trash...");
    try {
      const out = await callOkCommand("fs_trash_list", { limit: 200 }, 30_000);
      const items = Array.isArray(out?.items) ? out.items : [];
      const filtered = items.filter((it: any) => {
        const info = it?.info || {};
        const orig = String(info?.original_path || "").trim();
        if (!orig) return false;
        if (!showAll) {
          if (orig.includes("/")) return false;
          if (orig.startsWith("_") || orig.startsWith(".")) return false;
        }
        return true;
      });
      setTrashItems(filtered);
      setTrashStatus(filtered.length ? "" : "Trash empty");
    } catch (e: any) {
      setTrashItems([]);
      setTrashStatus(String(e?.message || e));
    }
  }

  async function openTrashModal(opts: { showAll?: boolean } = {}) {
    const showAll = !!opts.showAll;
    setTrashItems([]);
    setTrashStatus("");
    setTrashShowAll(showAll);
    setTrashOpen(true);
    await refreshTrashItems(showAll);
  }

  async function restoreTrashItem(it: any) {
    const trashPath = String(it?.trash_path || "").trim();
    const info = it?.info || {};
    const orig = String(info?.original_path || "").trim();
    if (!trashPath || !orig) return;

    const ok = await confirmDialog(`Restore ${orig} from trash?`, {
      title: "Restore",
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
    });
    if (!ok) return;

    setTrashStatus("Restoring...");
    try {
      await callOkCommand("fs_trash_restore", { trash_path: trashPath }, 60_000);
      if (!orig.includes("/")) {
        await refreshServerDirs();
        setInstanceId(orig);
      } else {
        await openFileByPath(orig);
        setTab("files");
      }
      setTrashStatus("Restored");
      setTimeout(() => setTrashStatus(""), 900);
      setTrashOpen(false);
      pushToast(`Restored: ${orig}`, "ok");
    } catch (e: any) {
      setTrashStatus(String(e?.message || e));
    }
  }

  async function deleteTrashItemForever(it: any) {
    const trashPath = String(it?.trash_path || "").trim();
    const info = it?.info || {};
    const orig = String(info?.original_path || "").trim();
    if (!trashPath) return;

    const ok = await confirmDialog(`Delete permanently from trash?\n\n${orig ? `original: ${orig}\n` : ""}trash: ${trashPath}`, {
      title: "Delete forever",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setTrashStatus("Deleting...");
    try {
      await callOkCommand("fs_trash_delete", { trash_path: trashPath }, 60_000);
      await refreshTrashItems();
      pushToast("Deleted from trash", "ok");
      setTrashStatus("");
    } catch (e: any) {
      setTrashStatus(String(e?.message || e));
    }
  }

  async function openServerPropertiesEditor() {
    if (!selectedDaemon?.connected) {
      setServerOpStatus("daemon offline");
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus("instance_id 不能为空");
      return;
    }
    const path = joinRelPath(inst, "server.properties");
    setServerPropsOpen(true);
    setServerPropsSaving(false);
    setServerPropsStatus("Loading...");
    try {
      const out = await callOkCommand("fs_read", { path }, 10_000);
      const text = b64DecodeUtf8(String(out?.b64 || ""));
      setServerPropsRaw(text);
      setServerPropsMotd(getPropValue(text, "motd") ?? "");
      setServerPropsMaxPlayers(Math.max(1, Math.min(1000, Math.round(Number(getPropValue(text, "max-players") ?? "20")) || 20)));
      setServerPropsOnlineMode(String(getPropValue(text, "online-mode") ?? "true").toLowerCase() !== "false");
      setServerPropsWhitelist(String(getPropValue(text, "white-list") ?? "false").toLowerCase() === "true");
      setServerPropsStatus("");
    } catch (e: any) {
      setServerPropsStatus(String(e?.message || e));
    }
  }

  async function saveServerPropertiesEditor() {
    if (serverPropsSaving) return;
    const inst = instanceId.trim();
    if (!inst) {
      setServerPropsStatus("instance_id 不能为空");
      return;
    }
    const path = joinRelPath(inst, "server.properties");

    const maxPlayers = Math.max(1, Math.min(1000, Math.round(Number(serverPropsMaxPlayers) || 0)));
    const motd = String(serverPropsMotd || "");

    setServerPropsSaving(true);
    setServerPropsStatus("Saving...");
    try {
      let next = String(serverPropsRaw || "");
      next = upsertProp(next, "motd", motd);
      next = upsertProp(next, "max-players", String(maxPlayers));
      next = upsertProp(next, "online-mode", serverPropsOnlineMode ? "true" : "false");
      next = upsertProp(next, "white-list", serverPropsWhitelist ? "true" : "false");
      await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(next) }, 10_000);
      setServerPropsRaw(next);
      setServerPropsStatus("Saved");
      setTimeout(() => setServerPropsStatus(""), 900);
    } catch (e: any) {
      setServerPropsStatus(String(e?.message || e));
    } finally {
      setServerPropsSaving(false);
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

  async function downloadLatestLog() {
    if (!selectedDaemon?.connected) {
      pushToast("daemon offline", "error");
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      pushToast("select a game first", "error");
      return;
    }

    const candidates = [
      { path: joinRelPath(inst, "logs/latest.log"), ext: "log" },
      { path: joinRelPath(inst, "logs/latest.log.gz"), ext: "log.gz" },
    ];

    let picked: { path: string; ext: string; size: number } | null = null;
    for (const c of candidates) {
      try {
        const st = await callOkCommand("fs_stat", { path: c.path }, 10_000);
        picked = { path: c.path, ext: c.ext, size: Math.max(0, Number(st?.size || 0)) };
        break;
      } catch {
        // try next
      }
    }
    if (!picked) {
      pushToast("latest.log not found", "error");
      return;
    }

    const max = 25 * 1024 * 1024;
    if (picked.size > max) {
      pushToast(`latest.log too large (${fmtBytes(picked.size)} > ${fmtBytes(max)})`, "error");
      return;
    }

    try {
      const payload = await callOkCommand("fs_read", { path: picked.path }, 60_000);
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `elegantmc-${inst}-latest.${picked.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast(`Downloaded: latest.${picked.ext}`, "ok");
    } catch (e: any) {
      pushToast(String(e?.message || e), "error");
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
      const result = await callAdvancedCommand(cmdName, argsObj, 30_000);
      setCmdResult(result);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "nodes", label: t("tab.nodes") },
    { id: "games", label: t("tab.games") },
    { id: "frp", label: t("tab.frp") },
    { id: "files", label: t("tab.files") },
    { id: "panel", label: t("tab.panel") },
    ...(enableAdvanced ? [{ id: "advanced" as Tab, label: t("tab.advanced") }] : []),
  ];

  const activeTab = useMemo(() => tabs.find((t) => t.id === tab) || tabs[0], [tab]);

  const helpForTab = useMemo(() => {
    switch (tab) {
      case "nodes":
        return {
          title: "Nodes",
          lines: ["Nodes are daemons connected to this panel.", "Create a node (daemon_id + token) and start the daemon with those values.", "Use Node Details for CPU/Mem history and running instances."],
        };
      case "games":
        return {
          title: "Games",
          lines: ["Instances live under servers/<instance_id>.", "Settings are saved to servers/<instance_id>/.elegantmc.json.", "Use Install for Vanilla/Paper/Modpacks; check Install logs when troubleshooting."],
        };
      case "frp":
        return {
          title: "FRP",
          lines: ["Save FRP server profiles here (addr/port/token).", "Enable FRP in Game Settings to expose a public Socket address."],
        };
      case "files":
        return {
          title: "Files",
          lines: ["File access is sandboxed to servers/.", "Use Trash to restore accidental deletes; backups live under servers/_backups/."],
        };
      case "panel":
        return {
          title: "Panel",
          lines: ["Global defaults + CurseForge API key live here.", "Scheduler edits daemon schedule.json (restart/backup tasks)."],
        };
      case "advanced":
        return {
          title: "Advanced",
          lines: ["Runs raw daemon commands (dangerous).", "Keep allowlists tight; prefer normal UI flows when possible."],
        };
      default:
        return { title: "Help", lines: [] as string[] };
    }
  }, [tab]);

  const cmdPaletteCommands = useMemo(() => {
    type CmdItem = { id: string; title: string; hint?: string; disabled?: boolean; run: () => void | Promise<void> };
    const out: CmdItem[] = [];

    const close = () => setCmdPaletteOpen(false);
    const goTab = (t: Tab) => {
      setTab(t);
      setSidebarOpen(false);
      close();
    };

    out.push(
      { id: "tab:nodes", title: "Go: Nodes", run: () => goTab("nodes") },
      { id: "tab:games", title: "Go: Games", run: () => goTab("games") },
      { id: "tab:frp", title: "Go: FRP", run: () => goTab("frp") },
      { id: "tab:files", title: "Go: Files", run: () => goTab("files") },
      { id: "tab:panel", title: "Go: Panel", run: () => goTab("panel") }
    );
    if (enableAdvanced) out.push({ id: "tab:advanced", title: "Go: Advanced", run: () => goTab("advanced") });

    const inst = instanceId.trim();
    const daemonOk = !!selectedDaemon?.connected;
    const canGame = daemonOk && !!inst && !gameActionBusy;
    const running = !!instanceStatus?.running;

    if (inst) {
      out.push(
        { id: "game:install", title: "Game: Install…", disabled: !daemonOk, run: () => (openInstallModal(), close()) },
        { id: "game:settings", title: "Game: Settings…", disabled: !canGame, run: () => (openSettingsModal(), close()) },
        {
          id: "game:files",
          title: "Game: Open instance files",
          disabled: !daemonOk,
          run: () => {
            setFsPath(inst);
            setTab("files");
            close();
          },
        },
        {
          id: "game:backups",
          title: "Game: Open backups folder",
          disabled: !daemonOk,
          run: () => {
            setFsPath(`_backups/${inst}`);
            setTab("files");
            close();
          },
        },
        {
          id: "game:startStop",
          title: running ? "Game: Stop" : "Game: Start",
          disabled: !canGame,
          run: async () => {
            close();
            if (running) await stopServer(inst);
            else await startServer(inst);
          },
        },
        {
          id: "game:restart",
          title: "Game: Restart",
          disabled: !canGame,
          run: async () => {
            close();
            await restartServer(inst);
          },
        },
        {
          id: "game:backup",
          title: "Game: Backup",
          disabled: !canGame,
          run: async () => {
            close();
            await backupServer(inst);
          },
        },
        {
          id: "game:restore",
          title: "Game: Restore…",
          disabled: !canGame,
          run: async () => {
            close();
            await openRestoreModal();
          },
        }
      );
    }

    return out;
  }, [
    enableAdvanced,
    gameActionBusy,
    instanceId,
    instanceStatus?.running,
    selectedDaemon?.connected,
    openInstallModal,
    openSettingsModal,
    openRestoreModal,
    setFsPath,
    setTab,
    setSidebarOpen,
    startServer,
    stopServer,
    restartServer,
    backupServer,
  ]);

  const cmdPaletteFiltered = useMemo(() => {
    const q = cmdPaletteQuery.trim().toLowerCase();
    if (!q) return cmdPaletteCommands;
    return cmdPaletteCommands.filter((c) => {
      const title = String(c.title || "").toLowerCase();
      const hint = String((c as any).hint || "").toLowerCase();
      return title.includes(q) || hint.includes(q);
    });
  }, [cmdPaletteCommands, cmdPaletteQuery]);

  const appCtxValue = {
    tab,
    setTab,
    locale,
    setLocale,
    t,
    daemons,
    selected,
    setSelected,
    selectedDaemon,

    // Panel
    panelInfo,
    panelSettings,
    panelSettingsStatus,
    refreshPanelSettings,
    savePanelSettings,
    loadSchedule,
    saveScheduleJson,
    runScheduleTask,

    // Nodes
    nodes,
    setNodes,
    nodesStatus,
    setNodesStatus,
    openNodeDetails,
    openAddNodeModal,
    openAddNodeAndDeploy,
    openDeployDaemonModal,

    // Games
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceTagsById,
    updateInstanceTags,
    instanceId,
	    setInstanceId,
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
    instanceUsageBytes,
    instanceUsageStatus,
    instanceUsageBusy,
    computeInstanceUsage,
    backupZips: restoreCandidates,
    backupZipsStatus: restoreStatus,
    refreshBackupZips,
    frpOpStatus,
    serverOpStatus,
    gameActionBusy,
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
    downloadLatestLog,

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
    fsDirty,
    setFsSelectedFile,
    fsSelectedFileMode,
    fsFileText,
    setFsFileText,
    openEntry,
    openFileByPath,
    setServerJarFromFile,
    saveFile,
    uploadInputKey,
    uploadFile,
    setUploadFile,
    uploadSelectedFile,
    uploadFilesNow,
    uploadZipAndExtractHere,
    uploadStatus,
    refreshFsNow,
    mkdirFsHere,
    createFileHere,
    renameFsEntry,
    moveFsEntry,
    downloadFsEntry,
    downloadFsFolderAsZip,
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
	    makeDeployComposeYml,
	    maskToken,
	    pct,
	    fmtUnix,
	    fmtTime,
	    fmtBytes,
	    joinRelPath,
	    parentRelPath,
	  };

  return (
    <ErrorBoundary>
    <AppCtxProvider value={appCtxValue}>
      {authed !== true ? (
        <div className="modalOverlay">
          <div className="modal" style={{ width: "min(560px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>Admin Login</div>
                <div className="hint">
                  Set <code>ELEGANTMC_PANEL_ADMIN_PASSWORD</code> via environment variables (docker compose: inline env or <code>environment:</code>
                  in compose). If you did not set it, check Panel logs for the generated password (<code>docker compose logs panel</code>).
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

	      {promptOpen ? (
	        <div className="modalOverlay" onClick={() => closePrompt(null)}>
	          <div className="modal" style={{ width: "min(520px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>{promptTitle}</div>
	                {promptMessage ? (
	                  <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
	                    {promptMessage}
	                  </div>
	                ) : null}
	              </div>
	              <button type="button" onClick={() => closePrompt(null)}>
	                Close
	              </button>
	            </div>
	            <form
	              onSubmit={(e) => {
	                e.preventDefault();
	                closePrompt(promptValue);
	              }}
	            >
	              <div className="field" style={{ marginTop: 8 }}>
	                <label>Value</label>
	                <input value={promptValue} onChange={(e) => setPromptValue(e.target.value)} placeholder={promptPlaceholder} autoFocus />
	              </div>
	              <div className="btnGroup" style={{ justifyContent: "flex-end", marginTop: 10 }}>
	                <button type="button" onClick={() => closePrompt(null)}>
	                  {promptCancelLabel}
	                </button>
	                <button type="submit" className="primary" disabled={!promptValue.trim()}>
	                  {promptOkLabel}
	                </button>
	              </div>
	            </form>
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

	      {cmdPaletteOpen ? (
	        <div className="modalOverlay" onClick={() => setCmdPaletteOpen(false)}>
	          <div className="modal" style={{ width: "min(720px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>Command Palette</div>
	                <div className="hint">
	                  <code>Ctrl+K</code> (or <code>⌘K</code>) · <code>/</code> focuses search
	                </div>
	              </div>
	              <button type="button" onClick={() => setCmdPaletteOpen(false)}>
	                Close
	              </button>
	            </div>

	            <input
	              ref={cmdPaletteInputRef}
	              value={cmdPaletteQuery}
	              onChange={(e) => {
	                setCmdPaletteQuery(e.target.value);
	                setCmdPaletteIdx(0);
	              }}
	              placeholder="Type a command…"
	              autoFocus
	              onKeyDown={(e) => {
	                if (e.key === "ArrowDown") {
	                  e.preventDefault();
	                  setCmdPaletteIdx((i) => Math.min(Math.max(0, cmdPaletteFiltered.length - 1), i + 1));
	                  return;
	                }
	                if (e.key === "ArrowUp") {
	                  e.preventDefault();
	                  setCmdPaletteIdx((i) => Math.max(0, i - 1));
	                  return;
	                }
	                if (e.key === "Enter") {
	                  const cmd = cmdPaletteFiltered[cmdPaletteIdx] as any;
	                  if (!cmd || cmd.disabled) return;
	                  e.preventDefault();
	                  const p = cmd.run?.();
	                  if (p && typeof p.then === "function") p.catch(() => null);
	                }
	              }}
	            />

	            <div className="cmdPaletteList">
	              {cmdPaletteFiltered.length ? (
	                cmdPaletteFiltered.map((c: any, idx: number) => (
	                  <button
	                    key={c.id}
	                    type="button"
	                    className={`cmdPaletteItem ${idx === cmdPaletteIdx ? "active" : ""}`}
	                    disabled={!!c.disabled}
	                    onMouseEnter={() => setCmdPaletteIdx(idx)}
	                    onClick={() => {
	                      if (c.disabled) return;
	                      const p = c.run?.();
	                      if (p && typeof p.then === "function") p.catch(() => null);
	                    }}
	                  >
	                    <div className="cmdPaletteTitle">{c.title}</div>
	                    {c.hint ? <div className="hint">{c.hint}</div> : null}
	                  </button>
	                ))
	              ) : (
	                <div className="hint">No matching commands</div>
	              )}
	            </div>
	          </div>
	        </div>
	      ) : null}

	      {shortcutsOpen ? (
	        <div className="modalOverlay" onClick={() => setShortcutsOpen(false)}>
	          <div className="modal" style={{ width: "min(720px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>Keyboard Shortcuts</div>
	                <div className="hint">
	                  Press <code>?</code> to toggle this dialog
	                </div>
	              </div>
	              <button type="button" onClick={() => setShortcutsOpen(false)}>
	                Close
	              </button>
	            </div>

	            <table>
	              <thead>
	                <tr>
	                  <th style={{ width: 170 }}>Keys</th>
	                  <th>Action</th>
	                </tr>
	              </thead>
	              <tbody>
	                <tr>
	                  <td>
	                    <code>Ctrl+K</code> / <code>⌘K</code>
	                  </td>
	                  <td>Toggle Command Palette</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>/</code>
	                  </td>
	                  <td>Open Command Palette</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>Esc</code>
	                  </td>
	                  <td>Close dialogs / sidebar</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>Enter</code>
	                  </td>
	                  <td>Confirm dialog (when focused outside inputs)</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>↑</code> / <code>↓</code>
	                  </td>
	                  <td>Navigate menus (Select / Command Palette)</td>
	                </tr>
	              </tbody>
	            </table>
	          </div>
	        </div>
	      ) : null}

	      {changelogOpen ? (
	        <div className="modalOverlay" onClick={() => setChangelogOpen(false)}>
	          <div className="modal" style={{ width: "min(820px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>What's new</div>
	                {changelogStatus ? <div className="hint">{changelogStatus}</div> : <div className="hint">Latest changes</div>}
	              </div>
	              <button type="button" onClick={() => setChangelogOpen(false)}>
	                Close
	              </button>
	            </div>
	            {changelogText ? <pre>{changelogText}</pre> : <div className="hint">{changelogStatus || "No changelog loaded."}</div>}
	          </div>
	        </div>
	      ) : null}

	      {helpOpen ? (
	        <div className="modalOverlay" onClick={() => setHelpOpen(false)}>
	          <div className="modal" style={{ width: "min(980px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>Help</div>
	                <div className="hint">
	                  context: <code>{helpForTab.title}</code>
	                </div>
	              </div>
	              <button type="button" onClick={() => setHelpOpen(false)}>
	                Close
	              </button>
	            </div>

	            <div className="grid2" style={{ alignItems: "start" }}>
	              <div style={{ minWidth: 0 }}>
	                <h3>This page</h3>
	                {helpForTab.lines.length ? (
	                  <div className="hint">
	                    {helpForTab.lines.map((l, idx) => (
	                      <div key={idx}>{l}</div>
	                    ))}
	                  </div>
	                ) : (
	                  <div className="hint">No help for this page yet.</div>
	                )}

	                <h3 style={{ marginTop: 12 }}>Docs</h3>
	                <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
	                  <button type="button" className={helpDoc === "readme" ? "primary" : ""} onClick={() => loadHelpDoc("readme")}>
	                    README
	                  </button>
	                  <button type="button" className={helpDoc === "security" ? "primary" : ""} onClick={() => loadHelpDoc("security")}>
	                    Security
	                  </button>
	                  <button
	                    type="button"
	                    className={helpDoc === "panel_readme" ? "primary" : ""}
	                    onClick={() => loadHelpDoc("panel_readme")}
	                  >
	                    Panel
	                  </button>
	                  <button type="button" className={helpDoc === "changelog" ? "primary" : ""} onClick={() => loadHelpDoc("changelog")}>
	                    Changelog
	                  </button>
	                </div>
	              </div>

	              <div style={{ minWidth: 0 }}>
	                <h3>{helpDocTitle || "Doc"}</h3>
	                {helpDocStatus ? <div className="hint">{helpDocStatus}</div> : null}
	                {helpDocText ? <pre style={{ maxHeight: 520, overflow: "auto" }}>{helpDocText}</pre> : <div className="hint">Select a doc to view.</div>}
	              </div>
	            </div>
	          </div>
	        </div>
	      ) : null}

	      {toasts.length ? (
	        <div className="toastWrap" aria-live="polite" aria-relevant="additions" onMouseEnter={pauseToasts} onMouseLeave={resumeToasts}>
	          {toasts.map((t) => (
	            <button
	              key={t.id}
	              type="button"
	              className={`toast ${t.kind} ${t.detail ? "clickable" : ""}`}
	              title={t.detail ? "Click to copy details" : undefined}
	              onClick={() => (t.detail ? openCopyModal(t.detail) : null)}
	            >
	              {t.message}
	            </button>
	          ))}
	        </div>
	      ) : null}

      <div className="appShell">
        <div className={`sidebarOverlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />
	      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebarHeader">
          <img
            className="logo"
            src={String(panelSettings?.logo_url || "/logo.svg")}
            alt={String(panelSettings?.brand_name || "ElegantMC")}
          />
          <div style={{ minWidth: 0 }}>
            <div className="brandName">{String(panelSettings?.brand_name || "ElegantMC")}</div>
            {String(panelSettings?.brand_tagline ?? "Remote Minecraft Server Manager") ? (
              <div className="brandTagline">{String(panelSettings?.brand_tagline ?? "Remote Minecraft Server Manager")}</div>
            ) : null}
          </div>
        </div>

        <nav className="nav">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`navItem ${tab === t.id ? "active" : ""}`}
              onClick={async () => {
                if (tab === "files" && t.id !== "files" && fsDirty) {
                  const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
                    title: "Unsaved Changes",
                    confirmLabel: "Discard",
                    cancelLabel: "Cancel",
                    danger: true,
                  });
                  if (!ok) return;
                }
                setTab(t.id);
                setSidebarOpen(false);
              }}
            >
              <span>{t.label}</span>
              {t.id === "games" && instanceStatus?.running ? <span className="badge ok">running</span> : null}
              {t.id === "nodes" && nodes.length ? <span className="badge">{nodes.length}</span> : null}
            </button>
          ))}
        </nav>

	        <div className="sidebarFooter">
	          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "nowrap" }}>
	            <span className="muted">Preferences</span>
	            <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
	              <button type="button" className="linkBtn" onClick={() => setShortcutsOpen(true)}>
	                Shortcuts
	              </button>
	              <button type="button" className="linkBtn" onClick={openChangelogModal}>
	                What's new
	              </button>
	              <button type="button" className="linkBtn" onClick={openHelpModal}>
	                Help
	              </button>
	              <button type="button" className="linkBtn" onClick={() => setSidebarFooterCollapsed((v) => !v)}>
	                {sidebarFooterCollapsed ? "Show" : "Hide"}
	              </button>
	            </div>
	          </div>
	          {!sidebarFooterCollapsed ? (
	            <>
	              <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
	                <span className="muted">Language</span>
	                <div style={{ width: 170 }}>
	                  <Select
	                    value={locale}
	                    onChange={(v) => setLocale(normalizeLocale(v))}
	                    options={[
	                      { value: "zh", label: "中文" },
	                      { value: "en", label: "English" },
	                    ]}
	                  />
	                </div>
	              </div>
	              <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
	                <span className="muted">Theme</span>
	                <div style={{ width: 170 }}>
	                  <Select
	                    value={themeMode}
	                    onChange={(v) => setThemeMode(v as ThemeMode)}
	                    options={[
	                      { value: "auto", label: "Auto (System)" },
	                      { value: "light", label: "Light" },
	                      { value: "dark", label: "Dark" },
	                      { value: "contrast", label: "High Contrast" },
	                    ]}
	                  />
	                </div>
	              </div>
	            </>
	          ) : null}
	          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
	            <span className={`badge ${authed === true ? "ok" : ""}`}>{authed === true ? "admin" : "locked"}</span>
	            {authed === true ? (
	              <button type="button" onClick={logout}>
	                Logout
	              </button>
	            ) : null}
	          </div>
	        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="row" style={{ alignItems: "center", gap: 10, minWidth: 0 }}>
            <button
              type="button"
              className="iconBtn iconOnly sidebarToggle"
              title="Menu"
              aria-label="Menu"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              <Icon name="menu" />
            </button>
            <div className="topbarTitle">
              <div className="pageTitle">{activeTab.label}</div>
              <div className="pageSubtitle">
                daemon: <code>{selectedDaemon?.id || "-"}</code> ·{" "}
                {selectedDaemon?.connected ? <span>online</span> : <span>offline</span>} · last:{" "}
                {fmtUnix(selectedDaemon?.lastSeenUnix)}
              </div>
            </div>
          </div>

	          <div className="field" style={{ minWidth: 240 }}>
	            <label>Daemon</label>
	            <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "nowrap" }}>
	              <div style={{ flex: 1 }}>
	                <Select
	                  value={selected}
	                  onChange={(v) => setSelected(v)}
	                  disabled={authed !== true}
	                  options={daemons.map((d) => ({
	                    value: d.id,
	                    label: `${d.id} ${d.connected ? "(online)" : "(offline)"}`,
	                  }))}
	                />
	              </div>
	              <span
	                className={`statusDot ${selectedDaemon?.connected ? "ok" : ""}`}
	                title={selectedDaemon?.connected ? "online" : "offline"}
	              />
                {globalBusy ? <span className="busySpinner" title="Working…" aria-hidden="true" /> : null}
	            </div>
	          </div>
	        </div>

        {authed === true && selectedDaemon && !selectedDaemon.connected ? (
          <div className="offlineBanner">
            <b>Daemon offline.</b> last seen: <code>{fmtUnix(selectedDaemon.lastSeenUnix)}</code>. Actions are disabled until it reconnects.
          </div>
        ) : null}

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

                <div className="row" style={{ marginTop: 6 }}>
                  <span className={`badge ${installStep === 1 ? "ok" : ""}`}>1 Basic</span>
                  <span className={`badge ${installStep === 2 ? "ok" : ""}`}>2 Runtime</span>
                  <span className={`badge ${installStep === 3 ? "ok" : ""}`}>3 FRP</span>
                </div>

                <div className="grid2" style={{ alignItems: "start", marginTop: 10 }}>
                  {installStep === 1 ? (
                    <>
	                  <div className="field">
	                    <label>Instance ID</label>
	                    <input
	                      value={installForm.instanceId}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, instanceId: e.target.value }))}
	                      placeholder="my-server"
	                    />
	                    {installValidation.instErr ? (
	                      <div className="hint" style={{ color: "var(--danger)" }}>
	                        {installValidation.instErr}
	                      </div>
	                    ) : (
	                      <div className="hint">建议：A-Z a-z 0-9 . _ -（最长 64）</div>
	                    )}
	                  </div>
			                  <div className="field">
			                    <label>Type</label>
			                    <Select
			                      value={installForm.kind}
			                      onChange={(raw) => {
			                        const k = raw as any;
			                        setInstallForm((f) => ({
			                          ...f,
			                          kind: k,
			                          jarName:
			                            k === "zip" || k === "zip_url" || k === "modrinth" || k === "curseforge"
			                              ? normalizeJarPath(String(f.instanceId || "").trim(), f.jarName)
			                              : normalizeJarName(f.jarName),
			                          remoteUrl: "",
			                          remoteFileName: "",
			                        }));
			                        setMarketStatus("");
			                        setMarketResults([]);
			                        setMarketSelected(null);
			                        setMarketVersions([]);
			                        setMarketSelectedVersionId("");
			                      }}
			                      options={[
			                        { value: "vanilla", label: "Vanilla" },
			                        { value: "paper", label: "Paper" },
			                        { value: "modrinth", label: "Modrinth (Search)" },
			                        { value: "curseforge", label: "CurseForge (Search)", disabled: !curseforgeEnabled },
			                        { value: "zip", label: "Server Pack ZIP (Upload)" },
			                        { value: "zip_url", label: "Server Pack ZIP/MRPACK (URL)" },
			                      ]}
			                    />
			                    {installValidation.kindErr ? (
			                      <div className="hint" style={{ color: "var(--danger)" }}>
			                        {installValidation.kindErr}
			                      </div>
			                    ) : (
			                      <div className="hint">
			                        Vanilla/Paper：自动下载服务端；Modrinth：支持 Fabric/Quilt mrpack；CurseForge：需要 API Key；ZIP：用于服务器包（Forge/NeoForge 建议用 server pack zip）
			                      </div>
			                    )}
			                  </div>

			                  {installForm.kind === "zip" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>Modpack ZIP / MRPACK</label>
		                      <input
		                        key={installZipInputKey}
		                        type="file"
		                        accept=".zip,.mrpack"
		                        onChange={(e) => setInstallZipFile(e.target.files?.[0] || null)}
		                      />
		                      {installValidation.zipErr ? (
		                        <div className="hint" style={{ color: "var(--danger)" }}>
		                          {installValidation.zipErr}
		                        </div>
		                      ) : (
		                        <div className="hint">
		                          支持 <code>.zip</code> / <code>.mrpack</code>：上传到 <code>servers/&lt;instance&gt;/</code> 并自动安装/解压（mrpack 目前只支持 Fabric）
		                        </div>
		                      )}
		                    </div>
			                  ) : installForm.kind === "zip_url" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>Modpack URL</label>
			                      <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
			                        <input
			                          value={installForm.remoteUrl}
			                          onChange={(e) => {
			                            setCfResolveStatus("");
			                            setInstallForm((f) => ({ ...f, remoteUrl: e.target.value }));
			                          }}
			                          placeholder="https://..."
			                          style={{ flex: 1, minWidth: 220 }}
			                        />
			                        {/^https?:\/\/(www\.)?curseforge\.com\//i.test(String(installForm.remoteUrl || "").trim()) ? (
			                          <button
			                            type="button"
			                            className="iconBtn"
			                            onClick={resolveCurseForgeUrl}
			                            disabled={installRunning || cfResolveBusy}
			                            title="Resolve CurseForge file page URL to a direct download URL"
			                          >
			                            <Icon name="download" />
			                            Resolve
			                          </button>
			                        ) : null}
			                      </div>
			                      <div className="hint">
			                        直接粘贴下载链接（支持 <code>.zip</code> / <code>.mrpack</code>）。如果你只有 CurseForge 文件页面链接（<code>/files/&lt;id&gt;</code>），点 Resolve 自动转换为直链。
			                      </div>
			                      {cfResolveStatus ? <div className="hint">{cfResolveStatus}</div> : null}
			                      <div className="field" style={{ marginTop: 10 }}>
			                        <label>Filename (optional)</label>
			                        <input
			                          value={installForm.remoteFileName}
			                          onChange={(e) => setInstallForm((f) => ({ ...f, remoteFileName: e.target.value }))}
			                          placeholder="modpack.zip"
			                        />
			                      </div>
			                    </div>
			                  ) : installForm.kind === "modrinth" || installForm.kind === "curseforge" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>{installForm.kind === "modrinth" ? "Modrinth Modpacks" : "CurseForge Modpacks"}</label>
			                      <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
			                        <input
			                          value={marketQuery}
			                          onChange={(e) => setMarketQuery(e.target.value)}
			                          placeholder="Search modpacks…"
			                          style={{ flex: 1, minWidth: 220 }}
			                        />
			                        <button
			                          type="button"
			                          className="iconBtn"
			                          onClick={runMarketSearch}
			                          disabled={!marketQuery.trim() || installRunning || (installForm.kind === "curseforge" && !curseforgeEnabled)}
			                        >
			                          <Icon name="search" />
			                          Search
			                        </button>
			                        <button
			                          type="button"
			                          className="iconBtn"
			                          onClick={() => {
			                            setMarketStatus("");
			                            setMarketResults([]);
			                            setMarketSelected(null);
			                            setMarketVersions([]);
			                            setMarketSelectedVersionId("");
			                            setInstallForm((f) => ({ ...f, remoteUrl: "", remoteFileName: "" }));
			                          }}
			                          disabled={installRunning}
			                        >
			                          Clear
			                        </button>
			                      </div>
			                      {marketStatus ? (
			                        <div className="hint">{marketStatus}</div>
			                      ) : installForm.kind === "curseforge" && !curseforgeEnabled ? (
			                        <div className="hint">
			                          CurseForge 搜索需要 API Key（去{" "}
			                          <button className="linkBtn" onClick={() => setTab("panel")}>
			                            Panel
			                          </button>{" "}
			                          配置）。或者改用 <b>Modpack ZIP (URL)</b> 粘贴下载链接。
			                        </div>
			                      ) : installForm.kind === "curseforge" ? (
			                        <div className="hint">CurseForge 已启用（API Key 已配置）。</div>
			                      ) : (
			                        <div className="hint">提示：Modrinth mrpack 目前只支持 Fabric（会自动安装服务端 + 下载 mods）。</div>
			                      )}

			                      {marketResults.length ? (
			                        <div className="cardGrid" style={{ marginTop: 10 }}>
			                          {marketResults.slice(0, 12).map((p: any) => (
			                            <div
			                              key={`${p.provider || installForm.kind}-${p.id}`}
			                              className="itemCard"
			                              style={{
			                                cursor: "pointer",
			                                borderColor: marketSelected?.id === p.id ? "rgba(139, 92, 246, 0.65)" : undefined,
			                              }}
			                              onClick={() => selectMarketPack(p)}
			                            >
			                              <div className="itemCardHeader">
			                                <div style={{ minWidth: 0 }}>
			                                  <div className="itemTitle">{p.title || p.name || p.slug || p.id}</div>
			                                  <div className="itemMeta">{p.description || ""}</div>
			                                </div>
			                                <span className="badge">{p.provider || installForm.kind}</span>
			                              </div>
			                              <div className="row" style={{ gap: 8 }}>
			                                <span className="badge">{typeof p.downloads === "number" ? `${p.downloads} downloads` : "downloads -"}</span>
			                                {Array.isArray(p.game_versions) && p.game_versions.length ? (
			                                  <span className="badge">{p.game_versions.slice(0, 2).join(", ")}</span>
			                                ) : null}
			                              </div>
			                            </div>
			                          ))}
			                        </div>
			                      ) : null}

			                      {marketSelected ? (
			                        <div className="card" style={{ marginTop: 12 }}>
			                          <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
			                            <div style={{ minWidth: 0 }}>
			                              <div style={{ fontWeight: 760 }}>{marketSelected.title || marketSelected.name || marketSelected.id}</div>
			                              <div className="hint">{marketSelected.description || ""}</div>
			                            </div>
			                            <span className="badge ok">selected</span>
			                          </div>

			                          {installForm.kind === "modrinth" ? (
			                            <>
			                              <div className="field" style={{ marginTop: 10 }}>
			                                <label>Version</label>
			                                <Select
			                                  value={marketSelectedVersionId}
			                                  onChange={(v) => pickModrinthVersion(v)}
			                                  disabled={!marketVersions.length}
			                                  options={marketVersions.map((v: any) => ({
			                                    value: String(v.id),
			                                    label: String(v.version_number || v.name || v.id),
			                                  }))}
			                                />
			                                <div className="hint">选择后会自动选取该版本的 primary file（若无则取第一个文件）</div>
			                              </div>
			                            </>
			                          ) : (
			                            <>
			                              <div className="field" style={{ marginTop: 10 }}>
			                                <label>File</label>
			                                <Select
			                                  value={marketSelectedVersionId}
			                                  onChange={(v) => pickCurseForgeFile(v)}
			                                  disabled={!marketVersions.length}
			                                  options={marketVersions.map((f: any) => ({
			                                    value: String(f.id),
			                                    label: String(f.display_name || f.file_name || f.id),
			                                  }))}
			                                />
			                                <div className="hint">选择后会解析/获取 download url 并用于安装</div>
			                              </div>
			                            </>
			                          )}

			                          {installForm.kind === "modrinth" && marketSelectedVersion ? (
			                            <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
			                              {Array.isArray((marketSelectedVersion as any).game_versions) && (marketSelectedVersion as any).game_versions.length ? (
			                                <span className="badge">mc: {(marketSelectedVersion as any).game_versions[0]}</span>
			                              ) : null}
			                              {Array.isArray((marketSelectedVersion as any).loaders) && (marketSelectedVersion as any).loaders.length ? (
			                                <span className="badge">loader: {(marketSelectedVersion as any).loaders.join(", ")}</span>
			                              ) : null}
			                              <span className="badge">files: {Array.isArray((marketSelectedVersion as any).files) ? (marketSelectedVersion as any).files.length : 0}</span>
			                            </div>
			                          ) : null}

			                          {installValidation.remoteErr ? (
			                            <div className="hint" style={{ color: "var(--danger)" }}>
			                              {installValidation.remoteErr}
			                            </div>
			                          ) : installForm.remoteUrl ? (
			                            <div className="hint" style={{ marginTop: 8 }}>
			                              file: <code>{installForm.remoteFileName || "-"}</code>
			                            </div>
			                          ) : null}
			                        </div>
			                      ) : null}
			                    </div>
			                  ) : (
			                    <>
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
		                    </>
		                  )}

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
	                    {installValidation.portErr ? (
	                      <div className="hint" style={{ color: "var(--danger)" }}>
	                        {installValidation.portErr}
	                      </div>
	                    ) : (
	                      <div className="hint">写入 server.properties 的 server-port（Docker 默认映射 25565-25600）</div>
	                    )}
	                  </div>

                    </>
                  ) : null}

                  {installStep === 2 ? (
                    <>
		                  <div className="field">
		                    <label>
		                      {installForm.kind === "zip" || installForm.kind === "zip_url" || installForm.kind === "modrinth" || installForm.kind === "curseforge"
		                        ? "Jar path (after extract)"
		                        : "Jar name"}
		                    </label>
		                    <input
		                      value={installForm.jarName}
		                      onChange={(e) => setInstallForm((f) => ({ ...f, jarName: e.target.value }))}
		                      placeholder="server.jar"
		                    />
		                    {installValidation.jarErr ? (
		                      <div className="hint" style={{ color: "var(--danger)" }}>
		                        {installValidation.jarErr}
		                      </div>
		                    ) : (
		                      <div className="hint">
		                        {installForm.kind === "zip" || installForm.kind === "zip_url" || installForm.kind === "modrinth" || installForm.kind === "curseforge"
		                          ? "相对 instance 目录的 jar 路径（可带子目录），用于一键 Start"
		                          : "只填文件名（不含路径），例如 server.jar"}
		                      </div>
		                    )}
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

                    </>
                  ) : null}

                  {installStep === 3 ? (
                    <>
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
	                    {installValidation.frpRemoteErr ? (
	                      <div className="hint" style={{ color: "var(--danger)" }}>
	                        {installValidation.frpRemoteErr}
	                      </div>
	                    ) : (
	                      <div className="hint">填 0 表示不指定（由 FRP 服务端策略分配）</div>
	                    )}
	                  </div>
	                  <div className="field" style={{ gridColumn: "1 / -1" }}>
	                    <label>FRP Server</label>
	                    <Select
	                      value={installForm.frpProfileId}
	                      onChange={(v) => setInstallForm((f) => ({ ...f, frpProfileId: v }))}
	                      disabled={!installForm.enableFrp || !profiles.length}
	                      placeholder={profiles.length ? "Select FRP server…" : "No servers"}
	                      options={profiles.map((p) => ({
	                        value: p.id,
	                        label: `${p.name} (${p.server_addr}:${p.server_port})`,
	                      }))}
	                    />
                    {installForm.enableFrp && installValidation.frpProfileErr ? (
                      <div className="hint" style={{ color: "var(--danger)" }}>
                        {installValidation.frpProfileErr}（去{" "}
                        <button className="linkBtn" onClick={() => setTab("frp")}>
                          FRP
                        </button>{" "}
                        添加，不会关闭此窗口）
                      </div>
                    ) : (
                      <div className="hint">
                        没有可用服务器？去{" "}
                        <button className="linkBtn" onClick={() => setTab("frp")}>
                          FRP
                        </button>{" "}
                        添加（不会关闭此窗口）
                      </div>
                    )}
                  </div>

                    </>
                  ) : null}
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <span className="badge">step {installStep}/3</span>
                    {installStep > 1 ? (
                      <button type="button" onClick={() => setInstallStep((s) => (Math.max(1, s - 1) as 1 | 2 | 3))} disabled={installRunning}>
                        Back
                      </button>
                    ) : null}
                    {installStep < 3 ? (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setInstallStep((s) => (Math.min(3, s + 1) as 1 | 2 | 3))}
                        disabled={installRunning || (installStep === 1 ? !installWizardStep1Ok : !installWizardStep2Ok)}
                      >
                        Next
                      </button>
                    ) : (
                      <>
                        <button
                          className="primary"
                          onClick={() => runInstall(false)}
                          disabled={!selectedDaemon?.connected || installRunning || !installValidation.canInstall}
                        >
                          Install
                        </button>
                        <button
                          className="primary"
                          onClick={() => runInstall(true)}
                          disabled={!selectedDaemon?.connected || installRunning || !installValidation.canInstallAndStart}
                        >
                          Install & Start
                        </button>
                      </>
                    )}
                  </div>

                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
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
                      const ts = fmtTime(Number(l.ts_unix || 0));
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

                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <input value={settingsSearch} onChange={(e) => setSettingsSearch(e.target.value)} placeholder="Search settings…" style={{ width: 260 }} />
                  {settingsSearch ? (
                    <button type="button" className="iconBtn" onClick={() => setSettingsSearch("")}>
                      Clear
                    </button>
                  ) : null}
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  {showSettingsField("jar path", "jar", "path", "server.jar") ? (
                    <div className="field">
                      <label>Jar path (relative)</label>
                      <input value={jarPath} onChange={(e) => setJarPath(e.target.value)} placeholder="server.jar" />
                      {settingsValidation.jarErr ? (
                        <div className="hint" style={{ color: "var(--danger)" }}>
                          {settingsValidation.jarErr}
                        </div>
                      ) : (
                        <div className="hint">相对路径（在 servers/&lt;instance&gt;/ 下），例如 server.jar</div>
                      )}
                    </div>
                  ) : null}
                  {showSettingsField("pick a jar", "jar list", "scan", "refresh") ? (
                    <div className="field">
                      <label>Pick a jar</label>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Select
                            value=""
                            onChange={(v) => setJarPath(v)}
                            disabled={!jarCandidates.length}
                            placeholder={jarCandidates.length ? "Select jar…" : jarCandidatesStatus || "No jars"}
                            options={jarCandidates.map((j) => ({ value: j, label: j }))}
                          />
                        </div>
                        <button
                          type="button"
                          className="iconBtn iconOnly"
                          title="Refresh jar list"
                          aria-label="Refresh jar list"
                          onClick={() => refreshJarCandidates()}
                          disabled={!selectedDaemon?.connected || !instanceId.trim()}
                        >
                          <Icon name="refresh" />
                        </button>
                      </div>
                      <div className="hint">递归扫描 servers/&lt;instance&gt;/ 下的 .jar（跳过 mods/libraries/world 等目录）</div>
                    </div>
                  ) : null}
                  {showSettingsField("java", "jre", "temurin") ? (
                    <div className="field">
                      <label>Java (optional)</label>
                      <input value={javaPath} onChange={(e) => setJavaPath(e.target.value)} placeholder="java / /opt/jdk21/bin/java" />
                      <div className="hint">留空则由 Daemon 自动选择（推荐）</div>
                    </div>
                  ) : null}
                  {showSettingsField("memory", "xms", "xmx") ? (
                    <div className="field">
                      <label>Memory</label>
                      <div className="row">
                        <input value={xms} onChange={(e) => setXms(e.target.value)} placeholder="Xms (e.g. 1G)" />
                        <input value={xmx} onChange={(e) => setXmx(e.target.value)} placeholder="Xmx (e.g. 2G)" />
                      </div>
                    </div>
                  ) : null}
                  {showSettingsField("port", "game port", "25565") ? (
                    <div className="field">
                      <label>Port</label>
                      <input
                        type="number"
                        value={Number.isFinite(gamePort) ? gamePort : 25565}
                        onChange={(e) => setGamePort(Number(e.target.value))}
                        min={1}
                        max={65535}
                      />
                      {settingsValidation.portErr ? (
                        <div className="hint" style={{ color: "var(--danger)" }}>
                          {settingsValidation.portErr}
                        </div>
                      ) : (
                        <div className="hint">保存后会写入 server.properties（运行中需要重启生效）</div>
                      )}
                    </div>
                  ) : null}

                  {showSettingsField("frp", "proxy") ? (
                    <div className="field">
                      <label>FRP</label>
                      <label className="checkRow">
                        <input type="checkbox" checked={enableFrp} onChange={(e) => setEnableFrp(e.target.checked)} />
                        启动时自动开启
                      </label>
                    </div>
                  ) : null}
                  {showSettingsField("frp remote port", "remote port", "25566") ? (
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
                      {settingsValidation.frpRemoteErr ? (
                        <div className="hint" style={{ color: "var(--danger)" }}>
                          {settingsValidation.frpRemoteErr}
                        </div>
                      ) : (
                        <div className="hint">填 0 表示不指定（由 FRP 服务端策略分配）</div>
                      )}
                    </div>
                  ) : null}
                  {showSettingsField("frp server", "server addr", "server port") ? (
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <label>FRP Server</label>
                      <Select
                        value={frpProfileId}
                        onChange={(v) => setFrpProfileId(v)}
                        disabled={!enableFrp || !profiles.length}
                        placeholder={profiles.length ? "Select FRP server…" : "No servers"}
                        options={profiles.map((p) => ({
                          value: p.id,
                          label: `${p.name} (${p.server_addr}:${p.server_port})`,
                        }))}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    className="primary"
                    type="button"
                    onClick={saveEditSettings}
                    disabled={!selectedDaemon?.connected || !instanceId.trim() || !settingsValidation.ok}
                  >
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

          {restoreOpen ? (
            <div className="modalOverlay" onClick={() => (!gameActionBusy ? setRestoreOpen(false) : null)}>
              <div className="modal" style={{ width: "min(680px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>Restore Backup</div>
                    <div className="hint">
                      game: <code>{instanceId.trim() || "-"}</code> · from: <code>{restoreZipPath || "-"}</code>
                    </div>
                  </div>
                  <button type="button" onClick={() => setRestoreOpen(false)} disabled={gameActionBusy}>
                    Close
                  </button>
                </div>

                <div className="field">
                  <label>Backup zip</label>
                  <Select
                    value={restoreZipPath}
                    onChange={(v) => setRestoreZipPath(v)}
                    disabled={!restoreCandidates.length || gameActionBusy}
                    placeholder={restoreCandidates.length ? "Select backup…" : "No backups found"}
                    options={restoreCandidates.map((p) => ({ value: p, label: p }))}
                  />
                  <div className="hint">
                    backups: <code>servers/_backups/{instanceId.trim() || "instance"}/</code>
                  </div>
                  {restoreStatus ? <div className="hint">{restoreStatus}</div> : null}
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <button type="button" onClick={() => refreshBackupZips(instanceId.trim())} disabled={gameActionBusy}>
                      Refresh
                    </button>
                    {gameActionBusy ? <span className="badge">working…</span> : null}
                  </div>
                  <button type="button" className="dangerBtn" onClick={restoreFromBackup} disabled={!restoreZipPath || gameActionBusy}>
                    Restore
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {trashOpen ? (
            <div className="modalOverlay" onClick={() => setTrashOpen(false)}>
              <div className="modal" style={{ width: "min(860px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>Trash</div>
                    <div className="hint">
                      location: <code>servers/_trash/</code> · {trashShowAll ? "showing all trashed items" : "showing games only"}
                    </div>
                    {trashStatus ? <div className="hint">{trashStatus}</div> : null}
                  </div>
                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                    <label className="checkRow" style={{ userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={trashShowAll}
                        onChange={(e) => {
                          const v = e.target.checked;
                          setTrashShowAll(v);
                          refreshTrashItems(v);
                        }}
                      />{" "}
                      Show all
                    </label>
                    <button type="button" onClick={() => refreshTrashItems()} disabled={!selectedDaemon?.connected}>
                      Refresh
                    </button>
                    <button type="button" onClick={() => setTrashOpen(false)}>
                      Close
                    </button>
                  </div>
                </div>

                {trashItems.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Original</th>
                        <th>Deleted</th>
                        <th>Trash path</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {trashItems.map((it: any) => {
                        const info = it?.info || {};
                        const orig = String(info?.original_path || "-");
                        const deleted = fmtUnix(Number(info?.deleted_at_unix || 0));
                        const trashPath = String(it?.trash_path || "-");
                        return (
                          <tr key={trashPath}>
                            <td>
                              <code>{orig}</code>
                            </td>
                            <td>{deleted}</td>
                            <td style={{ maxWidth: 360 }}>
                              <code style={{ display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {trashPath}
                              </code>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                                <button type="button" onClick={() => restoreTrashItem(it)}>
                                  Restore
                                </button>
                                <button type="button" className="dangerBtn" onClick={() => deleteTrashItemForever(it)}>
                                  Delete forever
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="hint">Trash is empty.</div>
                )}
              </div>
            </div>
          ) : null}

          {serverPropsOpen ? (
            <div className="modalOverlay" onClick={() => (!serverPropsSaving ? setServerPropsOpen(false) : null)}>
              <div className="modal" style={{ width: "min(760px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>server.properties</div>
                    <div className="hint">
                      game: <code>{instanceId.trim() || "-"}</code> · path: <code>{joinRelPath(instanceId.trim() || ".", "server.properties")}</code>
                    </div>
                    <div className="hint">只提供安全/常用字段编辑（其余内容保持原样）。</div>
                  </div>
                  <button type="button" onClick={() => setServerPropsOpen(false)} disabled={serverPropsSaving}>
                    Close
                  </button>
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label>MOTD</label>
                    <input value={serverPropsMotd} onChange={(e) => setServerPropsMotd(e.target.value)} placeholder="A Minecraft Server" />
                  </div>
                  <div className="field">
                    <label>Max players</label>
                    <input
                      type="number"
                      value={Number.isFinite(serverPropsMaxPlayers) ? serverPropsMaxPlayers : 20}
                      onChange={(e) => setServerPropsMaxPlayers(Number(e.target.value))}
                      min={1}
                      max={1000}
                    />
                  </div>
                  <div className="field">
                    <label>Online mode</label>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={serverPropsOnlineMode}
                        onChange={(e) => setServerPropsOnlineMode(e.target.checked)}
                      />
                      online-mode
                    </label>
                    <div className="hint">关闭后为离线模式（不安全，不建议公网使用）。</div>
                  </div>
                  <div className="field">
                    <label>Whitelist</label>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={serverPropsWhitelist}
                        onChange={(e) => setServerPropsWhitelist(e.target.checked)}
                      />
                      white-list
                    </label>
                    <div className="hint">开启后需要在服务器内添加白名单玩家。</div>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <button
                      type="button"
                      className="iconBtn"
                      onClick={async () => {
                        const inst = instanceId.trim();
                        if (!inst) return;
                        await openFileByPath(joinRelPath(inst, "server.properties"));
                        setTab("files");
                        setServerPropsOpen(false);
                      }}
                      disabled={!selectedDaemon?.connected || !instanceId.trim() || serverPropsSaving}
                    >
                      <Icon name="search" />
                      Open in Files
                    </button>
                    {serverPropsStatus ? <span className="muted">{serverPropsStatus}</span> : null}
                  </div>
                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={saveServerPropertiesEditor}
                      disabled={!selectedDaemon?.connected || !instanceId.trim() || serverPropsSaving}
                    >
                      Save
                    </button>
                    {serverPropsSaving ? <span className="badge">saving…</span> : null}
                  </div>
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
	                    <div className="row" style={{ justifyContent: "space-between", alignItems: "end", gap: 10, marginBottom: 8 }}>
	                      <div className="field" style={{ minWidth: 180 }}>
	                        <label>Range</label>
	                        <Select
	                          value={String(nodeDetailsRangeSec)}
	                          onChange={(v) => setNodeDetailsRangeSec(Number(v) || 0)}
	                          options={[
	                            { value: String(60), label: "Last 1m" },
	                            { value: String(5 * 60), label: "Last 5m" },
	                            { value: String(15 * 60), label: "Last 15m" },
	                            { value: String(60 * 60), label: "Last 1h" },
	                            { value: String(0), label: "All" },
	                          ]}
	                        />
	                      </div>
	                      <div className="hint" style={{ marginBottom: 4 }}>
	                        {nodeDetailsHistoryMeta.points
	                          ? `points: ${nodeDetailsHistoryMeta.points} · ${fmtUnix(nodeDetailsHistoryMeta.fromUnix)} - ${fmtUnix(nodeDetailsHistoryMeta.toUnix)}`
	                          : "No history yet"}
	                      </div>
	                    </div>

	                    <div className="hint">CPU% · latest: {nodeDetailsHistoryMeta.cpuLatest == null ? "-" : `${nodeDetailsHistoryMeta.cpuLatest.toFixed(1)}%`}</div>
	                    <Sparkline
	                      values={nodeDetailsHistory.map((p: any) => p?.cpu_percent)}
	                      width={520}
	                      height={80}
	                      stroke="rgba(147, 197, 253, 0.95)"
	                    />
	                    <div className="hint" style={{ marginTop: 10 }}>
	                      MEM% · latest: {nodeDetailsHistoryMeta.memLatest == null ? "-" : `${nodeDetailsHistoryMeta.memLatest.toFixed(0)}%`}
	                    </div>
	                    <Sparkline
	                      values={nodeDetailsHistory.map((p: any) => p?.mem_percent)}
	                      width={520}
	                      height={80}
	                      stroke="rgba(34, 197, 94, 0.9)"
	                    />
	                    <div className="hint" style={{ marginTop: 10 }}>
	                      DISK% · latest: {nodeDetailsHistoryMeta.diskLatest == null ? "-" : `${nodeDetailsHistoryMeta.diskLatest.toFixed(0)}%`}
	                    </div>
	                    <Sparkline
	                      values={nodeDetailsHistory.map((p: any) => p?.disk_percent)}
	                      width={520}
	                      height={80}
	                      stroke="rgba(251, 191, 36, 0.95)"
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

      {deployOpen ? (
        <div className="modalOverlay" onClick={() => setDeployOpen(false)}>
          <div className="modal" style={{ width: "min(860px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>Deploy Daemon (docker compose)</div>
                <div className="hint">
                  node: <code>{deployNodeId || "-"}</code> · 复制/下载后在节点机器上运行 <code>docker compose up -d</code>
                </div>
              </div>
              <button type="button" onClick={() => setDeployOpen(false)}>
                Close
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Panel WS URL</label>
                <input value={deployPanelWsUrl} onChange={(e) => setDeployPanelWsUrl(e.target.value)} placeholder="wss://panel.example.com/ws/daemon" />
                <div className="hint">如果面板是 HTTPS，请用 wss://；HTTP 则用 ws://</div>
              </div>
              <div className="field">
                <label>daemon_id</label>
                <input value={deployNodeId} readOnly />
              </div>
              <div className="field">
                <label>token</label>
                <input value={deployToken} readOnly />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>docker-compose.yml</label>
                <textarea readOnly rows={12} value={deployComposeYml} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
                <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="iconBtn" onClick={() => copyText(deployComposeYml)}>
                    <Icon name="copy" />
                    Copy
                  </button>
                  <button
                    type="button"
                    className="iconBtn"
                    onClick={() => {
                      const blob = new Blob([deployComposeYml], { type: "text/yaml;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = deployNodeId ? `elegantmc-daemon-${deployNodeId}.yml` : "elegantmc-daemon.yml";
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
            </div>
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
                    if (deployAfterCreate && String(node?.id || "").trim() && String(node?.token || "").trim()) {
                      setDeployAfterCreate(false);
                      setAddNodeOpen(false);
                      openDeployDaemonModal(String(node.id), String(node.token));
                    }
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
	                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
	                  <code>{createdNode.token}</code>
	                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
	                    <button
	                      type="button"
	                      className="iconBtn iconOnly"
	                      title="Copy token"
	                      aria-label="Copy token"
	                      onClick={async () => {
	                        await copyText(createdNode.token);
	                        setNodesStatus("Copied");
	                        setTimeout(() => setNodesStatus(""), 800);
	                      }}
	                    >
	                      <Icon name="copy" />
	                    </button>
	                    <button type="button" className="iconBtn" onClick={() => openDeployDaemonModal(createdNode.id, createdNode.token)}>
	                      <Icon name="download" />
	                      Compose
	                    </button>
	                  </div>
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

      {tab === "panel" ? <PanelView /> : null}

      {enableAdvanced && tab === "advanced" ? <AdvancedView /> : null}
        </div>
      </div>
      </div>
    </AppCtxProvider>
    </ErrorBoundary>
  );
}
