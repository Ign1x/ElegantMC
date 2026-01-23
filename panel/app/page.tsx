"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AppCtxProvider } from "./appCtx";
import { createT, normalizeLocale, type Locale } from "./i18n";
import Icon from "./ui/Icon";
import ErrorBoundary from "./ui/ErrorBoundary";
import DangerZone from "./ui/DangerZone";
import Select from "./ui/Select";

const AdvancedView = dynamic(() => import("./views/AdvancedView"), { ssr: false });
const FilesView = dynamic(() => import("./views/FilesView"), { ssr: false });
const FrpView = dynamic(() => import("./views/FrpView"), { ssr: false });
const GamesView = dynamic(() => import("./views/GamesView"), { ssr: false });
const NodesView = dynamic(() => import("./views/NodesView"), { ssr: false });
const PanelView = dynamic(() => import("./views/PanelView"), { ssr: false });

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
const DAEMONS_CACHE_KEY = "elegantmc_daemons_cache_v1";

type TrFn = (en: string, zh: string) => string;

function validateInstanceIDUI(id: string, tr?: TrFn) {
  const v = String(id || "").trim();
  if (!v) return tr ? tr("instance_id is required", "instance_id 不能为空") : "instance_id is required";
  if (!INSTANCE_ID_RE.test(v))
    return tr ? tr("only A-Z a-z 0-9 . _ - (max 64), must start with alnum", "仅允许 A-Z a-z 0-9 . _ -（最长 64），且必须以字母或数字开头") : "only A-Z a-z 0-9 . _ - (max 64), must start with alnum";
  return "";
}

function validatePortUI(port: any, { allowZero }: { allowZero: boolean }, tr?: TrFn) {
  const n = Math.round(Number(port ?? 0));
  if (!Number.isFinite(n)) return tr ? tr("port must be a number", "端口必须是数字") : "port must be a number";
  if (allowZero && n === 0) return "";
  if (n < 1 || n > 65535) return tr ? tr("port must be in 1-65535", "端口必须在 1-65535 范围内") : "port must be in 1-65535";
  return "";
}

function validateJarNameUI(name: string, tr?: TrFn) {
  const v = String(name || "").trim();
  if (!v) return tr ? tr("jar_name is required", "jar_name 不能为空") : "jar_name is required";
  if (v.length > 128) return tr ? tr("jar_name too long", "jar_name 过长") : "jar_name too long";
  if (v.includes("/") || v.includes("\\")) return tr ? tr("jar_name must be a filename (no /)", "jar_name 必须是文件名（不能包含 /）") : "jar_name must be a filename (no /)";
  if (v.startsWith(".")) return tr ? tr("jar_name should not start with '.'", "jar_name 不应以 '.' 开头") : "jar_name should not start with '.'";
  return "";
}

function validateJarPathUI(jarPath: string, tr?: TrFn) {
  const raw = String(jarPath || "").trim();
  if (!raw) return tr ? tr("jar_path is required", "jar_path 不能为空") : "jar_path is required";
  if (raw.length > 256) return tr ? tr("jar_path too long", "jar_path 过长") : "jar_path too long";
  const v = raw
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");
  if (!v) return tr ? tr("jar_path is required", "jar_path 不能为空") : "jar_path is required";
  if (v.startsWith(".")) return tr ? tr("jar_path should not start with '.'", "jar_path 不应以 '.' 开头") : "jar_path should not start with '.'";
  if (v.endsWith("/")) return tr ? tr("jar_path must be a file path", "jar_path 必须是文件路径") : "jar_path must be a file path";
  const parts = v.split("/").filter(Boolean);
  if (!parts.length) return tr ? tr("jar_path is required", "jar_path 不能为空") : "jar_path is required";
  for (const p of parts) {
    if (p === "." || p === "..")
      return tr ? tr("jar_path must not contain '.' or '..'", "jar_path 不能包含 '.' 或 '..'") : "jar_path must not contain '.' or '..'";
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
  jvmArgsPreset: "default" | "aikar" | "conservative";
  jvmArgsExtra: string;
  enableFrp: boolean;
  frpProfileId: string;
  frpRemotePort: number;
};

type InstallForm = {
  instanceId: string;
  kind: "vanilla" | "paper" | "purpur" | "zip" | "zip_url" | "modrinth" | "curseforge";
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
  jvmArgs: string[];
  enableFrp: boolean;
  frpProfileId: string;
  frpRemotePort: number;
}>;

const INSTANCE_CONFIG_NAME = ".elegantmc.json";
const PACK_MANIFEST_NAME = ".elegantmc_pack.json";

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

function parseByteSize(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([KMGTP])?(?:i?b)?$/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1] || "");
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = String(m[2] || "").toUpperCase();
  const mul =
    unit === "K"
      ? 1024
      : unit === "M"
        ? 1024 ** 2
        : unit === "G"
          ? 1024 ** 3
          : unit === "T"
            ? 1024 ** 4
            : unit === "P"
              ? 1024 ** 5
              : 1;
  const bytes = n * mul;
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes);
}

function fmtMemPreset(bytes: number) {
  const b = Math.max(0, Math.floor(Number(bytes || 0)));
  if (!b) return "";
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (b % gib === 0) return `${b / gib}G`;
  if (b % mib === 0) return `${b / mib}M`;
  return fmtBytes(b);
}

const JVM_ARGS_PRESETS = {
  default: [] as string[],
  conservative: [
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+ParallelRefProcEnabled",
    "-XX:+DisableExplicitGC",
  ],
  aikar: [
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    "-XX:G1NewSizePercent=30",
    "-XX:G1MaxNewSizePercent=40",
    "-XX:G1HeapRegionSize=8M",
    "-XX:G1ReservePercent=20",
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    "-XX:InitiatingHeapOccupancyPercent=15",
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxTenuringThreshold=1",
    "-Dusing.aikar.flags=https://mcflags.emc.gs",
    "-Daikar.flags=true",
  ],
} satisfies Record<string, string[]>;

function normalizeJvmPreset(raw: any): "default" | "aikar" | "conservative" {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "aikar" || v === "conservative" || v === "default") return v;
  return "default";
}

function parseJvmArgsExtraLines(text: string) {
  const raw = String(text || "");
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("#")) continue;
    out.push(s);
  }
  return out.slice(0, 80);
}

function computeJvmArgs(preset: any, extraText: any) {
  const p = normalizeJvmPreset(preset);
  const base = JVM_ARGS_PRESETS[p] || [];
  const extra = parseJvmArgsExtraLines(String(extraText || ""));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of [...base, ...extra]) {
    const s = String(a || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
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
  const [updateInfo, setUpdateInfo] = useState<any | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string>("");
  const [updateBusy, setUpdateBusy] = useState<boolean>(false);

  const [daemons, setDaemons] = useState<Daemon[]>([]);
  const [daemonsCacheAtUnix, setDaemonsCacheAtUnix] = useState<number>(0);
  const [selected, setSelected] = useState<string>("");
  const selectedDaemon = useMemo(() => daemons.find((d) => d.id === selected) || null, [daemons, selected]);

  const [error, setError] = useState<string>("");
  const [uiHost, setUiHost] = useState<string>("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authMe, setAuthMe] = useState<{ via: string; user_id: string; username: string; totp_enabled?: boolean } | null>(null);
  const [loginUsername, setLoginUsername] = useState<string>("admin");
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginOtp, setLoginOtp] = useState<string>("");
  const [loginNeeds2fa, setLoginNeeds2fa] = useState<boolean>(false);
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

  // Undo (trash)
  const [undoTrash, setUndoTrash] = useState<{
    daemonId: string;
    trashId: string;
    trashPath: string;
    originalPath: string;
    message: string;
    expiresAtMs: number;
  } | null>(null);
  const [undoTrashBusy, setUndoTrashBusy] = useState<boolean>(false);

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
  const [fsSelectedFileMode, setFsSelectedFileMode] = useState<"none" | "text" | "binary" | "image">("none");
  const [fsFileText, setFsFileText] = useState<string>("");
  const [fsFileTextSaved, setFsFileTextSaved] = useState<string>("");
  const [fsPreviewUrl, setFsPreviewUrl] = useState<string>("");
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
  const [jvmArgsPreset, setJvmArgsPreset] = useState<"default" | "aikar" | "conservative">("default");
  const [jvmArgsExtra, setJvmArgsExtra] = useState<string>("");
  const [installedServerKind, setInstalledServerKind] = useState<"unknown" | "vanilla" | "paper" | "purpur">("unknown");
  const [installedServerVersion, setInstalledServerVersion] = useState<string>("");
  const [installedServerBuild, setInstalledServerBuild] = useState<number>(0);
  const [consoleLine, setConsoleLine] = useState<string>("");
  const [serverOpStatus, setServerOpStatus] = useState<string>("");
  const [gameActionBusy, setGameActionBusy] = useState<boolean>(false);
  const [instanceUsageBytes, setInstanceUsageBytes] = useState<number | null>(null);
  const [instanceUsageStatus, setInstanceUsageStatus] = useState<string>("");
  const [instanceUsageBusy, setInstanceUsageBusy] = useState<boolean>(false);
  const [instanceMetricsHistory, setInstanceMetricsHistory] = useState<any[]>([]);
  const [instanceMetricsStatus, setInstanceMetricsStatus] = useState<string>("");
  const [restoreOpen, setRestoreOpen] = useState<boolean>(false);
  const [restoreStatus, setRestoreStatus] = useState<string>("");
  const [restoreCandidates, setRestoreCandidates] = useState<string[]>([]);
  const [restoreZipPath, setRestoreZipPath] = useState<string>("");
  const [trashOpen, setTrashOpen] = useState<boolean>(false);
  const [trashStatus, setTrashStatus] = useState<string>("");
  const [trashItems, setTrashItems] = useState<any[]>([]);
  const [trashShowAll, setTrashShowAll] = useState<boolean>(false);
  const [datapackOpen, setDatapackOpen] = useState<boolean>(false);
  const [datapackBusy, setDatapackBusy] = useState<boolean>(false);
  const [datapackStatus, setDatapackStatus] = useState<string>("");
  const [datapackWorld, setDatapackWorld] = useState<string>("world");
  const [datapackUrl, setDatapackUrl] = useState<string>("");
  const [datapackFile, setDatapackFile] = useState<File | null>(null);
  const [datapackInputKey, setDatapackInputKey] = useState<number>(0);
  const [resPackOpen, setResPackOpen] = useState<boolean>(false);
  const [resPackBusy, setResPackBusy] = useState<boolean>(false);
  const [resPackStatus, setResPackStatus] = useState<string>("");
  const [resPackUrl, setResPackUrl] = useState<string>("");
  const [resPackSha1, setResPackSha1] = useState<string>("");
  const [resPackFile, setResPackFile] = useState<File | null>(null);
  const [resPackInputKey, setResPackInputKey] = useState<number>(0);
  const [jarUpdateOpen, setJarUpdateOpen] = useState<boolean>(false);
  const [jarUpdateBusy, setJarUpdateBusy] = useState<boolean>(false);
  const [jarUpdateStatus, setJarUpdateStatus] = useState<string>("");
  const [jarUpdateType, setJarUpdateType] = useState<"vanilla" | "paper" | "purpur">("paper");
  const [jarUpdateVersion, setJarUpdateVersion] = useState<string>("1.20.1");
  const [jarUpdateBuild, setJarUpdateBuild] = useState<number>(0);
  const [jarUpdateJarName, setJarUpdateJarName] = useState<string>("server.jar");
  const [jarUpdateBackup, setJarUpdateBackup] = useState<boolean>(true);
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
  const [installProgress, setInstallProgress] = useState<{ phase: string; currentFile: string; done: number; total: number } | null>(null);
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
  const [favoriteInstanceIds, setFavoriteInstanceIds] = useState<string[]>([]);
  const [instanceNotesById, setInstanceNotesById] = useState<Record<string, string>>({});

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
  const [nodeInstanceUsageByKey, setNodeInstanceUsageByKey] = useState<Record<string, { bytes: number | null; status: string; busy: boolean; updatedAtUnix: number }>>({});
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
	    const instErr = validateInstanceIDUI(installForm.instanceId, t.tr);
	    const verErr =
	      installForm.kind === "vanilla" || installForm.kind === "paper"
	        ? String(installForm.version || "").trim()
	          ? ""
	          : t.tr("version is required", "version 不能为空")
	        : "";
	    const kindErr = "";
	    const jarErr =
	      installForm.kind === "zip" || installForm.kind === "zip_url" || installForm.kind === "modrinth" || installForm.kind === "curseforge"
	        ? validateJarPathUI(installForm.jarName, t.tr)
	        : validateJarNameUI(installForm.jarName, t.tr);
	    const zipErr = installForm.kind === "zip" && !installZipFile ? t.tr("zip/mrpack file is required", "需要选择 zip/mrpack 文件") : "";
	    const remoteErr = (() => {
	      const url = String(installForm.remoteUrl || "").trim();
	      if (installForm.kind === "zip_url") return url ? "" : t.tr("remote url is required", "需要填写远程 URL");
	      if (installForm.kind === "modrinth" || installForm.kind === "curseforge") return url ? "" : t.tr("select a modpack file first", "请先选择整合包文件");
	      return "";
	    })();
	    const portErr = validatePortUI(installForm.gamePort, { allowZero: false }, t.tr);
	    const frpRemoteErr = validatePortUI(installForm.frpRemotePort, { allowZero: true }, t.tr);
	    const frpProfileErr =
	      installForm.enableFrp && (!String(installForm.frpProfileId || "").trim() || !profiles.length)
	        ? t.tr("select a FRP server (or disable FRP)", "请选择 FRP 服务器（或禁用 FRP）")
	        : "";
	    const canInstall = !kindErr && !instErr && !verErr && !jarErr && !zipErr && !remoteErr && !portErr && !frpRemoteErr;
	    const canInstallAndStart = canInstall && (!installForm.enableFrp || !frpProfileErr);
	    return { kindErr, instErr, verErr, jarErr, zipErr, remoteErr, portErr, frpRemoteErr, frpProfileErr, canInstall, canInstallAndStart };
	  }, [installForm, installZipFile, profiles, t]);

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
    const jarErr = jar ? "" : t.tr("jar_path is required", "jar_path 不能为空");
    const portErr = validatePortUI(gamePort, { allowZero: false }, t.tr);
    const frpRemoteErr = validatePortUI(frpRemotePort, { allowZero: true }, t.tr);
    const ok = !jarErr && !portErr && !frpRemoteErr;
    return { jarErr, portErr, frpRemoteErr, ok };
  }, [jarPath, gamePort, frpRemotePort, t]);

  const jvmArgsComputed = useMemo(() => computeJvmArgs(jvmArgsPreset, jvmArgsExtra), [jvmArgsPreset, jvmArgsExtra]);

  const memoryInfo = useMemo(() => {
    const totalBytes = Math.floor(Number(selectedDaemon?.heartbeat?.mem?.total_bytes || 0));
    const xmsBytes = parseByteSize(xms);
    const xmxBytes = parseByteSize(xmx);
    const warnings: { kind: "warn" | "danger"; text: string }[] = [];

    if (xmsBytes != null && xmxBytes != null && xmsBytes > xmxBytes) {
      warnings.push({ kind: "danger", text: t.tr("Xms is larger than Xmx", "Xms 大于 Xmx") });
    }
    if (totalBytes > 0 && xmxBytes != null) {
      const pct = (xmxBytes * 100) / totalBytes;
      if (pct > 90) warnings.push({ kind: "danger", text: t.tr(`Xmx is ${pct.toFixed(0)}% of node memory`, `Xmx 占节点内存 ${pct.toFixed(0)}%`) });
      else if (pct > 75) warnings.push({ kind: "warn", text: t.tr(`Xmx is ${pct.toFixed(0)}% of node memory`, `Xmx 占节点内存 ${pct.toFixed(0)}%`) });
    }
    return { totalBytes, xmsBytes, xmxBytes, warnings };
  }, [selectedDaemon, xms, xmx, t]);

  const memoryPresets = useMemo(() => {
    const total = memoryInfo.totalBytes;
    const mib = 1024 ** 2;
    const gib = 1024 ** 3;
    const base = [512 * mib, 1 * gib, 2 * gib, 3 * gib, 4 * gib, 6 * gib, 8 * gib, 12 * gib, 16 * gib, 24 * gib, 32 * gib];
    const limit = total > 0 ? Math.floor(total * 0.9) : 0;
    const list = base.filter((b) => (limit > 0 ? b <= limit : b <= 12 * gib));
    const out: number[] = [];
    const seen = new Set<number>();
    for (const b of list) {
      if (b <= 0) continue;
      if (seen.has(b)) continue;
      seen.add(b);
      out.push(b);
    }
    return out;
  }, [memoryInfo.totalBytes]);

  const settingsSearchQ = settingsSearch.trim().toLowerCase();
  const showSettingsField = (...terms: string[]) =>
    !settingsSearchQ || terms.some((t) => String(t || "").toLowerCase().includes(settingsSearchQ));

  const nodeDetailsNode = useMemo(() => nodes.find((n: any) => n?.id === nodeDetailsId) || null, [nodes, nodeDetailsId]);
  const nodeDetailsUpdate = useMemo(() => {
    const id = String(nodeDetailsId || "").trim();
    if (!id || !updateInfo) return null;
    const list = Array.isArray((updateInfo as any)?.daemons?.nodes) ? (updateInfo as any).daemons.nodes : [];
    return list.find((x: any) => String(x?.id || "").trim() === id) || null;
  }, [updateInfo, nodeDetailsId]);
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
      if (typeof (mql as any).addListener === "function") {
        (mql as any).addListener(onChange);
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

  // Favorite instances (per daemon, stored in localStorage)
  useEffect(() => {
    if (!selected) {
      setFavoriteInstanceIds([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`elegantmc_instance_favorites_v1:${selected}`);
      const parsed = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed : [];
      const cleaned = list.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 200);
      setFavoriteInstanceIds(cleaned);
    } catch {
      setFavoriteInstanceIds([]);
    }
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(`elegantmc_instance_favorites_v1:${selected}`, JSON.stringify(favoriteInstanceIds || []));
    } catch {
      // ignore
    }
  }, [selected, favoriteInstanceIds]);

  // Instance notes (per daemon, stored in localStorage)
  useEffect(() => {
    if (!selected) {
      setInstanceNotesById({});
      return;
    }
    try {
      const raw = localStorage.getItem(`elegantmc_instance_notes_v1:${selected}`);
      const parsed = raw ? JSON.parse(raw) : {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed || {})) {
        const inst = String(k || "").trim();
        if (!inst) continue;
        const note = String(v || "").slice(0, 4000);
        if (!note.trim()) continue;
        out[inst] = note;
      }
      setInstanceNotesById(out);
    } catch {
      setInstanceNotesById({});
    }
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(`elegantmc_instance_notes_v1:${selected}`, JSON.stringify(instanceNotesById || {}));
    } catch {
      // ignore
    }
  }, [selected, instanceNotesById]);

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
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) {
          setAuthed(true);
          setAuthMe({
            via: String(json?.via || "session"),
            user_id: String(json?.user_id || ""),
            username: String(json?.username || ""),
            totp_enabled: !!json?.totp_enabled,
          });
          setLoginNeeds2fa(false);
          setLoginOtp("");
        } else {
          setAuthed(false);
          setAuthMe(null);
        }
      } catch {
        if (!cancelled) {
          setAuthed(false);
          setAuthMe(null);
        }
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
    if (res.status === 401) {
      setAuthed(false);
      setAuthMe(null);
    }
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
    try {
      const res = await apiFetch("/api/modpacks/providers", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      setModpackProviders(Array.isArray(json?.providers) ? json.providers : []);
    } catch (e: any) {
      setModpackProviders([]);
    }
  }

  async function refreshPanelSettings() {
    setPanelSettingsStatus(t.tr("Loading...", "加载中..."));
    try {
      const res = await apiFetch("/api/panel/settings", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      setPanelSettings(json?.settings || null);
      setPanelSettingsStatus("");
      refreshModpackProviders();
    } catch (e: any) {
      setPanelSettings(null);
      setPanelSettingsStatus(String(e?.message || e));
    }
  }

  async function savePanelSettings(next: any) {
    setPanelSettingsStatus(t.tr("Saving...", "保存中..."));
    try {
      const res = await apiFetch("/api/panel/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ?? {}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      setPanelSettings(json?.settings || null);
      refreshModpackProviders();
      setPanelSettingsStatus(t.tr("Saved", "已保存"));
      setTimeout(() => setPanelSettingsStatus(""), 900);
    } catch (e: any) {
      setPanelSettingsStatus(String(e?.message || e));
    }
  }

  async function checkUpdates(opts: { force?: boolean } = {}) {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus(t.tr("Checking...", "检查中..."));
    try {
      const qs = opts.force ? "?force=1" : "";
      const res = await apiFetch(`/api/updates/check${qs}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      setUpdateInfo(json || null);
      setUpdateStatus(t.tr("Checked", "已检查"));
      try {
        localStorage.setItem("elegantmc_updates_cache", JSON.stringify(json || null));
      } catch {
        // ignore
      }
      setTimeout(() => setUpdateStatus(""), 900);
    } catch (e: any) {
      setUpdateStatus(String(e?.message || e));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function loadSchedule() {
    if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
    return await callOkCommand("schedule_get", {}, 30_000);
  }

  async function saveScheduleJson(jsonText: string) {
    if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
    const text = String(jsonText || "").trim();
    if (!text) throw new Error(t.tr("json is required", "json 不能为空"));
    return await callOkCommand("schedule_set", { json: text }, 30_000);
  }

  async function runScheduleTask(taskId: string) {
    if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
    const id = String(taskId || "").trim();
    if (!id) throw new Error(t.tr("task_id is required", "task_id 不能为空"));
    return await callOkCommand("schedule_run_task", { task_id: id }, 60 * 60_000);
  }

  async function login() {
    setLoginStatus(t.tr("Logging in...", "登录中..."));
    try {
      const otpRaw = String(loginOtp || "").trim();
      const otpDigits = otpRaw.replace(/\s+/g, "");
      const body: any = { username: loginUsername, password: loginPassword };
      if (otpRaw) {
        if (/^[0-9]{6}$/.test(otpDigits)) body.totp_code = otpDigits;
        else body.recovery_code = otpRaw;
      }
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (json?.needs_2fa) {
          setLoginNeeds2fa(true);
          setLoginStatus(t.tr("2FA required", "需要 2FA"));
          return;
        }
        throw new Error(json?.error || t.tr("login failed", "登录失败"));
      }
      setAuthed(true);
      setAuthMe({
        via: "session",
        user_id: String(json?.user_id || ""),
        username: String(json?.username || ""),
        totp_enabled: !!json?.totp_enabled,
      });
      setLoginUsername("admin");
      setLoginPassword("");
      setLoginOtp("");
      setLoginNeeds2fa(false);
      setLoginStatus("");
      setError("");
    } catch (e: any) {
      setLoginStatus(String(e?.message || e));
      setAuthed(false);
      setAuthMe(null);
    }
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setAuthed(false);
    setAuthMe(null);
  }

  async function callCommand(name: string, args: any, timeoutMs = 60_000) {
    const daemonId = String(selected || "").trim();
    if (!daemonId) {
      pushToast(t.tr("No daemon selected", "未选择 Daemon"), "error", 7000, `command=${name}`);
      throw new Error(t.tr("no daemon selected", "未选择 Daemon"));
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
        t.tr(`Command ${name} failed`, `命令 ${name} 执行失败`),
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw e;
    }

    if (!res.ok) {
      const msg = String(json?.error || t.tr("request failed", "请求失败"));
      pushToast(
        t.tr(`Command ${name} failed: ${msg}`, `命令 ${name} 执行失败：${msg}`),
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
        t.tr(`Advanced command ${name} failed`, `高级命令 ${name} 执行失败`),
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw e;
    }

    if (!res.ok) {
      const msg = String(json?.error || t.tr("request failed", "请求失败"));
      pushToast(
        t.tr(`Advanced command ${name} failed: ${msg}`, `高级命令 ${name} 执行失败：${msg}`),
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
      const msg = String(result?.error || t.tr("command failed", "命令执行失败"));
      pushToast(
        t.tr(`Command ${name} failed: ${msg}`, `命令 ${name} 执行失败：${msg}`),
        "error",
        9000,
        JSON.stringify({ daemon: String(selected || "").trim(), name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw new Error(msg);
    }
    return result?.output || {};
  }

  async function callCommandForDaemon(daemonIdRaw: string, name: string, args: any, timeoutMs = 60_000) {
    const daemonId = String(daemonIdRaw || "").trim();
    if (!daemonId) throw new Error(t.tr("daemon_id is required", "daemon_id 不能为空"));

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
        t.tr(`Command ${name} failed`, `命令 ${name} 执行失败`),
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw e;
    }

    if (!res.ok) {
      const msg = String(json?.error || t.tr("request failed", "请求失败"));
      pushToast(
        t.tr(`Command ${name} failed: ${msg}`, `命令 ${name} 执行失败：${msg}`),
        "error",
        9000,
        JSON.stringify({ daemon: daemonId, name, args: sanitizeForToast(args), timeoutMs, status: res.status, error: msg }, null, 2)
      );
      throw new Error(msg);
    }

    return json.result;
  }

  async function callOkCommandForDaemon(daemonId: string, name: string, args: any, timeoutMs = 60_000) {
    const result = await callCommandForDaemon(daemonId, name, args, timeoutMs);
    if (!result?.ok) {
      const msg = String(result?.error || t.tr("command failed", "命令执行失败"));
      pushToast(
        t.tr(`Command ${name} failed: ${msg}`, `命令 ${name} 执行失败：${msg}`),
        "error",
        9000,
        JSON.stringify({ daemon: String(daemonId || "").trim(), name, args: sanitizeForToast(args), timeoutMs, error: msg }, null, 2)
      );
      throw new Error(msg);
    }
    return result?.output || {};
  }

  async function exportDiagnosticsBundle(nodeId: string) {
    const daemonId = String(nodeId || "").trim();
    if (!daemonId) return;
    if (!daemons.find((d: any) => String(d?.id || "") === daemonId)?.connected) {
      setNodesStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }

    let zipPath = "";
    let downloaded = false;
    setNodesStatus(t.tr("Building diagnostics...", "生成诊断包中..."));
    try {
      const out = await callOkCommandForDaemon(daemonId, "diagnostics_bundle", {}, 2 * 60_000);
      zipPath = String(out?.zip_path || "").trim();
      if (!zipPath) throw new Error(t.tr("zip_path missing", "zip_path 缺失"));

      const st = await callOkCommandForDaemon(daemonId, "fs_stat", { path: zipPath }, 10_000);
      const size = Math.max(0, Number(st?.size || 0));
      const max = 50 * 1024 * 1024;
      if (size > max) {
        throw new Error(
          t.tr(
            `Diagnostics zip too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)}). File: ${zipPath}`,
            `诊断包过大，无法在浏览器中下载（${fmtBytes(size)} > ${fmtBytes(max)}）。文件：${zipPath}`
          )
        );
      }

      setNodesStatus(t.tr("Downloading...", "下载中..."));
      const payload = await callOkCommandForDaemon(daemonId, "fs_read", { path: zipPath }, 5 * 60_000);
      const bytes = b64DecodeBytes(String(payload?.b64 || ""));

      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipPath.split("/").pop() || `diagnostics-${daemonId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      downloaded = true;
      setNodesStatus(t.tr("Downloaded", "已下载"));
      setTimeout(() => setNodesStatus(""), 900);
      pushToast(t.tr(`Downloaded diagnostics: ${a.download}`, `已下载诊断包：${a.download}`), "ok");
    } catch (e: any) {
      const msg = String(e?.message || e);
      setNodesStatus(msg);
      if (zipPath) {
        pushToast(
          t.tr("Diagnostics bundle created (download failed)", "诊断包已生成（下载失败）"),
          "error",
          9000,
          JSON.stringify({ daemon: daemonId, zip_path: zipPath, error: msg }, null, 2)
        );
      }
    } finally {
      if (zipPath && downloaded) {
        try {
          await callOkCommandForDaemon(daemonId, "fs_delete", { path: zipPath }, 60_000);
        } catch {
          // ignore
        }
      }
    }
  }

  async function undoLastTrash() {
    const u = undoTrash;
    if (!u || undoTrashBusy) return;
    setUndoTrashBusy(true);
    try {
      const args: any = {};
      if (u.trashId) args.trash_id = u.trashId;
      if (u.trashPath) args.trash_path = u.trashPath;
      await callOkCommandForDaemon(u.daemonId, "fs_trash_restore", args, 60_000);
      pushToast(t.tr("Restored from trash", "已从回收站恢复"), "ok");
      setUndoTrash(null);

      if (String(selected || "").trim() === u.daemonId) {
        try {
          await refreshServerDirs();
        } catch {
          // ignore
        }
        try {
          await refreshFsNow();
        } catch {
          // ignore
        }
        if (u.originalPath && !u.originalPath.includes("/")) {
          setInstanceId(u.originalPath);
        }
      }
    } catch (e: any) {
      pushToast(t.tr("Undo failed", "撤销失败"), "error", 9000, String(e?.message || e));
    } finally {
      setUndoTrashBusy(false);
    }
  }

  async function openNodeDetails(id: string) {
    setNodeDetailsId(id);
    setNodeDetailsOpen(true);
  }

  async function deleteNodeNow(idRaw: string) {
    const id = String(idRaw || "").trim();
    if (!id) return;

    const ok = await confirmDialog(
      t.tr(
        `Delete node ${id}?\n\nThis removes its saved token from the panel and will prevent reconnecting until you re-add it.`,
        `删除节点 ${id}？\n\n这会从面板移除该节点的 token，并阻止其再次连接（除非重新添加）。`
      ),
      { title: t.tr("Delete Node", "删除节点"), confirmLabel: t.tr("Continue", "继续"), cancelLabel: t.tr("Cancel", "取消"), danger: true }
    );
    if (!ok) return;

    const typed = await promptDialog({
      title: t.tr("Confirm", "确认"),
      message: t.tr(`Type "${id}" to confirm deleting this node.`, `输入 “${id}” 以确认删除该节点。`),
      placeholder: id,
      okLabel: t.tr("Delete", "删除"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (typed !== id) {
      setNodesStatus(t.tr("Cancelled", "已取消"));
      return;
    }

    setNodesStatus(t.tr("Deleting...", "删除中..."));
    try {
      const res = await apiFetch(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "failed");

      if (String(selected || "").trim() === id) {
        setSelected("");
        setInstanceId("");
        setServerDirs([]);
        setServerDirsStatus("");
      }

      setNodeDetailsOpen(false);
      setNodeDetailsId("");

      try {
        const res2 = await apiFetch("/api/nodes", { cache: "no-store" });
        const json2 = await res2.json().catch(() => null);
        if (res2.ok) setNodes(json2?.nodes || []);
      } catch {
        // ignore
      }

      setNodesStatus(t.tr("Deleted", "已删除"));
      setTimeout(() => setNodesStatus(""), 900);
    } catch (e: any) {
      setNodesStatus(String(e?.message || e));
    }
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
    setServerDirsStatus(t.tr("Loading...", "加载中..."));
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

  function toggleFavoriteInstance(instance: string) {
    const inst = String(instance || "").trim();
    if (!inst) return;
    setFavoriteInstanceIds((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      if (list.includes(inst)) return list.filter((x) => x !== inst);
      return [inst, ...list].slice(0, 200);
    });
  }

  function updateInstanceNote(instance: string, note: string) {
    const inst = String(instance || "").trim();
    if (!inst) return;
    const nextNote = String(note || "").slice(0, 4000);
    setInstanceNotesById((prev) => {
      const cur = prev || {};
      const next = { ...cur };
      if (!nextNote.trim()) delete next[inst];
      else next[inst] = nextNote;
      return next;
    });
  }

  async function refreshJarCandidates(instOverride?: string) {
    const inst = String(instOverride ?? instanceId).trim();
    if (!inst || !selectedDaemon?.connected) {
      setJarCandidates([]);
      setJarCandidatesStatus(inst ? t.tr("daemon offline", "daemon 离线") : "");
      return;
    }
    setJarCandidatesStatus(t.tr("Scanning jars...", "扫描 Jar 中..."));
    try {
      const out = await callOkCommand("mc_detect_jar", { instance_id: inst }, 30_000);
      const jars = (Array.isArray(out?.jars) ? out.jars : []).map((j: any) => String(j || "")).filter(Boolean);
      setJarCandidates(jars);
      setJarCandidatesStatus(jars.length ? "" : t.tr("No .jar files found", "未找到 .jar 文件"));
    } catch (e: any) {
      setJarCandidates([]);
      setJarCandidatesStatus(String(e?.message || e));
    }
  }

  async function applyServerPort(instance: string, port: number) {
    const p = Math.round(Number(port || 0));
    if (!Number.isFinite(p) || p < 1 || p > 65535) throw new Error(t.tr("port invalid (1-65535)", "端口无效（1-65535）"));
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
    if (!cleanInst) throw new Error(t.tr("instance_id is required", "instance_id 不能为空"));
    const path = joinRelPath(cleanInst, INSTANCE_CONFIG_NAME);

    let prev: any = null;
    try {
      const out = await callOkCommand("fs_read", { path }, 10_000);
      const raw = b64DecodeUtf8(String(out?.b64 || ""));
      const parsed = raw ? JSON.parse(raw) : null;
      prev = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      prev = null;
    }

    const jar = normalizeJarPath(cleanInst, String(cfg?.jar_path ?? jarPath));
    const java = String(cfg?.java_path ?? javaPath).trim();
    const gamePortRaw = Math.round(Number(cfg?.game_port ?? gamePort));
    const gamePortVal = Number.isFinite(gamePortRaw) && gamePortRaw >= 1 && gamePortRaw <= 65535 ? gamePortRaw : 25565;
    const frpRemoteRaw = Math.round(Number(cfg?.frp_remote_port ?? frpRemotePort));
    const frpRemoteVal = Number.isFinite(frpRemoteRaw) && frpRemoteRaw >= 0 && frpRemoteRaw <= 65535 ? frpRemoteRaw : 0;

    const preset = normalizeJvmPreset(cfg?.jvm_args_preset ?? cfg?.jvmArgsPreset ?? jvmArgsPreset);
    const extraText = String(cfg?.jvm_args_extra ?? cfg?.jvmArgsExtra ?? jvmArgsExtra ?? "");
    const jvmArgs =
      Array.isArray(cfg?.jvm_args) ? (cfg.jvm_args as any[]).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 120) : computeJvmArgs(preset, extraText);

    const payload: any = {
      ...(prev || {}),
      jar_path: jar,
      ...(java ? { java_path: java } : {}),
      game_port: gamePortVal,
      xms: String(cfg?.xms ?? xms).trim(),
      xmx: String(cfg?.xmx ?? xmx).trim(),
      jvm_args_preset: preset,
      jvm_args_extra: extraText,
      jvm_args: jvmArgs,
      enable_frp: !!(cfg?.enable_frp ?? enableFrp),
      frp_profile_id: String(cfg?.frp_profile_id ?? frpProfileId),
      frp_remote_port: frpRemoteVal,
      updated_at_unix: Math.floor(Date.now() / 1000),
    };
    if (typeof cfg?.server_kind === "string") payload.server_kind = String(cfg.server_kind).trim();
    if (typeof cfg?.server_version === "string") payload.server_version = String(cfg.server_version).trim();
    if (cfg?.server_build != null && Number.isFinite(Number(cfg.server_build))) payload.server_build = Math.round(Number(cfg.server_build));
    if (!java) delete payload.java_path;
    await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(JSON.stringify(payload, null, 2) + "\n") }, 10_000);
  }

  async function writePackManifest(inst: string, payload: any) {
    const cleanInst = String(inst || "").trim();
    if (!cleanInst) throw new Error(t.tr("instance_id is required", "instance_id 不能为空"));
    const path = joinRelPath(cleanInst, PACK_MANIFEST_NAME);
    await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(JSON.stringify(payload ?? null, null, 2) + "\n") }, 10_000);
  }

  async function readPackManifest(inst: string): Promise<any | null> {
    const cleanInst = String(inst || "").trim();
    if (!cleanInst) return null;
    try {
      const out = await callOkCommand("fs_read", { path: joinRelPath(cleanInst, PACK_MANIFEST_NAME) }, 10_000);
      const raw = b64DecodeUtf8(String(out?.b64 || ""));
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function readInstanceConfigForStart(inst: string): Promise<StartOverride> {
    const cleanInst = String(inst || "").trim();
    if (!cleanInst) return {};
    const defaults = {
      jarPath: normalizeJarPath(cleanInst, "server.jar"),
      javaPath: "",
      gamePort: 25565,
      xms: String(panelSettings?.defaults?.xms || "1G"),
      xmx: String(panelSettings?.defaults?.xmx || "2G"),
      enableFrp: false,
      frpProfileId: "",
      frpRemotePort: 0,
    } satisfies StartOverride;

    let cfg: any = null;
    try {
      const out = await callOkCommand("fs_read", { path: joinRelPath(cleanInst, INSTANCE_CONFIG_NAME) }, 10_000);
      const raw = b64DecodeUtf8(String(out?.b64 || ""));
      const parsed = raw ? JSON.parse(raw) : null;
      cfg = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      cfg = null;
    }

    const jarPathRaw = typeof cfg?.jar_path === "string" ? String(cfg.jar_path) : defaults.jarPath;
    const jarPath = normalizeJarPath(cleanInst, jarPathRaw);
    const javaPath = typeof cfg?.java_path === "string" ? String(cfg.java_path).trim() : defaults.javaPath;

    let gamePort = defaults.gamePort;
    const gamePortRaw = Math.round(Number(cfg?.game_port ?? 0));
    if (Number.isFinite(gamePortRaw) && gamePortRaw >= 1 && gamePortRaw <= 65535) {
      gamePort = gamePortRaw;
    } else {
      // Fallback: try server.properties
      try {
        const propsOut = await callOkCommand("fs_read", { path: joinRelPath(cleanInst, "server.properties") }, 10_000);
        const text = b64DecodeUtf8(String(propsOut?.b64 || ""));
        const v = getPropValue(text, "server-port");
        const p = Math.round(Number(v || 0));
        if (Number.isFinite(p) && p >= 1 && p <= 65535) gamePort = p;
      } catch {
        // ignore
      }
    }

    const xms = typeof cfg?.xms === "string" && String(cfg.xms).trim() ? String(cfg.xms).trim() : defaults.xms;
    const xmx = typeof cfg?.xmx === "string" && String(cfg.xmx).trim() ? String(cfg.xmx).trim() : defaults.xmx;

    const jvmArgs = Array.isArray(cfg?.jvm_args)
      ? cfg.jvm_args.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 120)
      : computeJvmArgs(cfg?.jvm_args_preset, cfg?.jvm_args_extra);

    const enableFrp = typeof cfg?.enable_frp === "boolean" ? !!cfg.enable_frp : defaults.enableFrp;
    const frpProfileId = typeof cfg?.frp_profile_id === "string" ? String(cfg.frp_profile_id) : defaults.frpProfileId;
    const frpRemotePortRaw = Math.round(Number(cfg?.frp_remote_port ?? defaults.frpRemotePort));
    const frpRemotePort = Number.isFinite(frpRemotePortRaw) && frpRemotePortRaw >= 0 && frpRemotePortRaw <= 65535 ? frpRemotePortRaw : 0;

    return { jarPath, javaPath, gamePort, xms, xmx, jvmArgs, enableFrp, frpProfileId, frpRemotePort };
  }

  async function startServerFromSavedConfig(instanceOverride: string) {
    const inst = String(instanceOverride || "").trim();
    if (!inst) return;
    const override = await readInstanceConfigForStart(inst);
    await startServer(inst, override);
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
      setConfirmTitle(opts.title || t.tr("Confirm", "确认"));
      setConfirmMessage(msg);
      setConfirmDanger(!!opts.danger);
      setConfirmConfirmLabel(opts.confirmLabel || (opts.danger ? t.tr("Delete", "删除") : t.tr("OK", "确定")));
      setConfirmCancelLabel(opts.cancelLabel || t.tr("Cancel", "取消"));
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
      setPromptTitle(opts.title || t.tr("Input", "输入"));
      setPromptMessage(String(opts.message || ""));
      setPromptPlaceholder(String(opts.placeholder || ""));
      setPromptValue(String(opts.defaultValue || ""));
      setPromptOkLabel(opts.okLabel || t.tr("OK", "确定"));
      setPromptCancelLabel(opts.cancelLabel || t.tr("Cancel", "取消"));
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
    setChangelogStatus(t.tr("Loading...", "加载中..."));
    try {
      const res = await apiFetch("/api/changelog", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
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
    setHelpDocStatus(t.tr("Loading...", "加载中..."));
    try {
      const res = await apiFetch(`/api/docs?name=${encodeURIComponent(key)}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
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
    const txt = String(text || "");
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setServerOpStatus(t.tr("Copied", "已复制"));
      pushToast(t.tr("Copied", "已复制"), "ok");
      return;
    } catch {
      // ignore
    }
    openCopyModal(txt);
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

  function dismissToast(id: string) {
    const tid = String(id || "");
    if (!tid) return;
    setToasts((prev) => prev.filter((t) => t.id !== tid));
  }

  useEffect(() => {
    if (!toasts.length) return;
    const timer = window.setInterval(() => {
      if (toastsPaused) return;
      const now = Date.now();
      setToasts((prev) => prev.filter((x) => x.expiresAtMs > now));
    }, 250);
    return () => window.clearInterval(timer);
  }, [toasts.length, toastsPaused]);

  useEffect(() => {
    if (!undoTrash) return;
    const ms = Math.max(0, Math.round(undoTrash.expiresAtMs - Date.now()));
    if (ms <= 0) {
      setUndoTrash(null);
      return;
    }
    const timer = window.setTimeout(() => setUndoTrash((cur) => (cur && cur.expiresAtMs === undoTrash.expiresAtMs ? null : cur)), ms);
    return () => window.clearTimeout(timer);
  }, [undoTrash]);

  useEffect(() => {
    return () => {
      if (fsPreviewUrl) URL.revokeObjectURL(fsPreviewUrl);
    };
  }, [fsPreviewUrl]);

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
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
        const now = Math.floor(Date.now() / 1000);
        const list = Array.isArray(json.daemons) ? json.daemons : [];
        setDaemons(list);
        setDaemonsCacheAtUnix(now);
        try {
          // Best-effort offline cache (avoid blank UI after refresh during disconnects).
          localStorage.setItem(DAEMONS_CACHE_KEY, JSON.stringify({ at_unix: now, daemons: list }));
        } catch {
          // ignore
        }
        if (!selected && (json.daemons || []).length > 0) setSelected(json.daemons[0].id);
        setError("");
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      }
    }
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, authed]);

  // Offline cache for daemons list (best-effort).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DAEMONS_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.daemons) ? parsed.daemons : null;
      const at = Math.round(Number(parsed?.at_unix || 0));
      if (list) setDaemons(list);
      if (Number.isFinite(at) && at > 0) setDaemonsCacheAtUnix(at);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Updates cache (offline-friendly banner).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("elegantmc_updates_cache");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") setUpdateInfo(parsed);
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
        if (typeof c.jvm_args_preset === "string") setJvmArgsPreset(normalizeJvmPreset(c.jvm_args_preset));
        if (typeof c.jvm_args_extra === "string") setJvmArgsExtra(c.jvm_args_extra);
        if (typeof c.server_kind === "string") {
          const k = String(c.server_kind || "").trim().toLowerCase();
          setInstalledServerKind(k === "vanilla" || k === "paper" || k === "purpur" ? (k as any) : "unknown");
        }
        if (typeof c.server_version === "string") setInstalledServerVersion(String(c.server_version || "").trim());
        if (Number.isFinite(Number(c.server_build))) setInstalledServerBuild(Math.round(Number(c.server_build)));
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
    setJvmArgsPreset("default");
    setJvmArgsExtra("");
    setInstalledServerKind("unknown");
    setInstalledServerVersion("");
    setInstalledServerBuild(0);
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
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
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

  // Instance metrics history (for graphs).
  useEffect(() => {
    if (authed !== true) return;
    let cancelled = false;
    async function tick() {
      const daemonId = String(selected || "").trim();
      const inst = String(instanceId || "").trim();
      if (!daemonId || !inst) {
        setInstanceMetricsHistory([]);
        setInstanceMetricsStatus("");
        return;
      }
      try {
        const rangeSec = 60 * 60; // 1h max stored, but default view.
        const res = await apiFetch(
          `/api/daemons/${encodeURIComponent(daemonId)}/instances/${encodeURIComponent(inst)}/history?range_sec=${encodeURIComponent(String(rangeSec))}`,
          { cache: "no-store" }
        );
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
        setInstanceMetricsHistory(Array.isArray(json?.history) ? json.history : []);
        setInstanceMetricsStatus("");
      } catch (e: any) {
        if (cancelled) return;
        setInstanceMetricsHistory([]);
        setInstanceMetricsStatus(String(e?.message || e));
      }
    }
    if (tab === "games") {
      tick();
      const tmr = setInterval(tick, 5000);
      return () => {
        cancelled = true;
        clearInterval(tmr);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [tab, authed, selected, instanceId, apiFetch, t]);

  // Load Vanilla versions list (server-side fetch; avoids CORS)
  useEffect(() => {
    let cancelled = false;
    async function loadVersions() {
      setVersionsStatus(t.tr("Loading...", "加载中..."));
      try {
        const res = await fetch("/api/mc/versions", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
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
    setProfilesStatus(t.tr("Loading...", "加载中..."));
    try {
      const qs = opts.force ? "?force=1" : "";
      const res = await apiFetch(`/api/frp/profiles${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
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
    if (!res.ok) throw new Error(json?.error || t.tr("failed to load frp token", "加载 FRP token 失败"));
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
      setFsStatus(t.tr("Loading...", "加载中..."));
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
    setFsStatus(t.tr("Loading...", "加载中..."));
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
    if (!v) return t.tr("name is required", "名称不能为空");
    if (v.length > 128) return t.tr("name too long", "名称过长");
    if (v === "." || v === "..") return t.tr("invalid name", "无效名称");
    if (v.includes("/") || v.includes("\\")) return t.tr("name must not contain '/' or '\\\\'", "名称不能包含 / 或 \\\\");
    if (v.includes("\u0000")) return t.tr("name contains invalid characters", "名称包含非法字符");
    return "";
  }

  async function mkdirFsHere() {
    if (!selected) {
      setFsStatus(t.tr("Select a daemon first", "请先选择 Daemon"));
      return;
    }
    const name = await promptDialog({
      title: t.tr("New Folder", "新建文件夹"),
      message: t.tr(`Create a folder under servers/${fsPath || ""}`, `在 servers/${fsPath || ""} 下创建文件夹`),
      placeholder: t.tr("folder name", "文件夹名"),
      okLabel: t.tr("Create", "创建"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (name == null) return;
    const err = validateFsNameSegment(name);
    if (err) {
      setFsStatus(err);
      return;
    }
    const target = joinRelPath(fsPath, name);
    setFsStatus(t.tr(`Creating ${target} ...`, `创建中 ${target} ...`));
    try {
      await callOkCommand("fs_mkdir", { path: target }, 30_000);
      await refreshFsNow();
      setFsStatus(t.tr("Created", "已创建"));
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function createFileHere() {
    if (!selected) {
      setFsStatus(t.tr("Select a daemon first", "请先选择 Daemon"));
      return;
    }
    const name = await promptDialog({
      title: t.tr("New File", "新建文件"),
      message: t.tr(`Create a file under servers/${fsPath || ""}`, `在 servers/${fsPath || ""} 下创建文件`),
      placeholder: t.tr("filename (e.g. server.properties)", "文件名（例如 server.properties）"),
      okLabel: t.tr("Create", "创建"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (name == null) return;
    const err = validateFsNameSegment(name);
    if (err) {
      setFsStatus(err);
      return;
    }
    const fileName = String(name || "").trim();
    if (fsEntries.find((e: any) => String(e?.name || "") === fileName)) {
      setFsStatus(t.tr("File already exists", "文件已存在"));
      return;
    }

    const target = joinRelPath(fsPath, fileName);
    setFsStatus(t.tr(`Creating ${target} ...`, `创建中 ${target} ...`));
    try {
      await callOkCommand("fs_write", { path: target, b64: b64EncodeUtf8("") }, 30_000);
      await refreshFsNow();
      setFsSelectedFile(target);
      setFsFileText("");
      setFsSelectedFileMode("text");
      setFsStatus(t.tr("Created", "已创建"));
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
      title: t.tr("Rename", "重命名"),
      message: t.tr(`Rename ${entry?.isDir ? "folder" : "file"}:\n${from}`, `重命名${entry?.isDir ? "文件夹" : "文件"}：\n${from}`),
      defaultValue: name,
      placeholder: t.tr("new name", "新名称"),
      okLabel: t.tr("Rename", "重命名"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (next == null) return;
    const toName = String(next || "").trim();
    const err = validateFsNameSegment(toName);
    if (err) {
      setFsStatus(err);
      return;
    }
    if (toName === name) {
      setFsStatus(t.tr("No changes", "没有变化"));
      setTimeout(() => setFsStatus(""), 700);
      return;
    }
    const to = joinRelPath(fsPath, toName);
    setFsStatus(t.tr(`Renaming ${from} -> ${to} ...`, `重命名中 ${from} -> ${to} ...`));
    try {
      await callOkCommand("fs_move", { from, to }, 60_000);
      if (fsSelectedFile === from || fsSelectedFile.startsWith(`${from}/`)) {
        const suffix = fsSelectedFile.slice(from.length);
        setFsSelectedFile(`${to}${suffix}`);
      }
      await refreshFsNow();
      setFsStatus(t.tr("Renamed", "已重命名"));
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
      title: t.tr("Move", "移动"),
      message: t.tr(
        `Move ${entry?.isDir ? "folder" : "file"}:\n${from}\n\nTarget path is relative to servers/ (use /).`,
        `移动${entry?.isDir ? "文件夹" : "文件"}：\n${from}\n\n目标路径为 servers/ 下的相对路径（使用 /）。`
      ),
      defaultValue: from,
      placeholder: t.tr("target/path", "目标/路径"),
      okLabel: t.tr("Move", "移动"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (next == null) return;
    const toRaw = normalizeRelFilePath(next);
    if (!toRaw) {
      setFsStatus(t.tr("invalid target path", "目标路径无效"));
      return;
    }
    const to = toRaw;
    if (to === from) {
      setFsStatus(t.tr("No changes", "没有变化"));
      setTimeout(() => setFsStatus(""), 700);
      return;
    }

    setFsStatus(t.tr(`Moving ${from} -> ${to} ...`, `移动中 ${from} -> ${to} ...`));
    try {
      try {
        await callOkCommand("fs_stat", { path: to }, 10_000);
        setFsStatus(t.tr("destination exists", "目标已存在"));
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
      setFsStatus(t.tr("Moved", "已移动"));
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
      setFsStatus(
        t.tr(
          `File too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)})`,
          `文件过大，无法在浏览器中下载（${fmtBytes(size)} > ${fmtBytes(max)}）`
        )
      );
      return;
    }

    setFsStatus(t.tr(`Downloading ${path} ...`, `下载中 ${path} ...`));
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
      pushToast(t.tr(`Downloaded: ${name}`, `已下载：${name}`), "ok");
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function downloadFsFolderAsZip(entry: any) {
    const name = String(entry?.name || "").trim();
    if (!name || !entry?.isDir) return;
    const dirPath = joinRelPath(fsPath, name);

    setFsStatus(t.tr(`Zipping ${dirPath} ...`, `打包中 ${dirPath} ...`));
    let zipPath = "";
    try {
      const out = await callOkCommand("fs_zip", { path: dirPath }, 10 * 60_000);
      zipPath = String(out?.zip_path || "").trim();
      if (!zipPath) throw new Error(t.tr("zip_path missing", "zip_path 缺失"));

      const st = await callOkCommand("fs_stat", { path: zipPath }, 10_000);
      const size = Math.max(0, Number(st?.size || 0));
      const max = 50 * 1024 * 1024;
      if (size > max) {
        throw new Error(
          t.tr(
            `Zip too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)}). File: ${zipPath}`,
            `Zip 过大，无法在浏览器中下载（${fmtBytes(size)} > ${fmtBytes(max)}）。文件：${zipPath}`
          )
        );
      }

      setFsStatus(t.tr(`Downloading ${zipPath} ...`, `下载中 ${zipPath} ...`));
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
      pushToast(t.tr(`Downloaded: ${a.download}`, `已下载：${a.download}`), "ok");
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
	    const ok = await confirmDialog(t.tr(`Delete ${label}?`, `删除 ${label}？`), {
	      title: t.tr("Delete", "删除"),
	      confirmLabel: t.tr("Delete", "删除"),
	      cancelLabel: t.tr("Cancel", "取消"),
	      danger: true,
	    });
	    if (!ok) return;

	    const inTrash = target === "_trash" || target.startsWith("_trash/");
	    setFsStatus(inTrash ? t.tr(`Deleting ${target} ...`, `删除中 ${target} ...`) : t.tr(`Moving to trash: ${target} ...`, `移入回收站：${target} ...`));
		    try {
		      if (inTrash) {
		        await callOkCommand("fs_delete", { path: target }, 60_000);
		      } else {
		        const out = await callOkCommand("fs_trash", { path: target }, 60_000);
		        const trashId = String(out?.trash_id || "").trim();
		        const trashPath = String(out?.trash_path || "").trim();
		        const daemonId = String(selected || "").trim();
		        if (daemonId && (trashId || trashPath)) {
		          setUndoTrash({
		            daemonId,
		            trashId,
		            trashPath,
		            originalPath: target,
		            message: t.tr(`Moved to trash: ${target}`, `已移入回收站：${target}`),
		            expiresAtMs: Date.now() + 9000,
		          });
		        }
		      }
	      if (fsSelectedFile === target || fsSelectedFile.startsWith(`${target}/`)) {
	        setFsSelectedFile("");
	        setFsFileText("");
      }
      await refreshFsNow();
      setFsStatus(inTrash ? t.tr("Deleted", "已删除") : t.tr("Moved to trash", "已移入回收站"));
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
	    }
	  }

	  async function bulkDeleteFsEntries(entries: any[]): Promise<boolean> {
	    const list = (Array.isArray(entries) ? entries : [])
	      .map((e) => ({ name: String(e?.name || "").trim(), isDir: !!e?.isDir }))
	      .filter((e) => e.name && e.name !== "." && e.name !== "..");
	    if (!list.length) return false;

	    const targets = list.map((e) => joinRelPath(fsPath, e.name)).filter(Boolean);
	    const shown = targets.slice(0, 8).map((p) => `- ${p}`).join("\n");
	    const more = targets.length > 8 ? `\n… ${targets.length - 8} more` : "";
	    const ok = await confirmDialog(
	      t.tr(
	        `Delete ${targets.length} item(s)?\n\n${shown}${more}`,
	        `删除 ${targets.length} 个条目？\n\n${shown}${more}`
	      ),
	      {
	        title: t.tr("Bulk Delete", "批量删除"),
	        confirmLabel: t.tr("Delete", "删除"),
	        cancelLabel: t.tr("Cancel", "取消"),
	        danger: true,
	      }
	    );
	    if (!ok) return false;

	    setFsStatus(t.tr(`Deleting ${targets.length} item(s) ...`, `删除中：${targets.length} 个...`));
	    let failed = 0;
	    let movedToTrash = 0;
	    let deleted = 0;
	    let lastTrash: { trashId: string; trashPath: string; originalPath: string } | null = null;

	    for (const target of targets) {
	      const inTrash = target === "_trash" || target.startsWith("_trash/");
	      try {
	        if (inTrash) {
	          await callOkCommand("fs_delete", { path: target }, 60_000);
	          deleted++;
	        } else {
	          const out = await callOkCommand("fs_trash", { path: target }, 60_000);
	          movedToTrash++;
	          const trashId = String(out?.trash_id || "").trim();
	          const trashPath = String(out?.trash_path || "").trim();
	          if (trashId || trashPath) lastTrash = { trashId, trashPath, originalPath: target };
	        }
	        if (fsSelectedFile === target || fsSelectedFile.startsWith(`${target}/`)) {
	          setFsSelectedFile("");
	          setFsFileText("");
	        }
	      } catch {
	        failed++;
	      }
	    }

	    try {
	      await refreshFsNow();
	    } catch {
	      // ignore
	    }

	    if (lastTrash) {
	      const daemonId = String(selected || "").trim();
	      if (daemonId) {
	        setUndoTrash({
	          daemonId,
	          trashId: lastTrash.trashId,
	          trashPath: lastTrash.trashPath,
	          originalPath: lastTrash.originalPath,
	          message: t.tr(
	            `Moved ${movedToTrash} item(s) to trash`,
	            `已移入回收站：${movedToTrash} 个`
	          ),
	          expiresAtMs: Date.now() + 9000,
	        });
	      }
	    }

	    if (failed) setFsStatus(t.tr(`Done (${failed} failed)`, `完成（失败 ${failed} 个）`));
	    else if (movedToTrash && !deleted) setFsStatus(t.tr("Moved to trash", "已移入回收站"));
	    else setFsStatus(t.tr("Deleted", "已删除"));
	    setTimeout(() => setFsStatus(""), 1200);
	    return true;
	  }

	  async function bulkMoveFsEntries(entries: any[]): Promise<boolean> {
	    const list = (Array.isArray(entries) ? entries : [])
	      .map((e) => ({ name: String(e?.name || "").trim(), isDir: !!e?.isDir }))
	      .filter((e) => e.name && e.name !== "." && e.name !== "..");
	    if (!list.length) return false;

	    const preview = list
	      .slice(0, 8)
	      .map((e) => `- ${joinRelPath(fsPath, e.name)}`)
	      .join("\n");
	    const more = list.length > 8 ? `\n… ${list.length - 8} more` : "";
	    const raw = await promptDialog({
	      title: t.tr("Bulk Move", "批量移动"),
	      message: t.tr(
	        `Move ${list.length} item(s) to which folder?\n\n${preview}${more}\n\nTarget folder is relative to servers/ (use /). Leave empty for servers/ root.`,
	        `将 ${list.length} 个条目移动到哪个文件夹？\n\n${preview}${more}\n\n目标文件夹为 servers/ 下的相对路径（使用 /）。留空表示 servers/ 根目录。`
	      ),
	      defaultValue: fsPath,
	      placeholder: t.tr("target/folder (empty = servers/ root)", "目标/文件夹（留空=servers/根目录）"),
	      okLabel: t.tr("Move", "移动"),
	      cancelLabel: t.tr("Cancel", "取消"),
	    });
	    if (raw == null) return false;

	    const rawTrim = String(raw || "").trim();
	    const rawNorm = rawTrim.replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	    let dir = "";
	    if (!rawNorm || rawNorm === "." || rawNorm === "./") {
	      dir = "";
	    } else {
	      dir = normalizeRelFilePath(rawNorm);
	      if (!dir) {
	        setFsStatus(t.tr("invalid target path", "目标路径无效"));
	        return false;
	      }
	    }

	    const ok = await confirmDialog(
	      t.tr(
	        `Move ${list.length} item(s) to ${dir ? `servers/${dir}/` : "servers/"} ?`,
	        `将 ${list.length} 个条目移动到 ${dir ? `servers/${dir}/` : "servers/"} ？`
	      ),
	      { title: t.tr("Bulk Move", "批量移动"), confirmLabel: t.tr("Move", "移动"), cancelLabel: t.tr("Cancel", "取消"), danger: true }
	    );
	    if (!ok) return false;

	    setFsStatus(t.tr(`Moving ${list.length} item(s) ...`, `移动中：${list.length} 个...`));
	    let failed = 0;
	    let moved = 0;

	    for (const e of list) {
	      const from = joinRelPath(fsPath, e.name);
	      const to = joinRelPath(dir, e.name);
	      if (!from || !to || from === to) continue;
	      try {
	        try {
	          await callOkCommand("fs_stat", { path: to }, 10_000);
	          failed++;
	          continue;
	        } catch {
	          // ok: target not found
	        }
	        await callOkCommand("fs_move", { from, to }, 60_000);
	        moved++;
	        if (fsSelectedFile === from || fsSelectedFile.startsWith(`${from}/`)) {
	          const suffix = fsSelectedFile.slice(from.length);
	          setFsSelectedFile(`${to}${suffix}`);
	        }
	      } catch {
	        failed++;
	      }
	    }

	    try {
	      await refreshFsNow();
	    } catch {
	      // ignore
	    }

	    if (failed) setFsStatus(t.tr(`Moved ${moved} (${failed} failed)`, `已移动 ${moved} 个（失败 ${failed} 个）`));
	    else setFsStatus(t.tr("Moved", "已移动"));
	    setTimeout(() => setFsStatus(""), 1200);
	    return true;
	  }

	  async function openEntry(entry: any) {
	    const name = entry?.name || "";
	    if (!name) return;
	    if (fsDirty) {
      const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
        title: t.tr("Unsaved Changes", "未保存更改"),
        confirmLabel: t.tr("Discard", "放弃"),
        cancelLabel: t.tr("Cancel", "取消"),
        danger: true,
      });
      if (!ok) return;
    }
	    if (entry?.isDir) {
	      setFsSelectedFile("");
	      setFsFileText("");
	      setFsFileTextSaved("");
	      setFsSelectedFileMode("none");
	      setFsPreviewUrl("");
	      setFsPath(joinRelPath(fsPath, name));
	      return;
	    }
	    const size = Number(entry?.size || 0);
	    const lower = String(name).toLowerCase();
	    const filePath = joinRelPath(fsPath, name);
	    const isImage =
	      lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp");
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

	    if (isImage) {
	      const max = 5 * 1024 * 1024;
	      if (size > 0 && size <= max) {
	        setFsSelectedFile(filePath);
	        setFsFileText("");
	        setFsFileTextSaved("");
	        setFsSelectedFileMode("image");
	        setFsPreviewUrl("");
	        setFsStatus(t.tr(`Previewing ${filePath} ...`, `预览中 ${filePath} ...`));
	        try {
	          const payload = await callOkCommand("fs_read", { path: filePath }, 60_000);
	          const bytes = b64DecodeBytes(String(payload?.b64 || ""));
	          const mime =
	            lower.endsWith(".png")
	              ? "image/png"
	              : lower.endsWith(".gif")
	                ? "image/gif"
	                : lower.endsWith(".webp")
	                  ? "image/webp"
	                  : "image/jpeg";
	          const blob = new Blob([bytes], { type: mime });
	          const url = URL.createObjectURL(blob);
	          setFsPreviewUrl(url);
	          setFsStatus("");
	        } catch (e: any) {
	          setFsSelectedFileMode("binary");
	          setFsPreviewUrl("");
	          setFsStatus(String(e?.message || e));
	        }
	        return;
	      }
	    }

	    if (size > 512 * 1024 || likelyBinaryExt) {
	      setFsSelectedFile(filePath);
	      setFsFileText("");
	      setFsFileTextSaved("");
	      setFsSelectedFileMode("binary");
	      setFsPreviewUrl("");
	      setFsStatus(t.tr("Binary/large file: download-only", "二进制/大文件：仅支持下载"));
	      return;
	    }
	    setFsStatus(t.tr(`Reading ${filePath} ...`, `读取中 ${filePath} ...`));
	    try {
	      const payload = await callOkCommand("fs_read", { path: filePath });
	      const bytes = b64DecodeBytes(String(payload?.b64 || ""));
	      if (isProbablyBinary(bytes)) {
	        setFsSelectedFile(filePath);
	        setFsFileText("");
	        setFsFileTextSaved("");
	        setFsSelectedFileMode("binary");
	        setFsPreviewUrl("");
	        setFsStatus(t.tr("Binary file: download-only", "二进制文件：仅支持下载"));
	        return;
	      }
	      const text = new TextDecoder().decode(bytes);
	      setFsSelectedFile(filePath);
	      setFsSelectedFileMode("text");
	      setFsFileText(text);
	      setFsFileTextSaved(text);
	      setFsPreviewUrl("");
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
      setFsStatus(t.tr("Select a daemon first", "请先选择 Daemon"));
      return;
    }
    if (fsDirty) {
      const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
        title: t.tr("Unsaved Changes", "未保存更改"),
        confirmLabel: t.tr("Discard", "放弃"),
        cancelLabel: t.tr("Cancel", "取消"),
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
	    setFsPreviewUrl("");
	    setFsStatus(t.tr(`Opening ${p} ...`, `打开中 ${p} ...`));

    try {
      const payload = await callOkCommand("fs_list", { path: dir }, 30_000);
      setFsEntries(payload.entries || []);

      const entry = (payload.entries || []).find((e: any) => String(e?.name || "") === name) || null;
      if (!entry) throw new Error(t.tr("file not found", "未找到文件"));
      if (entry?.isDir) {
        setFsPath(p);
        setFsStatus("");
        return;
      }

	      const size = Number(entry?.size || 0);
	      const lower = String(name).toLowerCase();
	      const filePath = joinRelPath(dir, name);
	      const isImage =
	        lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp");
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

	      if (isImage) {
	        const max = 5 * 1024 * 1024;
	        if (size > 0 && size <= max) {
	          setFsSelectedFile(filePath);
	          setFsFileText("");
	          setFsFileTextSaved("");
	          setFsSelectedFileMode("image");
	          setFsPreviewUrl("");
	          setFsStatus(t.tr(`Previewing ${filePath} ...`, `预览中 ${filePath} ...`));
	          try {
	            const payload = await callOkCommand("fs_read", { path: filePath }, 60_000);
	            const bytes = b64DecodeBytes(String(payload?.b64 || ""));
	            const mime =
	              lower.endsWith(".png")
	                ? "image/png"
	                : lower.endsWith(".gif")
	                  ? "image/gif"
	                  : lower.endsWith(".webp")
	                    ? "image/webp"
	                    : "image/jpeg";
	            const blob = new Blob([bytes], { type: mime });
	            const url = URL.createObjectURL(blob);
	            setFsPreviewUrl(url);
	            setFsStatus("");
	          } catch (e: any) {
	            setFsSelectedFileMode("binary");
	            setFsPreviewUrl("");
	            setFsStatus(String(e?.message || e));
	          }
	          return;
	        }
	      }

	      if (size > 512 * 1024 || likelyBinaryExt) {
	        setFsSelectedFile(filePath);
	        setFsFileText("");
	        setFsFileTextSaved("");
	        setFsSelectedFileMode("binary");
	        setFsPreviewUrl("");
	        setFsStatus(t.tr("Binary/large file: download-only", "二进制/大文件：仅支持下载"));
	        return;
	      }

	      const file = await callOkCommand("fs_read", { path: filePath }, 30_000);
	      const bytes = b64DecodeBytes(String(file?.b64 || ""));
	      if (isProbablyBinary(bytes)) {
	        setFsSelectedFile(filePath);
	        setFsFileText("");
	        setFsFileTextSaved("");
	        setFsSelectedFileMode("binary");
	        setFsPreviewUrl("");
	        setFsStatus(t.tr("Binary file: download-only", "二进制文件：仅支持下载"));
	        return;
	      }
	      const text = new TextDecoder().decode(bytes);
	      setFsSelectedFile(filePath);
	      setFsSelectedFileMode("text");
	      setFsFileText(text);
	      setFsFileTextSaved(text);
	      setFsPreviewUrl("");
	      setFsStatus("");
	    } catch (e: any) {
	      setFsStatus(String(e?.message || e));
	    }
	  }

  async function fsReadText(pathRaw: string, timeoutMs = 30_000) {
    const p = String(pathRaw || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p) throw new Error(t.tr("path is required", "path 不能为空"));
    if (!selected) throw new Error(t.tr("Select a daemon first", "请先选择 Daemon"));

    const lower = p.toLowerCase();
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
    if (likelyBinaryExt) {
      throw new Error(t.tr("Binary file: download-only", "二进制文件：仅支持下载"));
    }

    const st = await callOkCommand("fs_stat", { path: p }, 10_000);
    if (st?.isDir) throw new Error(t.tr("Not a file", "不是文件"));
    const size = Number(st?.size || 0);
    if (size > 512 * 1024) {
      throw new Error(t.tr("File too large for preview", "文件过大，无法预览"));
    }

    const payload = await callOkCommand("fs_read", { path: p }, timeoutMs);
    const bytes = b64DecodeBytes(String(payload?.b64 || ""));
    if (isProbablyBinary(bytes)) {
      throw new Error(t.tr("Binary file: download-only", "二进制文件：仅支持下载"));
    }
    return new TextDecoder().decode(bytes);
  }

  async function fsWriteText(pathRaw: string, textRaw: string, timeoutMs = 30_000) {
    const p = String(pathRaw || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p) throw new Error(t.tr("path is required", "path 不能为空"));
    if (!selected) throw new Error(t.tr("Select a daemon first", "请先选择 Daemon"));

    const text = String(textRaw ?? "");
    await callOkCommand("fs_write", { path: p, b64: b64EncodeUtf8(text) }, timeoutMs);
  }

  async function setServerJarFromFile(filePath: string) {
    const inst = instanceId.trim();
    if (!inst) {
      setFsStatus(t.tr("Select a game first", "请先选择游戏实例"));
      return;
    }
    if (!selectedDaemon?.connected) {
      setFsStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const p = String(filePath || "")
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p || !p.toLowerCase().endsWith(".jar")) {
      setFsStatus(t.tr("Not a .jar file", "不是 .jar 文件"));
      return;
    }
    if (p !== inst && !p.startsWith(`${inst}/`)) {
      setFsStatus(t.tr(`Jar must be under servers/${inst}/`, `Jar 必须位于 servers/${inst}/ 下`));
      return;
    }
    const jarRel = normalizeJarPath(inst, p);
    setFsStatus(t.tr(`Setting server jar: ${jarRel} ...`, `设置服务端 Jar：${jarRel} ...`));
    try {
      await writeInstanceConfig(inst, { jar_path: jarRel });
      setJarPath(jarRel);
      setFsStatus(t.tr("Server jar updated", "服务端 Jar 已更新"));
      pushToast(t.tr(`Server jar: ${jarRel}`, `服务端 Jar：${jarRel}`), "ok");
      setTimeout(() => setFsStatus(""), 900);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function saveFile() {
    if (!fsSelectedFile) {
      setFsStatus(t.tr("No file selected", "未选择文件"));
      return;
    }
    if (fsSelectedFileMode !== "text") {
      setFsStatus(t.tr("Binary file: edit disabled (download instead)", "二进制文件：已禁用编辑（请下载）"));
      return;
    }
    setFsStatus(t.tr(`Saving ${fsSelectedFile} ...`, `保存中 ${fsSelectedFile} ...`));
    try {
      await callOkCommand("fs_write", { path: fsSelectedFile, b64: b64EncodeUtf8(fsFileText) });
      setFsFileTextSaved(fsFileText);
      setFsStatus(t.tr("Saved", "已保存"));
      setTimeout(() => setFsStatus(""), 800);
    } catch (e: any) {
      setFsStatus(String(e?.message || e));
    }
  }

  async function uploadFilesNow(filesLike: File[] | FileList) {
    const files = Array.isArray(filesLike) ? filesLike : Array.from(filesLike || []);
    const list = files.filter(Boolean);
    if (!list.length) {
      setUploadStatus(t.tr("Select file(s) first", "请先选择文件"));
      return;
    }
    if (!selected) {
      setUploadStatus(t.tr("Select a daemon first", "请先选择 Daemon"));
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
      setUploadStatus(t.tr(`Begin: ${destPath} (${file.size} bytes)`, `开始：${destPath}（${file.size} bytes）`));

      try {
        const begin = await callOkCommand("fs_upload_begin", { path: destPath });
        uploadID = String(begin.upload_id || "");
        if (!uploadID) throw new Error(t.tr("upload_id missing", "upload_id 缺失"));

        for (let off = 0; off < file.size; off += chunkSize) {
          const end = Math.min(off + chunkSize, file.size);
          const ab = await file.slice(off, end).arrayBuffer();
          const b64 = b64EncodeBytes(new Uint8Array(ab));
          await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 });
          setUploadStatus(t.tr(`Uploading ${destPath}: ${end}/${file.size} bytes`, `上传中 ${destPath}: ${end}/${file.size} bytes`));
        }

        const commit = await callOkCommand("fs_upload_commit", { upload_id: uploadID });
        setUploadStatus(
          t.tr(
            `Done: ${commit.path || destPath} (${commit.bytes || file.size} bytes)`,
            `完成：${commit.path || destPath}（${commit.bytes || file.size} bytes）`
          )
        );
      } catch (e: any) {
        if (uploadID) {
          try {
            await callOkCommand("fs_upload_abort", { upload_id: uploadID });
          } catch {
            // ignore
          }
        }
        setUploadStatus(t.tr(`Upload failed: ${String(e?.message || e)}`, `上传失败：${String(e?.message || e)}`));
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
      setUploadStatus(t.tr("Select file first", "请先选择文件"));
      return;
    }
    await uploadFilesNow([uploadFile]);
  }

  async function uploadZipAndExtractHere() {
    if (!uploadFile) {
      setUploadStatus(t.tr("Select a zip file first", "请先选择 zip 文件"));
      return;
    }
    if (!selected) {
      setUploadStatus(t.tr("Select a daemon first", "请先选择 Daemon"));
      return;
    }
    if (!fsPath) {
      setUploadStatus(t.tr("Select a target folder first (cannot extract into servers/ root).", "请先选择目标文件夹（不能解压到 servers/ 根目录）"));
      return;
    }

    const file = uploadFile;
    const name = String(file.name || "").toLowerCase();
    if (!name.endsWith(".zip")) {
      setUploadStatus(t.tr("Only .zip files are supported", "只支持 .zip 文件"));
      return;
    }

    const destPath = joinRelPath(fsPath, file.name);
    try {
      await uploadFilesNow([file]);
      setUploadStatus(t.tr(`Extracting ${destPath} ...`, `解压中 ${destPath} ...`));
      await callOkCommand("fs_unzip", { zip_path: destPath, dest_dir: fsPath, instance_id: fsPath, strip_top_level: false }, 10 * 60_000);
      try {
        await callOkCommand("fs_delete", { path: destPath }, 60_000);
      } catch {
        // ignore
      }
      await refreshFsNow();
      setUploadStatus(t.tr("Extracted", "已解压"));
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
      setMarketStatus(t.tr("CurseForge is disabled (configure API key in Panel settings)", "CurseForge 已禁用（请在 Panel 设置中配置 API Key）"));
      return;
    }
    const q = String(marketQuery || "").trim();
    if (!q) return;

    setMarketStatus(t.tr("Searching...", "搜索中..."));
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
      if (!res.ok) throw new Error(json?.error || t.tr("search failed", "搜索失败"));
      const results = Array.isArray(json?.results) ? json.results : [];
      setMarketResults(results);
      setMarketStatus(results.length ? t.tr(`Found ${results.length} result(s)`, `找到 ${results.length} 条结果`) : t.tr("No results", "无结果"));
    } catch (e: any) {
      setMarketStatus(String(e?.message || e));
    }
  }

  async function resolveCurseForgeUrl() {
    if (installRunning) return;
    const inputUrl = String(installForm.remoteUrl || "").trim();
    if (!inputUrl) return;

    setCfResolveBusy(true);
    setCfResolveStatus(t.tr("Resolving...", "解析中..."));
    try {
      const params = new URLSearchParams();
      params.set("url", inputUrl);
      const res = await apiFetch(`/api/modpacks/curseforge/resolve-url?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("resolve failed", "解析失败"));

      const resolved = String(json?.resolved || "").trim();
      const fileName = String(json?.file_name || "").trim();
      if (!resolved) throw new Error(t.tr("no resolved url", "未获取到解析后的链接"));
      setInstallForm((f) => ({
        ...f,
        remoteUrl: resolved,
        remoteFileName: f.remoteFileName || fileName,
      }));
      setCfResolveStatus(t.tr("Resolved", "已解析"));
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

  async function installModrinthMrpack(inst: string, mrpackRel: string, jarRel: string): Promise<any> {
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
    let loaderKind = "";
    let loaderVer = "";
    if (fabricLoader || quiltLoader) {
      loaderKind = fabricLoader ? "fabric" : "quilt";
      loaderVer = fabricLoader || quiltLoader;
    } else if (neoForge) {
      loaderKind = "neoforge";
      loaderVer = neoForge;
    } else if (forge) {
      loaderKind = "forge";
      loaderVer = forge;
    } else {
      throw new Error("mrpack missing supported loader dependency (fabric-loader/quilt-loader/forge/neoforge)");
    }

    const manifest: any = {
      schema: 1,
      provider: "modrinth",
      installed_at_unix: Math.floor(Date.now() / 1000),
      source: { mrpack_path: mrpackRel },
      mrpack: {
        name: String(index?.name || "").trim(),
        summary: String(index?.summary || "").trim(),
        project_id: String(index?.projectId || index?.project_id || "").trim(),
        version_id: String(index?.versionId || index?.version_id || "").trim(),
      },
      minecraft: { version: mc },
      loader: { kind: loaderKind, version: loaderVer },
      server: { jar_path: jarRel },
      files: [],
    };

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
        if (!url) throw new Error(t.tr(`mrpack file missing download url: ${rel}`, `mrpack 文件缺少下载链接：${rel}`));
        const sha1 = String(f?.hashes?.sha1 || "").trim();
        return { rel, url, sha1 };
      })
      .filter(Boolean) as { rel: string; url: string; sha1: string }[];

    const allItems = queue.slice();
    manifest.files = allItems.map((it) => ({ path: it.rel, sha1: it.sha1 }));

    const total = queue.length;
    let done = 0;
    if (total) setServerOpStatus(t.tr(`Downloading mrpack files: 0/${total} ...`, `下载 mrpack 文件：0/${total} ...`));
    if (total) setInstallProgress({ phase: t.tr("Downloading pack files", "下载整合包文件"), currentFile: "", done: 0, total });

    const concurrency = Math.max(1, Math.min(4, total));
    let failed: any = null;
    const workers = Array.from({ length: concurrency }).map(async () => {
      while (queue.length && !failed) {
        const item = queue.shift();
        if (!item) break;
        try {
          setInstallProgress((p) => (p ? { ...p, currentFile: item.rel } : p));
          await callOkCommand(
            "fs_download",
            { path: joinRelPath(inst, item.rel), url: item.url, ...(isHex40(item.sha1) ? { sha1: item.sha1 } : {}), instance_id: inst },
            10 * 60_000
          );
          done++;
          setInstallProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + 1) } : p));
          if (total) setServerOpStatus(t.tr(`Downloading mrpack files: ${done}/${total} ...`, `下载 mrpack 文件：${done}/${total} ...`));
        } catch (e) {
          failed = e || new Error(t.tr("download failed", "下载失败"));
          throw failed;
        }
      }
    });
    await Promise.all(workers);
    setInstallProgress((p) => (p ? { ...p, currentFile: "" } : p));

    if (loaderKind === "forge" || loaderKind === "neoforge") {
      const docPath = joinRelPath(inst, "FORGE_SERVER_SETUP.txt");
      const doc = [
        `Forge/NeoForge mrpack detected`,
        ``,
        `Minecraft: ${mc}`,
        `Loader: ${loaderKind} ${loaderVer}`,
        ``,
        `The pack files (mods/config/etc) have been downloaded into this instance folder.`,
        `Forge/NeoForge server bootstrap is not automated yet.`,
        ``,
        `Recommended:`,
        `1) Download the official ${loaderKind} server installer for Minecraft ${mc} / ${loaderVer}.`,
        `2) Run it inside servers/${inst}/ to generate the server runtime.`,
        `3) Then set the correct jar in Games → Settings, or run Games → More → Repair.`,
        ``,
        `检测到 Forge/NeoForge mrpack`,
        ``,
        `Minecraft：${mc}`,
        `Loader：${loaderKind} ${loaderVer}`,
        ``,
        `已将整合包文件（mods/config 等）下载到此实例目录。`,
        `Forge/NeoForge 服务端引导暂未自动化。`,
        ``,
        `建议：`,
        `1）下载对应版本的 ${loaderKind} 服务端 installer（Minecraft ${mc} / ${loaderVer}）。`,
        `2）在 servers/${inst}/ 内运行 installer 生成可运行的服务端。`,
        `3）然后在 Games → Settings 选择正确 jar，或用 Games → More → 修复。`,
        ``,
      ].join("\n");
      await callOkCommand("fs_write", { path: docPath, b64: b64EncodeUtf8(doc) }, 10_000);
      setServerOpStatus(t.tr(`mrpack installed (Forge/NeoForge). See ${docPath}`, `mrpack 已安装（Forge/NeoForge）。见 ${docPath}`));

      // Best-effort cleanup (keep tmpRoot for debugging if deletion fails).
      try {
        await callOkCommand("fs_delete", { path: tmpRoot }, 60_000);
      } catch {
        // ignore
      }
      return manifest;
    }

    // Install loader server launcher jar.
    if (loaderKind === "quilt") {
      setServerOpStatus(t.tr(`Installing Quilt server (${mc} / loader ${loaderVer}) ...`, `安装 Quilt 服务端（${mc} / loader ${loaderVer}）...`));
      const res = await apiFetch(
        `/api/mc/quilt/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`,
        { cache: "no-store" }
      );
      const resolved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(resolved?.error || t.tr("failed to resolve Quilt server jar", "解析 Quilt 服务端 Jar 失败"));

      const serverJarUrl = String(resolved?.url || "").trim();
      if (!serverJarUrl) throw new Error(t.tr("quilt server jar url missing", "Quilt 服务端 Jar URL 缺失"));
      await callOkCommand("fs_download", { path: joinRelPath(inst, jarRel), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
    } else {
      setServerOpStatus(t.tr(`Installing Fabric server (${mc} / loader ${loaderVer}) ...`, `安装 Fabric 服务端（${mc} / loader ${loaderVer}）...`));
      const res = await apiFetch(
        `/api/mc/fabric/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`,
        { cache: "no-store" }
      );
      const resolved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(resolved?.error || t.tr("failed to resolve Fabric server jar", "解析 Fabric 服务端 Jar 失败"));

      const serverJarUrl = String(resolved?.url || "").trim();
      if (!serverJarUrl) throw new Error(t.tr("fabric server jar url missing", "Fabric 服务端 Jar URL 缺失"));
      await callOkCommand("fs_download", { path: joinRelPath(inst, jarRel), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
    }

    // Best-effort cleanup (keep tmpRoot for debugging if deletion fails).
    try {
      await callOkCommand("fs_delete", { path: tmpRoot }, 60_000);
    } catch {
      // ignore
    }
    return manifest;
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
      setMarketStatus(t.tr("No downloadable file for this version", "该版本没有可下载的文件"));
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

    setMarketStatus(t.tr("Resolving download url...", "解析下载链接中..."));
    try {
      const res = await apiFetch(`/api/modpacks/curseforge/files/${encodeURIComponent(id)}/download-url`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr(`fetch failed: ${res.status}`, `获取失败：${res.status}`));
      const url = String(json?.url || "").trim();
      if (!url) throw new Error(t.tr("no download url", "没有下载链接"));
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
        setMarketStatus(t.tr("Loading versions...", "加载版本中..."));
        const res = await apiFetch(`/api/modpacks/modrinth/${encodeURIComponent(id)}/versions`);
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr("fetch versions failed", "获取版本失败"));
        const versions = Array.isArray(json?.versions) ? json.versions : [];
        setMarketVersions(versions);
        const first = versions[0];
        if (first?.id) pickModrinthVersion(String(first.id), versions);
        else setMarketStatus(t.tr("No versions", "暂无版本"));
        return;
      }

      setMarketStatus(t.tr("Loading files...", "加载文件中..."));
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("offset", "0");
      const res = await apiFetch(`/api/modpacks/curseforge/${encodeURIComponent(id)}/files?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t.tr("fetch files failed", "获取文件失败"));
      const files = Array.isArray(json?.files) ? json.files : [];
      setMarketVersions(files);
      const first = files[0];
      if (first?.id) await pickCurseForgeFile(String(first.id), files);
      else setMarketStatus(t.tr("No files", "暂无文件"));
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
			      const isKind = (k: any): k is InstallForm["kind"] =>
			        k === "paper" || k === "purpur" || k === "zip" || k === "zip_url" || k === "modrinth" || k === "curseforge" || k === "vanilla";
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
	    setInstallProgress(null);
	    setInstallStep(1);
	    setInstallOpen(true);
	  }

	  async function runInstall(andStart: boolean) {
	    setServerOpStatus("");
	    if (!selectedDaemon?.connected) {
	      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
	      return;
	    }
	    const inst = installForm.instanceId.trim();
	    if (!inst) {
	      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
	      return;
	    }
	    const kind = installForm.kind;
	    const ver = String(installForm.version || "").trim();
		    if ((kind === "vanilla" || kind === "paper" || kind === "purpur") && !ver) {
		      setServerOpStatus(t.tr("version is required", "version 不能为空"));
		      return;
		    }
	    const jarErr =
	      kind === "zip" || kind === "zip_url" || kind === "modrinth" || kind === "curseforge"
	        ? validateJarPathUI(installForm.jarName, t.tr)
	        : validateJarNameUI(installForm.jarName, t.tr);
		    if (jarErr) {
		      setServerOpStatus(jarErr);
		      return;
		    }

        // Preflight: disk + port checks before install/start.
        const disk = selectedDaemon?.heartbeat?.disk || {};
        const freeBytes = Number((disk as any)?.free_bytes || 0);
        if (freeBytes > 0 && freeBytes < 2 * 1024 * 1024 * 1024) {
          const ok = await confirmDialog(
            t.tr(
              `Low disk space: only ${fmtBytes(freeBytes)} free.\n\nContinue anyway?`,
              `磁盘空间偏低：仅剩 ${fmtBytes(freeBytes)} 可用。\n\n仍要继续吗？`
            ),
            { title: t.tr("Preflight", "预检"), confirmLabel: t.tr("Continue", "继续"), cancelLabel: t.tr("Cancel", "取消") }
          );
          if (!ok) return;
        }

        try {
          const p = Math.round(Number(installForm.gamePort || 0));
          if (Number.isFinite(p) && p > 0) {
            const port = await callOkCommand("net_check_port", { port: p }, 10_000);
            if (port?.available === false) {
              const ok = await confirmDialog(
                t.tr(
                  `Port ${p} appears to be in use (${String(port?.error || "in use")}).\n\nContinue anyway?`,
                  `端口 ${p} 可能已被占用（${String(port?.error || "已占用")}）。\n\n仍要继续吗？`
                ),
                { title: t.tr("Port Check", "端口检查"), confirmLabel: t.tr("Continue", "继续"), cancelLabel: t.tr("Cancel", "取消"), danger: true }
              );
              if (!ok) return;
            }
          }
        } catch {
          // ignore
        }

		    setInstallInstance(inst);
		    setInstallStartUnix(Math.floor(Date.now() / 1000));
		    setInstallRunning(true);
		    setInstallProgress(null);

		    try {
			      const jarInput = String(installForm.jarName || "").trim();
			      const jarRel =
			        kind === "vanilla" || kind === "paper" || kind === "purpur" ? normalizeJarName(jarInput) : normalizeJarPath(inst, jarInput);
			      let installedJar = jarRel;
			      let build = 0;
			      let packManifest: any | null = null;
		      if (kind === "zip") {
		        const file = installZipFile;
		        if (!file) throw new Error(t.tr("zip/mrpack file is required", "需要选择 zip/mrpack 文件"));

	        // Ensure instance dir exists, then upload + extract.
	        await callOkCommand("fs_mkdir", { path: inst }, 30_000);

	        const uploadName = String(file.name || "").toLowerCase().endsWith(".mrpack") ? "modpack.mrpack" : "modpack.zip";
	        const zipRel = joinRelPath(inst, uploadName);
	        const chunkSize = 256 * 1024; // 256KB
	        let uploadID = "";
	        setServerOpStatus(t.tr(`Uploading ${uploadName}: 0/${file.size} bytes`, `上传中 ${uploadName}: 0/${file.size} bytes`));
	        try {
	          const begin = await callOkCommand("fs_upload_begin", { path: zipRel }, 30_000);
	          uploadID = String(begin.upload_id || "");
	          if (!uploadID) throw new Error(t.tr("upload_id missing", "upload_id 缺失"));

	          for (let off = 0; off < file.size; off += chunkSize) {
	            const end = Math.min(off + chunkSize, file.size);
	            const ab = await file.slice(off, end).arrayBuffer();
	            const b64 = b64EncodeBytes(new Uint8Array(ab));
	            await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 }, 60_000);
	            setServerOpStatus(t.tr(`Uploading ${uploadName}: ${end}/${file.size} bytes`, `上传中 ${uploadName}: ${end}/${file.size} bytes`));
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
		          setServerOpStatus(t.tr(`Installing ${uploadName} (.mrpack) ...`, `安装中 ${uploadName}（.mrpack）...`));
		          const mr = await installModrinthMrpack(inst, zipRel, jarRel);
		          packManifest = { ...mr, source: { ...(mr?.source || {}), kind: "upload", file_name: uploadName } };
		        } else {
		          setServerOpStatus(t.tr(`Extracting ${uploadName} ...`, `解压中 ${uploadName} ...`));
		          await callOkCommand(
		            "fs_unzip",
		            { zip_path: zipRel, dest_dir: inst, instance_id: inst, strip_top_level: true },
		            10 * 60_000
		          );
		          installedJar = await pickJarFromInstanceRoot(inst, installedJar);
		          packManifest = {
		            schema: 1,
		            provider: "zip",
		            installed_at_unix: Math.floor(Date.now() / 1000),
		            source: { kind: "upload", file_name: uploadName },
		            server: { jar_path: installedJar },
		          };
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
		        if (!remoteUrl) throw new Error(t.tr("remote url is required", "需要填写远程 URL"));

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

		        setServerOpStatus(t.tr(`Downloading ${fileName} ...`, `下载中 ${fileName} ...`));
		        await callOkCommand("fs_download", { path: zipRel, url: remoteUrl, instance_id: inst }, 10 * 60_000);

		        if ((kind === "modrinth" || kind === "zip_url") && fileName.toLowerCase().endsWith(".mrpack")) {
		          setServerOpStatus(t.tr(`Installing ${fileName} (.mrpack) ...`, `安装中 ${fileName}（.mrpack）...`));
		          const mr = await installModrinthMrpack(inst, zipRel, jarRel);
		          if (kind === "modrinth") {
		            const srcProject = String(marketSelected?.id || mr?.mrpack?.project_id || "").trim();
		            const srcVersion = String(marketSelectedVersionId || mr?.mrpack?.version_id || "").trim();
		            const srcTitle = String(marketSelected?.title || marketSelected?.name || mr?.mrpack?.name || "").trim();
		            const vnum = String(marketSelectedVersion?.version_number || "").trim();
		            const vname = String(marketSelectedVersion?.name || "").trim();
		            packManifest = {
		              ...mr,
		              source: {
		                ...(mr?.source || {}),
		                kind: "modrinth",
		                project_id: srcProject,
		                version_id: srcVersion,
		                title: srcTitle,
		                version_number: vnum,
		                version_name: vname,
		                url: remoteUrl,
		                file_name: fileName,
		              },
		            };
		            if (packManifest?.mrpack && !packManifest.mrpack.project_id && srcProject) packManifest.mrpack.project_id = srcProject;
		            if (packManifest?.mrpack && !packManifest.mrpack.version_id && srcVersion) packManifest.mrpack.version_id = srcVersion;
		          } else {
		            packManifest = { ...mr, source: { ...(mr?.source || {}), kind: "zip_url", url: remoteUrl, file_name: fileName } };
		          }
		        } else {
		          setServerOpStatus(t.tr(`Extracting ${fileName} ...`, `解压中 ${fileName} ...`));
		          await callOkCommand(
		            "fs_unzip",
		            { zip_path: zipRel, dest_dir: inst, instance_id: inst, strip_top_level: true },
		            10 * 60_000
		          );
		          installedJar = await pickJarFromInstanceRoot(inst, installedJar);
		          packManifest =
		            kind === "curseforge"
		              ? {
		                  schema: 1,
		                  provider: "curseforge",
		                  installed_at_unix: Math.floor(Date.now() / 1000),
		                  source: {
		                    kind: "curseforge",
		                    project_id: String(marketSelected?.id || "").trim(),
		                    file_id: String(marketSelectedVersionId || "").trim(),
		                    title: String(marketSelected?.name || marketSelected?.title || "").trim(),
		                    url: remoteUrl,
		                    file_name: fileName,
		                  },
		                  server: { jar_path: installedJar },
		                }
		              : kind === "modrinth"
		                ? {
		                    schema: 1,
		                    provider: "modrinth",
		                    installed_at_unix: Math.floor(Date.now() / 1000),
		                    source: {
		                      kind: "modrinth",
		                      project_id: String(marketSelected?.id || "").trim(),
		                      version_id: String(marketSelectedVersionId || "").trim(),
		                      title: String(marketSelected?.title || marketSelected?.name || "").trim(),
		                      version_number: String(marketSelectedVersion?.version_number || "").trim(),
		                      version_name: String(marketSelectedVersion?.name || "").trim(),
		                      url: remoteUrl,
		                      file_name: fileName,
		                    },
		                    server: { jar_path: installedJar },
		                  }
		                : {
		                    schema: 1,
		                    provider: "zip_url",
		                    installed_at_unix: Math.floor(Date.now() / 1000),
		                    source: { kind: "zip_url", url: remoteUrl, file_name: fileName },
		                    server: { jar_path: installedJar },
		                  };
		        }
		        try {
		          await callOkCommand("fs_delete", { path: zipRel }, 30_000);
		        } catch {
		          // ignore
		        }
			      } else {
			        build = Math.round(Number(installForm.paperBuild || 0));
			        if (kind === "purpur") {
			          setServerOpStatus(
			            build > 0
			              ? t.tr(`Installing Purpur ${ver} (build ${build}) ...`, `正在安装 Purpur ${ver}（build ${build}）...`)
		              : t.tr(`Installing Purpur ${ver} ...`, `正在安装 Purpur ${ver} ...`)
		          );
		          const res = await apiFetch(`/api/mc/purpur/jar?mc=${encodeURIComponent(ver)}&build=${encodeURIComponent(String(build || 0))}`, {
		            cache: "no-store",
		          });
		          const resolved = await res.json().catch(() => null);
		          if (!res.ok) throw new Error(resolved?.error || t.tr("failed to resolve Purpur jar", "解析 Purpur Jar 失败"));
		          const serverJarUrl = String(resolved?.url || "").trim();
		          const sha256 = String(resolved?.sha256 || "").trim();
		          if (!serverJarUrl) throw new Error(t.tr("purpur jar url missing", "Purpur Jar URL 缺失"));
		          if (!sha256) throw new Error(t.tr("purpur sha256 missing", "Purpur sha256 缺失"));

		          await callOkCommand("fs_mkdir", { path: inst }, 30_000);
		          await callOkCommand(
		            "fs_download",
		            { path: joinRelPath(inst, jarRel), url: serverJarUrl, sha256, instance_id: inst },
		            10 * 60_000
		          );
		          installedJar = jarRel;
		          if (installForm.acceptEula) {
		            await callOkCommand("fs_write", { path: joinRelPath(inst, "eula.txt"), b64: b64EncodeUtf8("eula=true\n") }, 10_000);
		          }
		        } else {
		          const cmdName = kind === "paper" ? "mc_install_paper" : "mc_install_vanilla";
		          setServerOpStatus(
		            kind === "paper" && build > 0
		              ? t.tr(`Installing Paper ${ver} (build ${build}) ...`, `正在安装 Paper ${ver}（build ${build}）...`)
		              : t.tr(
		                `Installing ${kind === "paper" ? "Paper" : "Vanilla"} ${ver} ...`,
		                `正在安装 ${kind === "paper" ? "Paper" : "原版"} ${ver} ...`
		              )
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
	      }

	      if ((kind === "zip" || kind === "zip_url" || kind === "modrinth" || kind === "curseforge") && installForm.acceptEula) {
	        setServerOpStatus(t.tr("Writing eula.txt ...", "写入 eula.txt ..."));
	        await callOkCommand(
	          "fs_write",
	          { path: joinRelPath(inst, "eula.txt"), b64: b64EncodeUtf8("eula=true\n") },
	          10_000
	        );
	      }

		      // Apply port right after install so the server listens on the expected port.
		      await applyServerPort(inst, installForm.gamePort);

		      if (packManifest) {
		        await writePackManifest(inst, packManifest);
		      }

      // Refresh installed games list.
      await refreshServerDirs();

      setInstanceId(inst);
      setJarPath(installedJar);
      setJavaPath(String(installForm.javaPath || "").trim());
      setGamePort(installForm.gamePort);
      setXms(installForm.xms);
      setXmx(installForm.xmx);
      const installedKind =
        kind === "vanilla" || kind === "paper" || kind === "purpur" ? (kind as "vanilla" | "paper" | "purpur") : ("unknown" as const);
      setInstalledServerKind(installedKind);
      setInstalledServerVersion(typeof ver === "string" ? String(ver || "").trim() : "");
      setInstalledServerBuild(build > 0 ? build : 0);
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
        ...(installedKind !== "unknown"
          ? { server_kind: installedKind, server_version: String(ver || "").trim(), server_build: build > 0 ? build : 0 }
          : {}),
        enable_frp: !!installForm.enableFrp,
        frp_profile_id: installForm.frpProfileId,
        frp_remote_port: installForm.frpRemotePort,
      });

	      setServerOpStatus(t.tr(`Installed: ${installedJar}`, `已安装：${installedJar}`));
	      if (andStart) {
	        try {
	          const r = await callOkCommand("mc_required_java", { instance_id: inst, jar_path: installedJar }, 30_000);
	          const required = Math.round(Number(r?.required_java_major || 0));
	          if (Number.isFinite(required) && required > 0) {
	            setServerOpStatus(t.tr(`Java required: >=${required}`, `需要 Java：>=${required}`));
	          }
	        } catch {
	          // ignore
	        }
	        const loaderKind = String(packManifest?.loader?.kind || "").trim().toLowerCase();
	        if (packManifest?.provider === "modrinth" && (loaderKind === "forge" || loaderKind === "neoforge")) {
	          setServerOpStatus(
	            t.tr(
	              "Installed Forge/NeoForge pack, but auto-start is not supported yet. See FORGE_SERVER_SETUP.txt in the instance folder.",
	              "已安装 Forge/NeoForge 整合包，但暂不支持自动启动。请查看实例目录下的 FORGE_SERVER_SETUP.txt。"
	            )
	          );
	        } else {
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
	      }

      // Refresh list + focus the newly installed instance.
      setInstanceId(inst);
      try {
        await refreshServerDirs();
      } catch {
        // ignore
      }

      // Auto size scan after install (best-effort).
      computeInstanceUsage(inst).catch(() => {});
	    } catch (e: any) {
	      setServerOpStatus(String(e?.message || e));
	    } finally {
	      setInstallRunning(false);
	      setInstallProgress(null);
	    }
	  }

    async function updateModrinthPack(instanceOverride?: string) {
      if (gameActionBusy) return;
      setGameActionBusy(true);
      setServerOpStatus("");
      setInstallProgress(null);
      try {
        if (!selectedDaemon?.connected) {
          setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
          return;
        }
        const inst = String(instanceOverride ?? instanceId).trim();
        if (!inst) {
          setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
          return;
        }

        const cur = await readPackManifest(inst);
        if (!cur || String(cur?.provider || "").trim() !== "modrinth") {
          setServerOpStatus(t.tr("No Modrinth pack manifest found for this instance", "该实例未找到 Modrinth 整合包 manifest"));
          return;
        }

        const projectId = String(cur?.source?.project_id || cur?.mrpack?.project_id || "").trim();
        if (!projectId) {
          setServerOpStatus(t.tr("Modrinth project_id missing in manifest", "manifest 中缺少 Modrinth project_id"));
          return;
        }
        const currentVersionId = String(cur?.source?.version_id || cur?.mrpack?.version_id || "").trim();

        setServerOpStatus(t.tr("Checking Modrinth versions...", "检查 Modrinth 版本中..."));
        const res = await apiFetch(`/api/modpacks/modrinth/${encodeURIComponent(projectId)}/versions`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr(`fetch failed: ${res.status}`, `获取失败：${res.status}`));
        const versions = Array.isArray(json?.versions) ? json.versions : [];
        if (!versions.length) throw new Error(t.tr("No versions found", "未找到版本"));

        const latest = versions[0];
        const latestId = String(latest?.id || "").trim();
        if (latestId && currentVersionId && latestId === currentVersionId) {
          setServerOpStatus(t.tr("Already up to date", "已是最新"));
          return;
        }

        const files = Array.isArray(latest?.files) ? latest.files : [];
        const file = files.find((f: any) => !!f?.primary) || files[0] || null;
        const mrUrl = String(file?.url || "").trim();
        const mrName = String(file?.filename || "modpack.mrpack").trim() || "modpack.mrpack";
        if (!mrUrl) throw new Error(t.tr("No downloadable mrpack for latest version", "最新版本没有可下载的 mrpack"));

        const tmpRoot = joinRelPath(inst, ".elegantmc_tmp");
        const tmpDir = joinRelPath(tmpRoot, "pack_update");
        const unpackDir = joinRelPath(tmpDir, "mrpack");
        try {
          await callOkCommand("fs_delete", { path: tmpDir }, 30_000);
        } catch {
          // ignore
        }
        await callOkCommand("fs_mkdir", { path: unpackDir }, 30_000);

        const mrpackRel = joinRelPath(tmpDir, "update.mrpack");
        setServerOpStatus(t.tr(`Downloading ${mrName} ...`, `下载中 ${mrName} ...`));
        await callOkCommand("fs_download", { path: mrpackRel, url: mrUrl, instance_id: inst }, 10 * 60_000);

        await callOkCommand("fs_unzip", { zip_path: mrpackRel, dest_dir: unpackDir, instance_id: inst, strip_top_level: true }, 10 * 60_000);

        const idxOut = await callOkCommand("fs_read", { path: joinRelPath(unpackDir, "modrinth.index.json") }, 20_000);
        const idxText = b64DecodeUtf8(String(idxOut?.b64 || ""));
        let index: any = null;
        try {
          index = JSON.parse(idxText);
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

        let loaderKind = "";
        let loaderVer = "";
        if (fabricLoader || quiltLoader) {
          loaderKind = fabricLoader ? "fabric" : "quilt";
          loaderVer = fabricLoader || quiltLoader;
        } else if (neoForge) {
          loaderKind = "neoforge";
          loaderVer = neoForge;
        } else if (forge) {
          loaderKind = "forge";
          loaderVer = forge;
        } else {
          throw new Error("mrpack missing supported loader dependency (fabric-loader/quilt-loader/forge/neoforge)");
        }

        // Apply overrides (best-effort; skip existing to preserve configs).
        const overridesDir = joinRelPath(unpackDir, "overrides");
        try {
          const ls = await callOkCommand("fs_list", { path: overridesDir }, 20_000);
          const entries = Array.isArray(ls?.entries) ? ls.entries : [];
          for (const ent of entries) {
            const name = String(ent?.name || "").trim();
            if (!name || name === "." || name === "..") continue;
            try {
              await callOkCommand("fs_move", { from: joinRelPath(overridesDir, name), to: joinRelPath(inst, name) }, 60_000);
            } catch (e: any) {
              const msg = String(e?.message || e);
              if (/destination exists/i.test(msg)) continue;
              throw e;
            }
          }
        } catch {
          // overrides are optional
        }

        const filesIndex = Array.isArray(index?.files) ? index.files : [];
        const newItems = filesIndex
          .map((f: any) => {
            const envServer = String(f?.env?.server || "").trim().toLowerCase();
            if (envServer === "unsupported") return null;
            const rel = normalizeRelFilePath(String(f?.path || ""));
            if (!rel) return null;
            const downloads = Array.isArray(f?.downloads) ? f.downloads : [];
            const url = String(downloads[0] || "").trim();
            if (!url) throw new Error(t.tr(`mrpack file missing download url: ${rel}`, `mrpack 文件缺少下载链接：${rel}`));
            const sha1 = String(f?.hashes?.sha1 || "").trim();
            return { rel, url, sha1 };
          })
          .filter(Boolean) as { rel: string; url: string; sha1: string }[];

        const oldFiles = Array.isArray(cur?.files) ? cur.files : [];
        const oldByRel = new Map<string, string>();
        for (const f of oldFiles) {
          const rel = String((f as any)?.path || (f as any)?.rel || "").trim();
          const sha1 = String((f as any)?.sha1 || "").trim();
          if (rel) oldByRel.set(rel, sha1);
        }

        const newByRel = new Map<string, string>();
        for (const it of newItems) {
          newByRel.set(it.rel, String(it.sha1 || ""));
        }

        // Remove old mods that no longer exist in the pack (safe subset).
        const toRemove = Array.from(oldByRel.keys()).filter((rel) => rel.startsWith("mods/") && !newByRel.has(rel));
        if (toRemove.length) {
          setServerOpStatus(t.tr(`Removing ${toRemove.length} old mod(s) ...`, `移除旧 mod：${toRemove.length} 个...`));
          for (const rel of toRemove) {
            try {
              await callOkCommand("fs_delete", { path: joinRelPath(inst, rel) }, 60_000);
            } catch {
              // ignore
            }
          }
        }

        const shouldSkipOverwrite = async (rel: string) => {
          if (rel.startsWith("world/") || rel.startsWith("saves/")) return true;
          if (rel.startsWith("config/") || rel.startsWith("defaultconfigs/")) {
            try {
              await callOkCommand("fs_stat", { path: joinRelPath(inst, rel) }, 10_000);
              return true; // exists -> keep user config
            } catch {
              return false; // missing -> safe to write
            }
          }
          return false;
        };

        const queue = newItems.filter((it) => {
          const prev = oldByRel.get(it.rel) || "";
          if (isHex40(prev) && isHex40(it.sha1) && prev.toLowerCase() === it.sha1.toLowerCase()) return false;
          return true;
        });

        const dl: { rel: string; url: string; sha1: string }[] = [];
        for (const it of queue) {
          if (await shouldSkipOverwrite(it.rel)) continue;
          dl.push(it);
        }

        const total = dl.length;
        let done = 0;
        if (total) {
          setInstallProgress({ phase: t.tr("Updating pack files", "更新整合包文件"), currentFile: "", done: 0, total });
          setServerOpStatus(t.tr(`Updating pack files: 0/${total} ...`, `更新整合包文件：0/${total} ...`));
        }
        const work = dl.slice();
        const concurrency = Math.max(1, Math.min(4, total));
        let failed: any = null;
        const workers = Array.from({ length: concurrency }).map(async () => {
          while (work.length && !failed) {
            const item = work.shift();
            if (!item) break;
            try {
              setInstallProgress((p) => (p ? { ...p, currentFile: item.rel } : p));
              await callOkCommand(
                "fs_download",
                { path: joinRelPath(inst, item.rel), url: item.url, ...(isHex40(item.sha1) ? { sha1: item.sha1 } : {}), instance_id: inst },
                10 * 60_000
              );
              done++;
              setInstallProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + 1) } : p));
              if (total) setServerOpStatus(t.tr(`Updating pack files: ${done}/${total} ...`, `更新整合包文件：${done}/${total} ...`));
            } catch (e) {
              failed = e || new Error(t.tr("download failed", "下载失败"));
              throw failed;
            }
          }
        });
        await Promise.all(workers);
        setInstallProgress(null);

        // Update loader server jar if applicable.
        const jarRel = String(cur?.server?.jar_path || jarPath || "server.jar").trim() || "server.jar";
        const jarSafe = normalizeJarPath(inst, jarRel);
        if (loaderKind === "quilt") {
          setServerOpStatus(t.tr(`Updating Quilt server (${mc} / loader ${loaderVer}) ...`, `更新 Quilt 服务端（${mc} / loader ${loaderVer}）...`));
          const r = await apiFetch(`/api/mc/quilt/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`, { cache: "no-store" });
          const j = await r.json().catch(() => null);
          if (!r.ok) throw new Error(j?.error || t.tr("failed to resolve Quilt server jar", "解析 Quilt 服务端 Jar 失败"));
          const serverJarUrl = String(j?.url || "").trim();
          if (!serverJarUrl) throw new Error(t.tr("quilt server jar url missing", "Quilt 服务端 Jar URL 缺失"));
          await callOkCommand("fs_download", { path: joinRelPath(inst, jarSafe), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
        } else if (loaderKind === "fabric") {
          setServerOpStatus(t.tr(`Updating Fabric server (${mc} / loader ${loaderVer}) ...`, `更新 Fabric 服务端（${mc} / loader ${loaderVer}）...`));
          const r = await apiFetch(`/api/mc/fabric/server-jar?mc=${encodeURIComponent(mc)}&loader=${encodeURIComponent(loaderVer)}`, { cache: "no-store" });
          const j = await r.json().catch(() => null);
          if (!r.ok) throw new Error(j?.error || t.tr("failed to resolve Fabric server jar", "解析 Fabric 服务端 Jar 失败"));
          const serverJarUrl = String(j?.url || "").trim();
          if (!serverJarUrl) throw new Error(t.tr("fabric server jar url missing", "Fabric 服务端 Jar URL 缺失"));
          await callOkCommand("fs_download", { path: joinRelPath(inst, jarSafe), url: serverJarUrl, instance_id: inst }, 10 * 60_000);
        } else {
          setServerOpStatus(
            t.tr(
              "Pack files updated. Forge/NeoForge loader updates are not automated yet.",
              "已更新整合包文件。Forge/NeoForge loader 更新暂未自动化。"
            )
          );
        }

        const nextManifest: any = {
          ...cur,
          installed_at_unix: Math.floor(Date.now() / 1000),
          minecraft: { version: mc },
          loader: { kind: loaderKind, version: loaderVer },
          server: { ...(cur?.server || {}), jar_path: jarRel },
          files: newItems.map((it) => ({ path: it.rel, sha1: it.sha1 })),
          mrpack: {
            ...(cur?.mrpack || {}),
            name: String(index?.name || cur?.mrpack?.name || "").trim(),
            summary: String(index?.summary || cur?.mrpack?.summary || "").trim(),
            project_id: String(cur?.mrpack?.project_id || projectId).trim(),
            version_id: String(index?.versionId || latestId).trim(),
          },
          source: {
            ...(cur?.source || {}),
            project_id: projectId,
            version_id: latestId,
            version_number: String(latest?.version_number || "").trim(),
            version_name: String(latest?.name || "").trim(),
            url: mrUrl,
            file_name: mrName,
          },
        };

        await writePackManifest(inst, nextManifest);

        // Best-effort cleanup.
        try {
          await callOkCommand("fs_delete", { path: tmpDir }, 60_000);
        } catch {
          // ignore
        }

        setServerOpStatus(t.tr("Modrinth pack updated", "Modrinth 整合包已更新"));
      } catch (e: any) {
        setServerOpStatus(String(e?.message || e));
      } finally {
        setGameActionBusy(false);
        setInstallProgress(null);
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
      jvmArgsPreset,
      jvmArgsExtra,
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
      setJvmArgsPreset(settingsSnapshot.jvmArgsPreset);
      setJvmArgsExtra(settingsSnapshot.jvmArgsExtra);
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
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = instanceId.trim();
      if (!inst) throw new Error(t.tr("instance_id is required", "instance_id 不能为空"));
      await applyServerPort(inst, gamePort);
      await writeInstanceConfig(inst, {});
      setSettingsOpen(false);
      setSettingsSnapshot(null);
      setServerOpStatus(t.tr("Saved", "已保存"));
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
        setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
        return;
      }

      const portRaw = override?.gamePort ?? gamePort;
      const port = Math.round(Number(portRaw || 25565));

      // Ensure server.properties has the selected port before first start.
      await applyServerPort(inst, port);

      const jar = normalizeJarPath(inst, String(override?.jarPath ?? jarPath));
      const xmsVal = String(override?.xms ?? xms);
      const xmxVal = String(override?.xmx ?? xmx);
      const jvmArgsVal = Array.isArray(override?.jvmArgs) ? override!.jvmArgs : jvmArgsComputed;
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
        jvm_args: jvmArgsVal,
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
            t.tr(
              `Minecraft requires accepting the Mojang EULA.\n\nWrite servers/${inst}/eula.txt with eula=true?`,
              `Minecraft 需要接受 Mojang EULA。\n\n是否写入 servers/${inst}/eula.txt 为 eula=true？`
            ),
            { title: t.tr("Accept EULA", "接受 EULA"), confirmLabel: t.tr("Accept", "接受"), cancelLabel: t.tr("Cancel", "取消") }
          );
          if (!ok) {
            setServerOpStatus(t.tr("Cancelled", "已取消"));
            return;
          }
          setServerOpStatus(t.tr("Writing eula.txt ...", "写入 eula.txt ..."));
          await callOkCommand("fs_write", { path: eulaPath, b64: b64EncodeUtf8("eula=true\n") }, 10_000);
        }
      } catch (e: any) {
        const ok = await confirmDialog(
          t.tr(
            `Minecraft requires accepting the Mojang EULA.\n\nWrite servers/${inst}/eula.txt with eula=true?`,
            `Minecraft 需要接受 Mojang EULA。\n\n是否写入 servers/${inst}/eula.txt 为 eula=true？`
          ),
          { title: t.tr("Accept EULA", "接受 EULA"), confirmLabel: t.tr("Accept", "接受"), cancelLabel: t.tr("Cancel", "取消") }
        );
        if (!ok) {
          setServerOpStatus(t.tr("Cancelled", "已取消"));
          return;
        }
        setServerOpStatus(t.tr("Writing eula.txt ...", "写入 eula.txt ..."));
        await callOkCommand("fs_write", { path: eulaPath, b64: b64EncodeUtf8("eula=true\n") }, 10_000);
      }

      await callOkCommand(
        "mc_start",
        { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms: xmsVal, xmx: xmxVal, jvm_args: jvmArgsVal },
        10 * 60_000
      );
      setServerOpStatus(t.tr("MC started", "MC 已启动"));

      if (enable) {
        const profile = profiles.find((p) => p.id === pid) || null;
        if (!profile) {
          setFrpOpStatus(t.tr("FRP enabled but no profile selected", "已开启 FRP，但未选择服务器"));
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
        setFrpOpStatus(t.tr("FRP started", "FRP 已启动"));
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
        setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
        return;
      }
      try {
        await callOkCommand("frp_stop", { instance_id: inst }, 30_000);
        setFrpOpStatus(t.tr("FRP stopped", "FRP 已停止"));
      } catch {
        // ignore
      }
      await callOkCommand("mc_stop", { instance_id: inst }, 30_000);
      setServerOpStatus(t.tr("MC stopped", "MC 已停止"));
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
	        setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
	        return;
	      }
		      const ok = await confirmDialog(
		        t.tr(
		          `Move server ${id} to trash?\n\nThis will move servers/${id}/ into servers/_trash/.`,
		          `将服务器 ${id} 移入回收站？\n\n这将把 servers/${id}/ 移到 servers/_trash/。`
		        ),
		        {
		          title: t.tr("Move to Trash", "移入回收站"),
		          confirmLabel: t.tr("Continue", "继续"),
		          cancelLabel: t.tr("Cancel", "取消"),
		          danger: true,
		        }
		      );
		      if (!ok) return;

		      const typed = await promptDialog({
		        title: t.tr("Confirm", "确认"),
		        message: t.tr(`Type "${id}" to confirm.`, `输入 “${id}” 以确认。`),
		        placeholder: id,
		        okLabel: t.tr("Move", "移入"),
		        cancelLabel: t.tr("Cancel", "取消"),
		      });
		      if (typed !== id) {
		        setServerOpStatus(t.tr("Cancelled", "已取消"));
		        return;
		      }

		      try {
		        await callOkCommand("frp_stop", { instance_id: id }, 30_000);
		        setFrpOpStatus(t.tr("FRP stopped", "FRP 已停止"));
	      } catch {
        // ignore
      }
	      try {
	        await callOkCommand("mc_stop", { instance_id: id }, 30_000);
	      } catch {
	        // ignore
	      }

	      const out = await callOkCommand("fs_trash", { path: id }, 60_000);
	      const trashId = String(out?.trash_id || "").trim();
	      const trashPath = String(out?.trash_path || "").trim();
	      const daemonId = String(selected || "").trim();
	      if (daemonId && (trashId || trashPath)) {
	        setUndoTrash({
	          daemonId,
	          trashId,
	          trashPath,
	          originalPath: id,
	          message: t.tr(`Moved ${id} to trash`, `已将 ${id} 移入回收站`),
	          expiresAtMs: Date.now() + 9000,
	        });
	      }
	      setServerOpStatus(trashPath ? t.tr(`Moved to trash: ${trashPath}`, `已移入回收站：${trashPath}`) : t.tr("Moved to trash", "已移入回收站"));
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
        setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
        return;
      }
      await applyServerPort(inst, gamePort);
      const jar = normalizeJarPath(inst, jarPath);
      const java = String(javaPath || "").trim();
      await writeInstanceConfig(inst, { jar_path: jar, ...(java ? { java_path: java } : {}), game_port: gamePort });
      await callOkCommand(
        "mc_restart",
        { instance_id: inst, jar_path: jar, ...(java ? { java_path: java } : {}), xms, xmx, jvm_args: jvmArgsComputed },
        10 * 60_000
      );
      setServerOpStatus(t.tr("MC restarted", "MC 已重启"));

      if (enableFrp) {
        const profile = profiles.find((p) => p.id === frpProfileId) || null;
        if (!profile) {
          setFrpOpStatus(t.tr("FRP enabled but no profile selected", "已开启 FRP，但未选择服务器"));
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
        setFrpOpStatus(t.tr("FRP started", "FRP 已启动"));
      }
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function startFrpProxyNow(instanceOverride?: string) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
    setFrpOpStatus("");
    try {
      if (!selectedDaemon?.connected) {
        setFrpOpStatus(t.tr("daemon offline", "daemon 离线"));
        return;
      }
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setFrpOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
        return;
      }

      const profile = profiles.find((p) => p.id === frpProfileId) || null;
      if (!profile) {
        setFrpOpStatus(t.tr("No FRP profile selected", "未选择 FRP 配置"));
        return;
      }

      let token = "";
      try {
        token = profile?.has_token ? await fetchFrpProfileToken(profile.id) : "";
      } catch (e: any) {
        throw new Error(`FRP token: ${String(e?.message || e)}`);
      }

      const port = Math.round(Number(gamePort || 25565));
      const remotePort = Math.round(Number(frpRemotePort ?? 0));

      await callOkCommand(
        "frp_start",
        {
          instance_id: inst,
          server_addr: profile.server_addr,
          server_port: Number(profile.server_port),
          token,
          local_port: port,
          remote_port: Number.isFinite(remotePort) ? remotePort : 0,
        },
        30_000
      );
      setFrpOpStatus(t.tr("FRP started", "FRP 已启动"));
    } catch (e: any) {
      setFrpOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function repairInstance(instanceOverride?: string) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
    setServerOpStatus("");
    try {
      if (!selectedDaemon?.connected) {
        setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
        return;
      }

      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) {
        setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
        return;
      }

      setServerOpStatus(t.tr("Repairing...", "修复中..."));

      // 1) Detect jar.
      const detected = await callOkCommand("mc_detect_jar", { instance_id: inst }, 30_000);
      const best = String(detected?.best || "").trim();
      if (!best) {
        setServerOpStatus(t.tr("No .jar files found under this instance", "该实例下未找到 .jar 文件"));
        return;
      }
      setJarPath(best);

      // 2) Ensure server.properties has the selected port (creates the file if missing).
      await applyServerPort(inst, gamePort);

      // 3) Best-effort EULA check (optional).
      const eulaPath = joinRelPath(inst, "eula.txt");
      try {
        const out = await callOkCommand("fs_read", { path: eulaPath }, 10_000);
        const text = b64DecodeUtf8(String(out?.b64 || ""));
        const v = String(getPropValue(text, "eula") || "").trim().toLowerCase();
        if (v !== "true") {
          const ok = await confirmDialog(
            t.tr(
              `Minecraft requires accepting the Mojang EULA.\n\nWrite servers/${inst}/eula.txt with eula=true?`,
              `Minecraft 需要接受 Mojang EULA。\n\n是否写入 servers/${inst}/eula.txt 为 eula=true？`
            ),
            { title: t.tr("Accept EULA", "接受 EULA"), confirmLabel: t.tr("Accept", "接受"), cancelLabel: t.tr("Skip", "跳过") }
          );
          if (ok) {
            await callOkCommand("fs_write", { path: eulaPath, b64: b64EncodeUtf8("eula=true\n") }, 10_000);
          }
        }
      } catch {
        // ignore if not present
      }

      // 4) Persist config (jar + port + memory + frp desired state).
      await writeInstanceConfig(inst, { jar_path: best, game_port: gamePort });

      let requiredMajor: number | null = null;
      try {
        const res = await callOkCommand("mc_required_java", { instance_id: inst, jar_path: best }, 30_000);
        const n = Math.round(Number(res?.required_java_major || 0));
        requiredMajor = Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        requiredMajor = null;
      }

      const msg = requiredMajor
        ? t.tr(`Repair done (jar=${best}, Java>=${requiredMajor})`, `修复完成（jar=${best}，Java>=${requiredMajor}）`)
        : t.tr(`Repair done (jar=${best})`, `修复完成（jar=${best}）`);
      setServerOpStatus(msg);
    } catch (e: any) {
      setServerOpStatus(String(e?.message || e));
    } finally {
      setGameActionBusy(false);
    }
  }

  async function renameInstance() {
    if (gameActionBusy) return;
    if (!selectedDaemon?.connected) {
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const from = instanceId.trim();
    if (!from) {
      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    const next = await promptDialog({
      title: t.tr("Rename Instance", "重命名实例"),
      message: t.tr(
        `Rename ${from} → ?\n\nThis will move its folder under servers/ and may require restarting.`,
        `重命名 ${from} → ?\n\n这会移动 servers/ 下的目录，可能需要重启。`
      ),
      defaultValue: from,
      placeholder: "new-instance-id",
      okLabel: t.tr("Continue", "继续"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (next == null) return;
    const to = String(next || "").trim();
    const err = validateInstanceIDUI(to, t.tr);
    if (err) {
      setServerOpStatus(err);
      return;
    }
    if (to === from) {
      setServerOpStatus(t.tr("No changes", "没有变化"));
      setTimeout(() => setServerOpStatus(""), 700);
      return;
    }

    const ok = await confirmDialog(t.tr(`Rename instance ${from} → ${to}?`, `确认重命名实例 ${from} → ${to}？`), {
      title: t.tr("Rename Instance", "重命名实例"),
      confirmLabel: t.tr("Rename", "重命名"),
      cancelLabel: t.tr("Cancel", "取消"),
      danger: true,
    });
    if (!ok) return;

    setGameActionBusy(true);
    setServerOpStatus(t.tr(`Renaming ${from} -> ${to} ...`, `重命名中 ${from} -> ${to} ...`));
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
      setServerOpStatus(t.tr("Renamed", "已重命名"));
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
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const from = instanceId.trim();
    if (!from) {
      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    const next = await promptDialog({
      title: t.tr("Clone Instance", "克隆实例"),
      message: t.tr(
        `Clone ${from} → ?\n\nThis will create a backup then restore it into a new instance folder.`,
        `克隆 ${from} → ?\n\n这会先创建备份，然后恢复到新的实例目录。`
      ),
      placeholder: "new-instance-id",
      okLabel: t.tr("Continue", "继续"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (next == null) return;
    const to = String(next || "").trim();
    const err = validateInstanceIDUI(to, t.tr);
    if (err) {
      setServerOpStatus(err);
      return;
    }
    if (to === from) {
      setServerOpStatus(t.tr("Clone target must be different", "克隆目标必须不同"));
      return;
    }

    const ok = await confirmDialog(t.tr(`Clone instance ${from} → ${to}?`, `确认克隆实例 ${from} → ${to}？`), {
      title: t.tr("Clone Instance", "克隆实例"),
      confirmLabel: t.tr("Clone", "克隆"),
      cancelLabel: t.tr("Cancel", "取消"),
      danger: true,
    });
    if (!ok) return;

    setGameActionBusy(true);
    setServerOpStatus(t.tr("Cloning...", "克隆中..."));
    try {
      const backupName = `${from}-clone-${Date.now()}.zip`;
      const backup = await callOkCommand("mc_backup", { instance_id: from, stop: true, backup_name: backupName }, 10 * 60_000);
      const zip = String(backup?.path || "").trim();
      if (!zip) throw new Error(t.tr("backup path missing", "备份路径缺失"));
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
      setInstanceUsageStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const inst = String(instanceOverride ?? instanceId).trim();
    if (!inst) {
      setInstanceUsageStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    setInstanceUsageBusy(true);
    setInstanceUsageBytes(null);
    setInstanceUsageStatus(t.tr("Scanning...", "扫描中..."));
    try {
      // Prefer daemon-side du (cached).
      try {
        const out = await callOkCommand("fs_du", { path: inst, ttl_sec: 60 }, 60_000);
        const bytes = Math.max(0, Number(out?.bytes || 0));
        const entries = Math.max(0, Math.round(Number(out?.entries || 0) || 0));
        const cached = !!out?.cached;
        setInstanceUsageBytes(Number.isFinite(bytes) ? bytes : null);
        setInstanceUsageStatus(
          cached
            ? t.tr(`cached · files=${entries}`, `缓存 · 文件=${entries}`)
            : entries
              ? t.tr(`files=${entries}`, `文件=${entries}`)
              : ""
        );
        return;
      } catch {
        // Fallback for old daemons: DFS list (slow).
      }

      const maxEntries = 25_000;
      let total = 0;
      let scanned = 0;
      const stack: string[] = [inst];

      while (stack.length) {
        const dir = stack.pop()!;
        const out = await callOkCommand("fs_list", { path: dir }, 30_000);
        for (const e of out.entries || []) {
          scanned++;
          if (scanned > maxEntries) throw new Error(t.tr(`too many entries (> ${maxEntries}), abort`, `文件项过多（> ${maxEntries}），已中止`));
          const name = String(e?.name || "").trim();
          if (!name || name === "." || name === "..") continue;
          if (e?.isDir) stack.push(joinRelPath(dir, name));
          else total += Math.max(0, Number(e?.size || 0));
        }
      }

      setInstanceUsageBytes(total);
      setInstanceUsageStatus(t.tr("computed (fallback)", "已计算（fallback）"));
    } catch (e: any) {
      setInstanceUsageBytes(null);
      setInstanceUsageStatus(String(e?.message || e));
    } finally {
      setInstanceUsageBusy(false);
    }
  }

  async function computeNodeInstanceUsage(daemonIdRaw: string, instanceIdRaw: string) {
    const daemonId = String(daemonIdRaw || "").trim();
    const inst = String(instanceIdRaw || "").trim();
    if (!daemonId || !inst) return;
    const key = `${daemonId}:${inst}`;

    const cur = nodeInstanceUsageByKey[key];
    if (cur?.busy) return;

    const now = Math.floor(Date.now() / 1000);
    setNodeInstanceUsageByKey((prev) => ({
      ...(prev || {}),
      [key]: { bytes: null, status: t.tr("Scanning...", "扫描中..."), busy: true, updatedAtUnix: now },
    }));

    try {
      // Prefer daemon-side du (cached).
      try {
        const out = await callOkCommandForDaemon(daemonId, "fs_du", { path: inst, ttl_sec: 60 }, 60_000);
        const bytes = Math.max(0, Number(out?.bytes || 0));
        const entries = Math.max(0, Math.round(Number(out?.entries || 0) || 0));
        const cached = !!out?.cached;
        setNodeInstanceUsageByKey((prev) => ({
          ...(prev || {}),
          [key]: {
            bytes: Number.isFinite(bytes) ? bytes : null,
            status: cached ? t.tr(`cached · files=${entries}`, `缓存 · 文件=${entries}`) : entries ? t.tr(`files=${entries}`, `文件=${entries}`) : "",
            busy: false,
            updatedAtUnix: Math.floor(Date.now() / 1000),
          },
        }));
        return;
      } catch {
        // fallback
      }

      const maxEntries = 25_000;
      let total = 0;
      let scanned = 0;
      const stack: string[] = [inst];

      while (stack.length) {
        const dir = stack.pop()!;
        const out = await callOkCommandForDaemon(daemonId, "fs_list", { path: dir }, 30_000);
        for (const e of out.entries || []) {
          scanned++;
          if (scanned > maxEntries) throw new Error(t.tr(`too many entries (> ${maxEntries}), abort`, `文件项过多（> ${maxEntries}），已中止`));
          const name = String(e?.name || "").trim();
          if (!name || name === "." || name === "..") continue;
          if (e?.isDir) stack.push(joinRelPath(dir, name));
          else total += Math.max(0, Number(e?.size || 0));
        }
      }

      setNodeInstanceUsageByKey((prev) => ({
        ...(prev || {}),
        [key]: { bytes: total, status: t.tr("computed (fallback)", "已计算（fallback）"), busy: false, updatedAtUnix: Math.floor(Date.now() / 1000) },
      }));
    } catch (e: any) {
      setNodeInstanceUsageByKey((prev) => ({
        ...(prev || {}),
        [key]: { bytes: null, status: String(e?.message || e), busy: false, updatedAtUnix: Math.floor(Date.now() / 1000) },
      }));
    }
  }

  async function backupServer(instanceOverride?: string, opts?: any) {
    if (gameActionBusy) return;
    setGameActionBusy(true);
    setServerOpStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = String(instanceOverride ?? instanceId).trim();
      if (!inst) throw new Error(t.tr("instance_id is required", "instance_id 不能为空"));
      const formatRaw = String(opts?.format || "").trim().toLowerCase();
      const format = formatRaw === "zip" ? "zip" : formatRaw === "tar.gz" || formatRaw === "tgz" ? "tar.gz" : "";
      const stop = typeof opts?.stop === "boolean" ? !!opts.stop : true;
      const keepLast = Math.max(0, Math.min(1000, Math.round(Number(opts?.keep_last ?? opts?.keepLast ?? 0) || 0)));
      const comment = String(opts?.comment || "").trim();

      setServerOpStatus(t.tr("Creating backup...", "创建备份中..."));
      const out = await callOkCommand(
        "mc_backup",
        {
          instance_id: inst,
          stop,
          ...(format ? { format } : {}),
          ...(keepLast > 0 ? { keep_last: keepLast } : {}),
          ...(comment ? { comment } : {}),
        },
        10 * 60_000
      );
      const path = String(out?.path || "").trim();
      setServerOpStatus(path ? t.tr(`Backup created: ${path}`, `备份已创建：${path}`) : t.tr("Backup created", "备份已创建"));
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
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    setGameActionBusy(true);
    setServerOpStatus(t.tr("Exporting zip...", "导出 zip 中..."));
    let zipPath = "";
    try {
      const out = await callOkCommand("fs_zip", { path: inst }, 10 * 60_000);
      zipPath = String(out?.zip_path || "").trim();
      if (!zipPath) throw new Error(t.tr("zip_path missing", "zip_path 缺失"));

      const st = await callOkCommand("fs_stat", { path: zipPath }, 10_000);
      const size = Math.max(0, Number(st?.size || 0));
      const max = 200 * 1024 * 1024;
      if (size > max) {
        throw new Error(
          t.tr(
            `Zip too large to download in browser (${fmtBytes(size)} > ${fmtBytes(max)}). File: ${zipPath}`,
            `Zip 过大，无法在浏览器中下载（${fmtBytes(size)} > ${fmtBytes(max)}）。文件：${zipPath}`
          )
        );
      }

      setServerOpStatus(t.tr(`Downloading ${zipPath} ...`, `下载中 ${zipPath} ...`));
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
      pushToast(t.tr(`Exported: ${inst}.zip`, `已导出：${inst}.zip`), "ok");
      setServerOpStatus(t.tr("Exported", "已导出"));
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
    setRestoreStatus(t.tr("Loading backups...", "加载备份中..."));
    try {
      const base = joinRelPath("_backups", id);
      const out = await callOkCommand("fs_list", { path: base }, 30_000);
      const list = (out.entries || [])
        .filter((e: any) => {
          if (e?.isDir || !e?.name) return false;
          const lower = String(e.name).toLowerCase();
          return lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
        })
        .map((e: any) => joinRelPath(base, String(e.name)));
      list.sort((a: string, b: string) => b.localeCompare(a));
      setRestoreCandidates(list);
      setRestoreZipPath(list[0] || "");
      setRestoreStatus(list.length ? "" : t.tr("No backups found", "未找到备份"));
    } catch {
      setRestoreCandidates([]);
      setRestoreZipPath("");
      setRestoreStatus(t.tr("No backups found", "未找到备份"));
    }
  }

  async function refreshBackupZips(instanceOverride?: string) {
    const inst = String(instanceOverride ?? instanceId).trim();
    if (!inst) return;
    await refreshRestoreCandidates(inst);
  }

  async function openRestoreModal() {
    if (!selectedDaemon?.connected) {
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }
    setRestoreCandidates([]);
    setRestoreZipPath("");
    setRestoreStatus("");
    setRestoreOpen(true);
    await refreshBackupZips(inst);
  }

	  async function restoreBackupNow(zipPathOverride?: string) {
	    if (gameActionBusy) return;
	    const inst = instanceId.trim();
	    const zip = String(zipPathOverride ?? restoreZipPath ?? "").trim();
	    if (!inst) {
	      setRestoreStatus(t.tr("instance_id is required", "instance_id 不能为空"));
	      return;
	    }
    if (!zip) {
      setRestoreStatus(t.tr("Select a backup first", "请先选择备份"));
      return;
    }

    const ok = await confirmDialog(
      t.tr(`Restore ${inst} from ${zip}?\n\nThis will OVERWRITE servers/${inst}/`, `从 ${zip} 恢复 ${inst}？\n\n这将覆盖 servers/${inst}/`),
      {
        title: t.tr("Restore Backup", "恢复备份"),
        confirmLabel: t.tr("Continue", "继续"),
        cancelLabel: t.tr("Cancel", "取消"),
        danger: true,
      }
    );
    if (!ok) return;

    const typed = await promptDialog({
      title: t.tr("Confirm Restore", "确认恢复"),
      message: t.tr(`Type "${inst}" to confirm restoring from backup.`, `输入 “${inst}” 以确认从备份恢复。`),
      placeholder: inst,
      defaultValue: "",
      okLabel: t.tr("Restore", "恢复"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (typed !== inst) {
      setRestoreStatus(t.tr("Cancelled", "已取消"));
      return;
    }

    setGameActionBusy(true);
    setRestoreStatus(t.tr("Stopping server...", "停止服务器中..."));
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

      setRestoreStatus(t.tr("Restoring...", "恢复中..."));
      await callOkCommand("mc_restore", { instance_id: inst, zip_path: zip }, 10 * 60_000);
      setRestoreStatus(t.tr(`Restored: ${zip}`, `已恢复：${zip}`));
      setServerOpStatus(t.tr("Restored", "已恢复"));
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
      setTrashStatus(t.tr("daemon offline", "daemon 离线"));
      setTrashItems([]);
      return;
    }
    setTrashStatus(t.tr("Loading trash...", "加载回收站中..."));
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
      setTrashStatus(filtered.length ? "" : t.tr("Trash empty", "回收站为空"));
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

  function openDatapackModal() {
    setDatapackWorld("world");
    setDatapackUrl("");
    setDatapackFile(null);
    setDatapackInputKey((k) => k + 1);
    setDatapackStatus("");
    setDatapackBusy(false);
    setDatapackOpen(true);
  }

  async function installDatapack() {
    if (datapackBusy) return;
    setDatapackBusy(true);
    setDatapackStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = instanceId.trim();
      if (!inst) throw new Error(t.tr("Select a game first", "请先选择游戏实例"));

      const world = String(datapackWorld || "").trim() || "world";
      const worldErr = validateFsNameSegment(world);
      if (worldErr) throw new Error(worldErr);

      const destDir = joinRelPath(inst, joinRelPath(world, "datapacks"));
      await callOkCommand("fs_mkdir", { path: destDir }, 30_000);

      const tmpRoot = joinRelPath(inst, ".elegantmc_tmp");
      const tmpDir = joinRelPath(tmpRoot, "datapacks");
      await callOkCommand("fs_mkdir", { path: tmpDir }, 30_000);
      const zipRel = joinRelPath(tmpDir, `datapack-${Math.floor(Date.now() / 1000)}.zip`);

      const url = String(datapackUrl || "").trim();
      const file = datapackFile;

      if (file) {
        const name = String(file.name || "").toLowerCase();
        if (!name.endsWith(".zip")) throw new Error(t.tr("Only .zip files are supported", "只支持 .zip 文件"));

        const chunkSize = 256 * 1024;
        let uploadID = "";
        setDatapackStatus(t.tr(`Uploading ${file.name} ...`, `上传中 ${file.name} ...`));
        try {
          const begin = await callOkCommand("fs_upload_begin", { path: zipRel }, 30_000);
          uploadID = String(begin.upload_id || "");
          if (!uploadID) throw new Error(t.tr("upload_id missing", "upload_id 缺失"));

          for (let off = 0; off < file.size; off += chunkSize) {
            const end = Math.min(off + chunkSize, file.size);
            const ab = await file.slice(off, end).arrayBuffer();
            const b64 = b64EncodeBytes(new Uint8Array(ab));
            await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 }, 60_000);
            setDatapackStatus(t.tr(`Uploading ${file.name}: ${end}/${file.size} bytes`, `上传中 ${file.name}: ${end}/${file.size} bytes`));
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
      } else if (url) {
        setDatapackStatus(t.tr("Downloading datapack ...", "下载 datapack 中..."));
        await callOkCommand("fs_download", { path: zipRel, url, instance_id: inst }, 10 * 60_000);
      } else {
        throw new Error(t.tr("Choose a zip file or enter a URL", "请选择 zip 文件或填写 URL"));
      }

      setDatapackStatus(t.tr("Extracting...", "解压中..."));
      await callOkCommand("fs_unzip", { zip_path: zipRel, dest_dir: destDir, instance_id: inst, strip_top_level: false }, 10 * 60_000);
      try {
        await callOkCommand("fs_delete", { path: zipRel }, 30_000);
      } catch {
        // ignore
      }
      setDatapackStatus(t.tr(`Installed into ${destDir}`, `已安装到 ${destDir}`));
      setDatapackFile(null);
      setDatapackInputKey((k) => k + 1);
    } catch (e: any) {
      setDatapackStatus(String(e?.message || e));
    } finally {
      setDatapackBusy(false);
    }
  }

  function openResourcePackModal() {
    setResPackUrl("");
    setResPackSha1("");
    setResPackFile(null);
    setResPackInputKey((k) => k + 1);
    setResPackStatus("");
    setResPackBusy(false);
    setResPackOpen(true);
  }

	  async function openJarUpdateModal() {
    if (!selectedDaemon?.connected) {
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus(t.tr("Select a game first", "请先选择游戏实例"));
      return;
    }

	    const kind = installedServerKind !== "unknown" ? installedServerKind : jarUpdateType;
	    setJarUpdateType(kind);
	    if (installedServerVersion) setJarUpdateVersion(installedServerVersion);
	    setJarUpdateBuild(installedServerBuild || 0);
	    setJarUpdateJarName(String(jarPath || "server.jar").trim() || "server.jar");
	    setJarUpdateBackup(true);
    setJarUpdateStatus("");
    setJarUpdateBusy(false);
    setJarUpdateOpen(true);
  }

  async function checkJarUpdateLatest() {
    if (jarUpdateBusy) return;
    setJarUpdateBusy(true);
    setJarUpdateStatus(t.tr("Checking...", "检查中..."));
    try {
      const kind = jarUpdateType;
      const ver = String(jarUpdateVersion || "").trim();
      const build = Math.max(0, Math.round(Number(jarUpdateBuild || 0) || 0));

      if (kind === "paper") {
        const res = await apiFetch(`/api/mc/paper/jar?mc=${encodeURIComponent(ver)}&build=0`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
        const latestBuild = Math.round(Number(json?.build || 0));
        if (Number.isFinite(latestBuild) && latestBuild > 0) {
          setJarUpdateBuild(latestBuild);
          setJarUpdateStatus(build > 0 && latestBuild === build ? t.tr("Already latest build", "已是最新 build") : t.tr(`Latest build: ${latestBuild}`, `最新 build：${latestBuild}`));
        } else {
          setJarUpdateStatus(t.tr("No builds found", "未找到 build"));
        }
        return;
      }

      if (kind === "purpur") {
        const res = await apiFetch(`/api/mc/purpur/jar?mc=${encodeURIComponent(ver)}&build=0`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
        const latestBuild = Math.round(Number(json?.build || 0));
        if (Number.isFinite(latestBuild) && latestBuild > 0) {
          setJarUpdateBuild(latestBuild);
          setJarUpdateStatus(build > 0 && latestBuild === build ? t.tr("Already latest build", "已是最新 build") : t.tr(`Latest build: ${latestBuild}`, `最新 build：${latestBuild}`));
        } else {
          setJarUpdateStatus(t.tr("No builds found", "未找到 build"));
        }
        return;
      }

      // vanilla: prefer the latest release from cached versions list
      const releaseList = (Array.isArray(versions) ? versions : []).filter((v: any) => String(v?.type || "").trim() === "release");
      const latest = releaseList[0] || null;
      const latestID = String(latest?.id || "").trim();
      if (!latestID) {
        setJarUpdateStatus(t.tr("No version list available", "无版本列表"));
        return;
      }
      if (ver && ver === latestID) {
        setJarUpdateStatus(t.tr("Already latest release", "已是最新正式版"));
      } else {
        setJarUpdateVersion(latestID);
        setJarUpdateStatus(t.tr(`Latest release: ${latestID}`, `最新正式版：${latestID}`));
      }
    } catch (e: any) {
      setJarUpdateStatus(String(e?.message || e));
    } finally {
      setJarUpdateBusy(false);
    }
  }

  async function applyJarUpdate() {
    if (jarUpdateBusy || gameActionBusy) return;
    setJarUpdateBusy(true);
    setJarUpdateStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = instanceId.trim();
      if (!inst) throw new Error(t.tr("Select a game first", "请先选择游戏实例"));

      const kind = jarUpdateType;
      const ver = String(jarUpdateVersion || "").trim();
	      const build = Math.max(0, Math.round(Number(jarUpdateBuild || 0) || 0));
	      const jarName = String(jarUpdateJarName || "").trim() || "server.jar";
	      const jarErr = validateJarNameUI(jarName, t.tr);
	      if (jarErr) throw new Error(jarErr);

	      const target = kind === "vanilla" ? `${ver || "-"}` : `${ver || "-"}${build ? ` (build ${build})` : ""}`;
	      const ok = await confirmDialog(
	        t.tr(
	          `Update server jar for ${inst}?\n\nTarget: ${kind} ${target}\nJar: ${jarName}\n\nThis will stop the server and overwrite the jar file.`,
	          `更新 ${inst} 的服务端 Jar？\n\n目标：${kind} ${target}\nJar：${jarName}\n\n这将停止服务器并覆盖 Jar 文件。`
	        ),
	        {
	          title: t.tr("Update Jar", "更新 Jar"),
	          confirmLabel: t.tr("Continue", "继续"),
	          cancelLabel: t.tr("Cancel", "取消"),
	          danger: true,
	        }
	      );
	      if (!ok) return;

	      const typed = await promptDialog({
	        title: t.tr("Confirm", "确认"),
	        message: t.tr(`Type "${inst}" to confirm.`, `输入 “${inst}” 以确认。`),
	        placeholder: inst,
	        okLabel: t.tr("Update", "更新"),
	        cancelLabel: t.tr("Cancel", "取消"),
	      });
	      if (typed !== inst) {
	        setJarUpdateStatus(t.tr("Cancelled", "已取消"));
	        return;
	      }

	      // Stop server (best-effort).
	      setJarUpdateStatus(t.tr("Stopping server...", "停止服务器中..."));
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

      // Backup first (optional).
      if (jarUpdateBackup) {
        const comment = `before jar update: ${kind} ${ver}${build ? ` (build ${build})` : ""}`;
        setJarUpdateStatus(t.tr("Creating backup...", "创建备份中..."));
        await callOkCommand("mc_backup", { instance_id: inst, stop: false, format: "tar.gz", comment }, 10 * 60_000);
      }

      // Install/download jar.
      setJarUpdateStatus(t.tr("Downloading jar...", "下载 jar 中..."));
      let usedBuild = build;
      if (kind === "paper") {
        const res = await apiFetch(`/api/mc/paper/jar?mc=${encodeURIComponent(ver)}&build=${encodeURIComponent(String(build || 0))}`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr("failed to resolve Paper jar", "解析 Paper Jar 失败"));
        const url = String(json?.url || "").trim();
        const sha256 = String(json?.sha256 || "").trim();
        usedBuild = Math.max(0, Math.round(Number(json?.build || 0) || 0)) || build;
        if (!url || !sha256) throw new Error(t.tr("paper jar resolve incomplete", "Paper Jar 解析不完整"));
        await callOkCommand("fs_download", { path: joinRelPath(inst, jarName), url, sha256, instance_id: inst }, 10 * 60_000);
      } else if (kind === "purpur") {
        const res = await apiFetch(`/api/mc/purpur/jar?mc=${encodeURIComponent(ver)}&build=${encodeURIComponent(String(build || 0))}`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t.tr("failed to resolve Purpur jar", "解析 Purpur Jar 失败"));
        const url = String(json?.url || "").trim();
        const sha256 = String(json?.sha256 || "").trim();
        usedBuild = Math.max(0, Math.round(Number(json?.build || 0) || 0)) || build;
        if (!url || !sha256) throw new Error(t.tr("purpur jar resolve incomplete", "Purpur Jar 解析不完整"));
        await callOkCommand("fs_download", { path: joinRelPath(inst, jarName), url, sha256, instance_id: inst }, 10 * 60_000);
      } else {
        await callOkCommand("mc_install_vanilla", { instance_id: inst, version: ver, jar_name: jarName, accept_eula: false }, 10 * 60_000);
      }

      setJarPath(jarName);
      setInstalledServerKind(kind);
      setInstalledServerVersion(ver);
      setInstalledServerBuild(usedBuild);
      await writeInstanceConfig(inst, { jar_path: jarName, server_kind: kind, server_version: ver, server_build: usedBuild });

      setJarUpdateStatus(t.tr("Updated. Start the server to apply.", "已更新。请启动服务器以生效。"));
      setJarUpdateOpen(false);
    } catch (e: any) {
      setJarUpdateStatus(String(e?.message || e));
    } finally {
      setJarUpdateBusy(false);
    }
  }

  async function uploadResourcePackZip() {
    if (resPackBusy) return;
    setResPackBusy(true);
    setResPackStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = instanceId.trim();
      if (!inst) throw new Error(t.tr("Select a game first", "请先选择游戏实例"));
      const file = resPackFile;
      if (!file) throw new Error(t.tr("Select a zip file first", "请先选择 zip 文件"));
      const lower = String(file.name || "").toLowerCase();
      if (!lower.endsWith(".zip")) throw new Error(t.tr("Only .zip files are supported", "只支持 .zip 文件"));
      const name = normalizeDownloadName(String(file.name || "").trim(), "resourcepack.zip");
      const destDir = joinRelPath(inst, "resourcepacks");
      await callOkCommand("fs_mkdir", { path: destDir }, 30_000);
      const destPath = joinRelPath(destDir, name);

      const chunkSize = 256 * 1024;
      let uploadID = "";
      setResPackStatus(t.tr(`Uploading ${name} ...`, `上传中 ${name} ...`));
      try {
        const begin = await callOkCommand("fs_upload_begin", { path: destPath }, 30_000);
        uploadID = String(begin.upload_id || "");
        if (!uploadID) throw new Error(t.tr("upload_id missing", "upload_id 缺失"));
        for (let off = 0; off < file.size; off += chunkSize) {
          const end = Math.min(off + chunkSize, file.size);
          const ab = await file.slice(off, end).arrayBuffer();
          const b64 = b64EncodeBytes(new Uint8Array(ab));
          await callOkCommand("fs_upload_chunk", { upload_id: uploadID, b64 }, 60_000);
          setResPackStatus(t.tr(`Uploading ${name}: ${end}/${file.size} bytes`, `上传中 ${name}: ${end}/${file.size} bytes`));
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

      setResPackStatus(t.tr(`Uploaded: ${destPath}`, `已上传：${destPath}`));
      setResPackFile(null);
      setResPackInputKey((k) => k + 1);
    } catch (e: any) {
      setResPackStatus(String(e?.message || e));
    } finally {
      setResPackBusy(false);
    }
  }

  async function applyResourcePackSettings() {
    if (resPackBusy) return;
    setResPackBusy(true);
    setResPackStatus("");
    try {
      if (!selectedDaemon?.connected) throw new Error(t.tr("daemon offline", "daemon 离线"));
      const inst = instanceId.trim();
      if (!inst) throw new Error(t.tr("Select a game first", "请先选择游戏实例"));

      const url = String(resPackUrl || "").trim();
      const sha1 = String(resPackSha1 || "").trim().toLowerCase();
      if (sha1 && !isHex40(sha1)) throw new Error(t.tr("sha1 must be 40 hex chars", "sha1 必须为 40 位 hex"));

      const path = joinRelPath(inst, "server.properties");
      let cur = "";
      try {
        const out = await callOkCommand("fs_read", { path }, 10_000);
        cur = b64DecodeUtf8(String(out?.b64 || ""));
      } catch {
        cur = "";
      }
      let next = String(cur || "");
      next = upsertProp(next, "resource-pack", url);
      if (sha1) next = upsertProp(next, "resource-pack-sha1", sha1);
      await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(next) }, 10_000);
      setResPackStatus(t.tr("Saved to server.properties", "已写入 server.properties"));
      setTimeout(() => setResPackStatus(""), 1000);
    } catch (e: any) {
      setResPackStatus(String(e?.message || e));
    } finally {
      setResPackBusy(false);
    }
  }

  async function restoreTrashItem(it: any) {
    const trashPath = String(it?.trash_path || "").trim();
    const info = it?.info || {};
    const orig = String(info?.original_path || "").trim();
    if (!trashPath || !orig) return;

    const ok = await confirmDialog(t.tr(`Restore ${orig} from trash?`, `从回收站恢复 ${orig}？`), {
      title: t.tr("Restore", "恢复"),
      confirmLabel: t.tr("Restore", "恢复"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (!ok) return;

    setTrashStatus(t.tr("Restoring...", "恢复中..."));
    try {
      await callOkCommand("fs_trash_restore", { trash_path: trashPath }, 60_000);
      if (!orig.includes("/")) {
        await refreshServerDirs();
        setInstanceId(orig);
      } else {
        await openFileByPath(orig);
        setTab("files");
      }
      setTrashStatus(t.tr("Restored", "已恢复"));
      setTimeout(() => setTrashStatus(""), 900);
      setTrashOpen(false);
      pushToast(t.tr(`Restored: ${orig}`, `已恢复：${orig}`), "ok");
    } catch (e: any) {
      setTrashStatus(String(e?.message || e));
    }
  }

  async function deleteTrashItemForever(it: any) {
    const trashPath = String(it?.trash_path || "").trim();
    const info = it?.info || {};
    const orig = String(info?.original_path || "").trim();
    if (!trashPath) return;

    const ok = await confirmDialog(
      t.tr(
        `Delete permanently from trash?\n\n${orig ? `original: ${orig}\n` : ""}trash: ${trashPath}`,
        `确认从回收站永久删除？\n\n${orig ? `原始路径：${orig}\n` : ""}回收站：${trashPath}`
      ),
      {
        title: t.tr("Delete forever", "永久删除"),
        confirmLabel: t.tr("Delete", "删除"),
        cancelLabel: t.tr("Cancel", "取消"),
        danger: true,
      }
    );
    if (!ok) return;

    const typed = await promptDialog({
      title: t.tr("Confirm Delete", "确认删除"),
      message: t.tr('Type "DELETE" to permanently delete from trash.', "输入 “DELETE” 以确认永久删除回收站内容。"),
      placeholder: "DELETE",
      okLabel: t.tr("Delete", "删除"),
      cancelLabel: t.tr("Cancel", "取消"),
    });
    if (String(typed || "").trim().toUpperCase() !== "DELETE") {
      setTrashStatus(t.tr("Cancelled", "已取消"));
      return;
    }

    setTrashStatus(t.tr("Deleting...", "删除中..."));
    try {
      await callOkCommand("fs_trash_delete", { trash_path: trashPath }, 60_000);
      await refreshTrashItems();
      pushToast(t.tr("Deleted from trash", "已从回收站删除"), "ok");
      setTrashStatus("");
    } catch (e: any) {
      setTrashStatus(String(e?.message || e));
    }
  }

  async function openServerPropertiesEditor() {
    if (!selectedDaemon?.connected) {
      setServerOpStatus(t.tr("daemon offline", "daemon 离线"));
      return;
    }
    const inst = instanceId.trim();
    if (!inst) {
      setServerOpStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }
    const path = joinRelPath(inst, "server.properties");
    setServerPropsOpen(true);
    setServerPropsSaving(false);
    setServerPropsStatus(t.tr("Loading...", "加载中..."));
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
      setServerPropsStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }
    const path = joinRelPath(inst, "server.properties");

    const maxPlayers = Math.max(1, Math.min(1000, Math.round(Number(serverPropsMaxPlayers) || 0)));
    const motd = String(serverPropsMotd || "");

    setServerPropsSaving(true);
    setServerPropsStatus(t.tr("Saving...", "保存中..."));
    try {
      let next = String(serverPropsRaw || "");
      next = upsertProp(next, "motd", motd);
      next = upsertProp(next, "max-players", String(maxPlayers));
      next = upsertProp(next, "online-mode", serverPropsOnlineMode ? "true" : "false");
      next = upsertProp(next, "white-list", serverPropsWhitelist ? "true" : "false");
      await callOkCommand("fs_write", { path, b64: b64EncodeUtf8(next) }, 10_000);
      setServerPropsRaw(next);
      setServerPropsStatus(t.tr("Saved", "已保存"));
      setTimeout(() => setServerPropsStatus(""), 900);
    } catch (e: any) {
      setServerPropsStatus(String(e?.message || e));
    } finally {
      setServerPropsSaving(false);
    }
  }

  async function sendConsoleLine(lineOverride?: string) {
    const line = String(lineOverride ?? consoleLine).trim();
    if (!line) return;
    try {
      await callOkCommand("mc_console", { instance_id: instanceId.trim(), line }, 10_000);
      if (lineOverride == null) setConsoleLine("");
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
      pushToast(t.tr("latest.log not found", "未找到 latest.log"), "error");
      return;
    }

    const max = 25 * 1024 * 1024;
    if (picked.size > max) {
      pushToast(
        t.tr(
          `latest.log too large (${fmtBytes(picked.size)} > ${fmtBytes(max)})`,
          `latest.log 过大（${fmtBytes(picked.size)} > ${fmtBytes(max)}）`
        ),
        "error"
      );
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
      pushToast(t.tr(`Downloaded: latest.${picked.ext}`, `已下载：latest.${picked.ext}`), "ok");
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
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      setNewProfileName("");
      setNewProfileAddr("");
      setNewProfilePort(7000);
      setNewProfileToken("");
      await refreshProfiles();
      setProfilesStatus(t.tr("Saved", "已保存"));
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
      if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
      await refreshProfiles();
    } catch (e: any) {
      setProfilesStatus(String(e?.message || e));
    }
  }

  async function runAdvancedCommand() {
    setError("");
    setCmdResult(null);
    if (!selected) {
      setError(t.tr("Select a daemon first", "请先选择 Daemon"));
      return;
    }
    let argsObj: any = {};
    try {
      argsObj = cmdArgs ? JSON.parse(cmdArgs) : {};
    } catch {
      setError(t.tr("args is not valid JSON", "args 不是合法 JSON"));
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
          title: t.tr("Nodes", "节点"),
          lines:
            locale === "zh"
              ? ["Nodes 是连接到此面板的 daemon。", "创建节点（daemon_id + token），并用这些值启动 daemon。", "在「节点详情」查看 CPU/内存历史与运行中的实例。"]
              : [
                  "Nodes are daemons connected to this panel.",
                  "Create a node (daemon_id + token) and start the daemon with those values.",
                  "Use Node Details for CPU/Mem history and running instances.",
                ],
        };
      case "games":
        return {
          title: t.tr("Games", "游戏"),
          lines:
            locale === "zh"
              ? [
                  "实例位于 servers/<instance_id>。",
                  "设置保存到 servers/<instance_id>/.elegantmc.json。",
                  "用「安装」安装原版/Paper/整合包；排障时查看「安装日志」。",
                ]
              : [
                  "Instances live under servers/<instance_id>.",
                  "Settings are saved to servers/<instance_id>/.elegantmc.json.",
                  "Use Install for Vanilla/Paper/Modpacks; check Install logs when troubleshooting.",
                ],
        };
      case "frp":
        return {
          title: "FRP",
          lines:
            locale === "zh"
              ? ["在这里保存 FRP 服务器配置（地址/端口/token）。", "在游戏设置中启用 FRP，以暴露公网 Socket 地址。"]
              : ["Save FRP server profiles here (addr/port/token).", "Enable FRP in Game Settings to expose a public Socket address."],
        };
      case "files":
        return {
          title: t.tr("Files", "文件"),
          lines:
            locale === "zh"
              ? ["文件访问被限制在 servers/ 目录下。", "误删可用回收站恢复；备份位于 servers/_backups/。"]
              : ["File access is sandboxed to servers/.", "Use Trash to restore accidental deletes; backups live under servers/_backups/."],
        };
      case "panel":
        return {
          title: t.tr("Panel", "面板"),
          lines:
            locale === "zh"
              ? ["全局默认值与 CurseForge API Key 在此配置。", "计划任务会编辑 daemon 的 schedule.json（重启/备份任务）。"]
              : ["Global defaults + CurseForge API key live here.", "Scheduler edits daemon schedule.json (restart/backup tasks)."],
        };
      case "advanced":
        return {
          title: t.tr("Advanced", "高级"),
          lines:
            locale === "zh"
              ? ["执行原始 daemon 命令（有风险）。", "尽量收紧 allowlist；优先使用常规 UI 流程。"]
              : ["Runs raw daemon commands (dangerous).", "Keep allowlists tight; prefer normal UI flows when possible."],
        };
      default:
        return { title: t.tr("Help", "帮助"), lines: [] as string[] };
    }
  }, [tab, locale, t]);

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
      { id: "tab:nodes", title: t.tr("Go: Nodes", "前往：节点"), run: () => goTab("nodes") },
      { id: "tab:games", title: t.tr("Go: Games", "前往：游戏"), run: () => goTab("games") },
      { id: "tab:frp", title: t.tr("Go: FRP", "前往：FRP"), run: () => goTab("frp") },
      { id: "tab:files", title: t.tr("Go: Files", "前往：文件"), run: () => goTab("files") },
      { id: "tab:panel", title: t.tr("Go: Panel", "前往：面板"), run: () => goTab("panel") }
    );
    if (enableAdvanced) out.push({ id: "tab:advanced", title: t.tr("Go: Advanced", "前往：高级"), run: () => goTab("advanced") });

    const inst = instanceId.trim();
    const daemonOk = !!selectedDaemon?.connected;
    const canGame = daemonOk && !!inst && !gameActionBusy;
    const running = !!instanceStatus?.running;

    if (inst) {
      out.push(
        { id: "game:install", title: t.tr("Game: Install…", "游戏：安装…"), disabled: !daemonOk, run: () => (openInstallModal(), close()) },
        { id: "game:settings", title: t.tr("Game: Settings…", "游戏：设置…"), disabled: !canGame, run: () => (openSettingsModal(), close()) },
        {
          id: "game:files",
          title: t.tr("Game: Open instance files", "游戏：打开实例文件"),
          disabled: !daemonOk,
          run: () => {
            setFsPath(inst);
            setTab("files");
            close();
          },
        },
        {
          id: "game:backups",
          title: t.tr("Game: Open backups folder", "游戏：打开备份目录"),
          disabled: !daemonOk,
          run: () => {
            setFsPath(`_backups/${inst}`);
            setTab("files");
            close();
          },
        },
        {
          id: "game:startStop",
          title: running ? t.tr("Game: Stop", "游戏：停止") : t.tr("Game: Start", "游戏：启动"),
          disabled: !canGame,
          run: async () => {
            close();
            if (running) await stopServer(inst);
            else await startServer(inst);
          },
        },
        {
          id: "game:restart",
          title: t.tr("Game: Restart", "游戏：重启"),
          disabled: !canGame,
          run: async () => {
            close();
            await restartServer(inst);
          },
        },
	        {
	          id: "game:backup",
	          title: t.tr("Game: Backup", "游戏：备份"),
	          disabled: !canGame,
	          run: async () => {
	            close();
	            await backupServer(inst);
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
    t,
	    openInstallModal,
	    openSettingsModal,
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
    authMe,
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
    updateInfo,
    updateStatus,
    updateBusy,
    checkUpdates,
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
    exportDiagnosticsBundle,

    // Games
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceTagsById,
    updateInstanceTags,
    favoriteInstanceIds,
    toggleFavoriteInstance,
    instanceNotesById,
    updateInstanceNote,
    instanceId,
	    setInstanceId,
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
    instanceUsageBytes,
    instanceUsageStatus,
    instanceUsageBusy,
    computeInstanceUsage,
    instanceMetricsHistory,
    instanceMetricsStatus,
    backupZips: restoreCandidates,
    backupZipsStatus: restoreStatus,
    refreshBackupZips,
    restoreBackupNow,
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
    fsPreviewUrl,
    openEntry,
    openFileByPath,
	    fsReadText,
      fsWriteText,
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
	    bulkDeleteFsEntries,
	    bulkMoveFsEntries,

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
      promptDialog,
	    makeDeployComposeYml,
	    maskToken,
	    pct,
	    fmtUnix,
	    fmtTime,
	    fmtBytes,
	    joinRelPath,
	    parentRelPath,

      // Game helpers
      startFrpProxyNow,
      repairInstance,
      updateModrinthPack,
	  };

  return (
    <ErrorBoundary>
    <AppCtxProvider value={appCtxValue}>
      {authed !== true ? (
        <div className="modalOverlay">
          <div className="modal" style={{ width: "min(560px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>{t.tr("Admin Login", "管理员登录")}</div>
                <div className="hint">
                  {locale === "zh" ? (
                    <>
                      通过环境变量设置 <code>ELEGANTMC_PANEL_ADMIN_PASSWORD</code>（docker compose：可用 inline env 或 compose 里的{" "}
                      <code>environment:</code>）。如果你没有设置，请查看 Panel 日志获取自动生成的密码（<code>docker compose logs panel</code>）。
                    </>
                  ) : (
                    <>
                      Set <code>ELEGANTMC_PANEL_ADMIN_PASSWORD</code> via environment variables (docker compose: inline env or <code>environment:</code>{" "}
                      in compose). If you did not set it, check Panel logs for the generated password (<code>docker compose logs panel</code>).
                    </>
                  )}
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
                <label>{t.tr("Username", "用户名")}</label>
                <input value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="admin" autoCapitalize="none" autoCorrect="off" />
                <div className="hint">{t.tr("Default: admin", "默认：admin")}</div>
              </div>

              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Password", "密码")}</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  autoFocus
                />
                {loginStatus ? (
                  <div className="hint">{loginStatus}</div>
                ) : authed === null ? (
                  <div className="hint">{t.tr("Checking session...", "检查会话中...")}</div>
                ) : null}
              </div>

              {loginNeeds2fa ? (
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>{t.tr("2FA code / recovery code", "2FA 验证码 / 恢复码")}</label>
                  <input
                    value={loginOtp}
                    onChange={(e) => setLoginOtp(e.target.value)}
                    placeholder={t.tr("123456 or ABCD-EFGH-IJKL-MNOP", "123456 或 ABCD-EFGH-IJKL-MNOP")}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <div className="hint">
                    {t.tr("Enter a 6-digit authenticator code, or a recovery code.", "输入 6 位动态码，或恢复码。")}
                  </div>
                </div>
              ) : null}

              <div className="btnGroup" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
                <button className="primary" type="submit" disabled={!loginUsername.trim() || !loginPassword.trim() || (loginNeeds2fa && !loginOtp.trim())}>
                  {t.tr("Login", "登录")}
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
		              <div style={{ fontWeight: 800 }}>{confirmTitle}</div>
		              <button type="button" onClick={() => closeConfirm(false)}>
		                {t.tr("Close", "关闭")}
		              </button>
		            </div>
		            <div className="modalBody">
		              <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
		                {confirmMessage}
		              </div>
		            </div>
		            <div className="modalFooter">
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
		              <div style={{ fontWeight: 800 }}>{promptTitle}</div>
		              <button type="button" onClick={() => closePrompt(null)}>
		                {t.tr("Close", "关闭")}
		              </button>
		            </div>
		            <form
		              onSubmit={(e) => {
		                e.preventDefault();
		                closePrompt(promptValue);
		              }}
		            >
		              <div className="modalBody">
		                {promptMessage ? (
		                  <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
		                    {promptMessage}
		                  </div>
		                ) : null}
		                <div className="field">
		                  <label>{t.tr("Value", "值")}</label>
		                  <input value={promptValue} onChange={(e) => setPromptValue(e.target.value)} placeholder={promptPlaceholder} autoFocus />
		                </div>
		              </div>
		              <div className="modalFooter">
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
		              <div style={{ fontWeight: 800 }}>{t.tr("Copy", "复制")}</div>
		              <button type="button" onClick={() => setCopyOpen(false)}>
		                {t.tr("Close", "关闭")}
		              </button>
		            </div>
		            <div className="modalBody">
		              <div className="hint">{t.tr("Clipboard API is unavailable. Copy the content below manually.", "Clipboard API 不可用，请手动复制下面内容。")}</div>
		              <textarea readOnly value={copyValue} rows={6} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
		            </div>
		            <div className="modalFooter">
		              <button
		                type="button"
		                className="primary"
		                onClick={async () => {
	                  try {
	                    await navigator.clipboard.writeText(copyValue);
	                    setServerOpStatus(t.tr("Copied", "已复制"));
	                    setCopyOpen(false);
	                  } catch {
	                    // ignore
	                  }
		                }}
		              >
		                {t.tr("Try Copy", "尝试复制")}
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
	                <div style={{ fontWeight: 800 }}>{t.tr("Command Palette", "命令面板")}</div>
	                <div className="hint">
	                  <code>Ctrl+K</code> {t.tr("(or", "（或")} <code>⌘K</code>) · <code>/</code> {t.tr("opens search", "打开搜索")}
	                </div>
	              </div>
	              <button type="button" onClick={() => setCmdPaletteOpen(false)}>
	                {t.tr("Close", "关闭")}
	              </button>
	            </div>

	            <input
	              ref={cmdPaletteInputRef}
	              value={cmdPaletteQuery}
	              onChange={(e) => {
	                setCmdPaletteQuery(e.target.value);
	                setCmdPaletteIdx(0);
	              }}
	              placeholder={t.tr("Type a command…", "输入命令…")}
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
	                <div className="hint">{t.tr("No matching commands", "没有匹配的命令")}</div>
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
	                <div style={{ fontWeight: 800 }}>{t.tr("Keyboard Shortcuts", "键盘快捷键")}</div>
	                <div className="hint">
	                  {t.tr("Press ", "按下 ")}
	                  <code>?</code>
	                  {t.tr(" to toggle this dialog", " 可开关此对话框")}
	                </div>
	              </div>
	              <button type="button" onClick={() => setShortcutsOpen(false)}>
	                {t.tr("Close", "关闭")}
	              </button>
	            </div>

	            <table>
	              <thead>
	                <tr>
	                  <th style={{ width: 170 }}>{t.tr("Keys", "按键")}</th>
	                  <th>{t.tr("Action", "操作")}</th>
	                </tr>
	              </thead>
	              <tbody>
	                <tr>
	                  <td>
	                    <code>Ctrl+K</code> / <code>⌘K</code>
	                  </td>
	                  <td>{t.tr("Toggle Command Palette", "打开/关闭命令面板")}</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>/</code>
	                  </td>
	                  <td>{t.tr("Open Command Palette", "打开命令面板")}</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>Esc</code>
	                  </td>
	                  <td>{t.tr("Close dialogs / sidebar", "关闭对话框 / 侧边栏")}</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>Enter</code>
	                  </td>
	                  <td>{t.tr("Confirm dialog (when focused outside inputs)", "确认对话框（焦点不在输入框时）")}</td>
	                </tr>
	                <tr>
	                  <td>
	                    <code>↑</code> / <code>↓</code>
	                  </td>
	                  <td>{t.tr("Navigate menus (Select / Command Palette)", "菜单导航（下拉框 / 命令面板）")}</td>
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
	                <div style={{ fontWeight: 800 }}>{t.tr("What's new", "更新日志")}</div>
	                {changelogStatus ? <div className="hint">{changelogStatus}</div> : <div className="hint">{t.tr("Latest changes", "最新变更")}</div>}
	              </div>
	              <button type="button" onClick={() => setChangelogOpen(false)}>
	                {t.tr("Close", "关闭")}
	              </button>
	            </div>
	            {changelogText ? <pre>{changelogText}</pre> : <div className="hint">{changelogStatus || t.tr("No changelog loaded.", "未加载到更新日志。")}</div>}
	          </div>
	        </div>
	      ) : null}

	      {helpOpen ? (
	        <div className="modalOverlay" onClick={() => setHelpOpen(false)}>
	          <div className="modal" style={{ width: "min(980px, 100%)" }} onClick={(e) => e.stopPropagation()}>
	            <div className="modalHeader">
	              <div>
	                <div style={{ fontWeight: 800 }}>{t.tr("Help", "帮助")}</div>
	                <div className="hint">
	                  {t.tr("context", "上下文")}: <code>{helpForTab.title}</code>
	                </div>
	              </div>
	              <button type="button" onClick={() => setHelpOpen(false)}>
	                {t.tr("Close", "关闭")}
	              </button>
	            </div>

	            <div className="grid2" style={{ alignItems: "start" }}>
	              <div style={{ minWidth: 0 }}>
	                <h3>{t.tr("This page", "当前页面")}</h3>
	                {helpForTab.lines.length ? (
	                  <div className="hint">
	                    {helpForTab.lines.map((l, idx) => (
	                      <div key={idx}>{l}</div>
	                    ))}
	                  </div>
	                ) : (
	                  <div className="hint">{t.tr("No help for this page yet.", "此页面暂无帮助信息。")}</div>
	                )}

	                <h3 style={{ marginTop: 12 }}>{t.tr("Docs", "文档")}</h3>
	                <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
	                  <button type="button" className={helpDoc === "readme" ? "primary" : ""} onClick={() => loadHelpDoc("readme")}>
	                    README
	                  </button>
	                  <button type="button" className={helpDoc === "security" ? "primary" : ""} onClick={() => loadHelpDoc("security")}>
	                    {t.tr("Security", "安全")}
	                  </button>
	                  <button
	                    type="button"
	                    className={helpDoc === "panel_readme" ? "primary" : ""}
	                    onClick={() => loadHelpDoc("panel_readme")}
	                  >
	                    Panel
	                  </button>
	                  <button type="button" className={helpDoc === "changelog" ? "primary" : ""} onClick={() => loadHelpDoc("changelog")}>
	                    {t.tr("Changelog", "更新日志")}
	                  </button>
	                </div>
	              </div>

	              <div style={{ minWidth: 0 }}>
	                <h3>{helpDocTitle || t.tr("Doc", "文档")}</h3>
	                {helpDocStatus ? <div className="hint">{helpDocStatus}</div> : null}
	                {helpDocText ? (
	                  <pre style={{ maxHeight: 520, overflow: "auto" }}>{helpDocText}</pre>
	                ) : (
	                  <div className="hint">{t.tr("Select a doc to view.", "请选择要查看的文档。")}</div>
	                )}
	              </div>
	            </div>
	          </div>
	        </div>
	      ) : null}

				      {toasts.length ? (
				        <div className="toastWrap" aria-live="polite" aria-relevant="additions" onMouseEnter={pauseToasts} onMouseLeave={resumeToasts}>
				          {toasts.map((toast) => (
				            <div key={toast.id} className={`toast ${toast.kind}`}>
				              <div className="toastHead">
				                <div className="toastTitle">
				                  {toast.kind === "ok"
				                    ? t.tr("Success", "成功")
				                    : toast.kind === "error"
				                      ? t.tr("Error", "错误")
				                      : t.tr("Notice", "提示")}
				                </div>
				                <button
				                  type="button"
				                  className="iconBtn iconOnly ghost"
				                  aria-label={t.tr("Dismiss", "关闭")}
				                  title={t.tr("Dismiss", "关闭")}
				                  onClick={() => dismissToast(toast.id)}
				                >
				                  ×
				                </button>
				              </div>
				              <div className="toastBody">{toast.message}</div>
				              <div className="toastActions">
				                {toast.detail ? (
				                  <button type="button" className="linkBtn" onClick={() => openCopyModal(toast.detail || "")}>
				                    {t.tr("Copy details", "复制详情")}
				                  </button>
				                ) : null}
				              </div>
				            </div>
				          ))}
				        </div>
				      ) : null}

			      {undoTrash ? (
			        <div className="snackbarWrap" aria-live="polite" aria-relevant="additions">
			          <div className="snackbar">
			            <span className="snackbarMsg">{undoTrash.message}</span>
			            <div className="snackbarActions">
			              <button type="button" className="linkBtn" onClick={undoLastTrash} disabled={undoTrashBusy}>
			                {undoTrashBusy ? t.tr("Restoring...", "恢复中...") : t.tr("Undo", "撤销")}
			              </button>
			              <button
			                type="button"
			                className="iconBtn iconOnly"
			                aria-label={t.tr("Dismiss", "关闭")}
			                title={t.tr("Dismiss", "关闭")}
			                onClick={() => setUndoTrash(null)}
			                disabled={undoTrashBusy}
			              >
			                ×
			              </button>
			            </div>
			          </div>
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
	          {tabs.map((tabItem) => (
	            <button
	              key={tabItem.id}
	              type="button"
	              className={`navItem ${tab === tabItem.id ? "active" : ""}`}
	              onClick={async () => {
	                if (tab === "files" && tabItem.id !== "files" && fsDirty) {
	                  const ok = await confirmDialog(t.tr(`Discard unsaved changes in ${fsSelectedFile}?`, `放弃 ${fsSelectedFile} 的未保存更改？`), {
	                    title: t.tr("Unsaved Changes", "未保存更改"),
	                    confirmLabel: t.tr("Discard", "放弃"),
	                    cancelLabel: t.tr("Cancel", "取消"),
	                    danger: true,
	                  });
	                  if (!ok) return;
	                }
	                setTab(tabItem.id);
	                setSidebarOpen(false);
	              }}
	            >
	              <span>{tabItem.label}</span>
	              {tabItem.id === "games" && instanceStatus?.running ? <span className="badge ok">{t.tr("running", "运行中")}</span> : null}
	              {tabItem.id === "nodes" && nodes.length ? <span className="badge">{nodes.length}</span> : null}
	            </button>
	          ))}
	        </nav>

	        <div className="sidebarFooter">
	          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "nowrap" }}>
	            <span className="muted">{t.tr("Preferences", "偏好")}</span>
	            <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
	              <button type="button" className="linkBtn" onClick={() => setShortcutsOpen(true)}>
	                {t.tr("Shortcuts", "快捷键")}
	              </button>
	              <button type="button" className="linkBtn" onClick={openChangelogModal}>
	                {t.tr("What's new", "更新日志")}
	              </button>
	              <button type="button" className="linkBtn" onClick={openHelpModal}>
	                {t.tr("Help", "帮助")}
	              </button>
	              <button type="button" className="linkBtn" onClick={() => setSidebarFooterCollapsed((v) => !v)}>
	                {sidebarFooterCollapsed ? t.tr("Show", "展开") : t.tr("Hide", "折叠")}
	              </button>
	            </div>
	          </div>
	          {!sidebarFooterCollapsed ? (
	            <>
	              <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
	                <span className="muted">{t.tr("Language", "语言")}</span>
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
	                <span className="muted">{t.tr("Theme", "主题")}</span>
	                <div style={{ width: 170 }}>
	                  <Select
	                    value={themeMode}
	                    onChange={(v) => setThemeMode(v as ThemeMode)}
	                    options={[
	                      { value: "auto", label: t.tr("Auto (System)", "自动（系统）") },
	                      { value: "light", label: t.tr("Light", "浅色") },
	                      { value: "dark", label: t.tr("Dark", "深色") },
	                      { value: "contrast", label: t.tr("High Contrast", "高对比度") },
	                    ]}
	                  />
	                </div>
	              </div>
	            </>
	          ) : null}
	          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
	            <span className={`badge ${authed === true ? "ok" : ""}`}>{authed === true ? t.tr("admin", "管理员") : t.tr("locked", "未登录")}</span>
	            {authed === true ? (
	              <button type="button" onClick={logout}>
	                {t.tr("Logout", "退出")}
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
              title={t.tr("Menu", "菜单")}
              aria-label={t.tr("Menu", "菜单")}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              <Icon name="menu" />
            </button>
            <div className="topbarTitle">
              <div className="pageTitle">{activeTab.label}</div>
              <div className="pageSubtitle">
                {t.tr("daemon", "daemon")}: <code>{selectedDaemon?.id || "-"}</code> ·{" "}
                {selectedDaemon?.connected ? <span>{t.tr("online", "在线")}</span> : <span>{t.tr("offline", "离线")}</span>} · {t.tr("last", "最近")}:{" "}
                {fmtUnix(selectedDaemon?.lastSeenUnix)}
              </div>
            </div>
          </div>

	          <div className="field" style={{ minWidth: 240 }}>
	            <label>{t.tr("Daemon", "节点")}</label>
	            <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "nowrap" }}>
	              <div style={{ flex: 1 }}>
	                <Select
	                  value={selected}
	                  onChange={(v) => setSelected(v)}
	                  disabled={authed !== true}
	                  options={daemons.map((d) => ({
	                    value: d.id,
	                    label: `${d.id} ${d.connected ? t.tr("(online)", "（在线）") : t.tr("(offline)", "（离线）")}`,
	                  }))}
	                />
	              </div>
	              <span
	                className={`statusDot ${selectedDaemon?.connected ? "ok" : ""}`}
	                title={selectedDaemon?.connected ? t.tr("online", "在线") : t.tr("offline", "离线")}
	              />
                {globalBusy ? <span className="busySpinner" title={t.tr("Working…", "处理中…")} aria-hidden="true" /> : null}
	            </div>
	          </div>
	        </div>

        {authed === true && selectedDaemon && !selectedDaemon.connected ? (
          <div className="offlineBanner">
            <b>{t.tr("Daemon offline.", "Daemon 离线。")}</b> {t.tr("last seen", "最后在线")}:
            <code> {fmtUnix(selectedDaemon.lastSeenUnix)}</code>. {t.tr("Actions are disabled until it reconnects.", "在重新连接前，操作已禁用。")}
          </div>
        ) : null}

	        {authed === true && updateInfo && (updateInfo?.panel?.update_available || Number(updateInfo?.daemons?.outdated_count || 0) > 0) ? (
	          <div className="offlineBanner">
	            <b>{t.tr("Update available.", "有可用更新。")}</b>{" "}
            <span className="muted">
              {t.tr("latest", "最新")}: <code>{String(updateInfo?.latest?.version || "-")}</code>
              {updateInfo?.panel?.update_available ? (
                <>
                  {" "}
                  · {t.tr("panel", "面板")}: <code>{String(updateInfo?.panel?.current || "-")}</code> →{" "}
                  <code>{String(updateInfo?.latest?.version || "-")}</code>
                </>
              ) : null}
              {Number(updateInfo?.daemons?.outdated_count || 0) > 0 ? (
                <>
                  {" "}
                  · {t.tr("daemons outdated", "Daemon 过期")}:{" "}
                  <code>{String(updateInfo?.daemons?.outdated_count || 0)}</code>
                </>
              ) : null}
            </span>
            <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="iconBtn" onClick={() => checkUpdates({ force: true })} disabled={updateBusy}>
                <Icon name="refresh" /> {t.tr("Re-check", "重新检查")}
              </button>
              <button type="button" onClick={() => setTab("panel")}>
                {t.tr("Open Panel tab", "打开 Panel 标签")}
              </button>
            </div>
	          </div>
	        ) : null}

	        {authed === true && error && daemons.length && daemonsCacheAtUnix > 0 ? (
	          <div className="offlineBanner">
	            <b>{t.tr("Offline mode.", "离线模式。")}</b> {t.tr("Showing cached state from", "正在显示缓存数据，时间")}:{" "}
	            <code>{fmtUnix(daemonsCacheAtUnix)}</code>.
	          </div>
	        ) : null}

	        <div className="content">
	          {error ? (
	            <div className="card danger">
	              <b>{t.tr("Error:", "错误：")}</b> {error}
            </div>
          ) : null}

          {installOpen ? (
            <div className="modalOverlay" onClick={() => (!installRunning ? setInstallOpen(false) : null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
	                  <div>
	                    <div style={{ fontWeight: 700 }}>{t.tr("Install", "安装")}</div>
	                    <div className="hint">
	                      {t.tr("node", "节点")}: <code>{selectedDaemon?.id || "-"}</code> · {t.tr("instance", "实例")}:
	                      <code> {installForm.instanceId.trim() || "-"}</code>
	                    </div>
	                  </div>
	                  <button type="button" onClick={() => setInstallOpen(false)} disabled={installRunning}>
	                    {t.tr("Close", "关闭")}
	                  </button>
	                </div>

                <div className="row" style={{ marginTop: 6 }}>
                  <span className={`badge ${installStep === 1 ? "ok" : ""}`}>1 {t.tr("Basic", "基础")}</span>
                  <span className={`badge ${installStep === 2 ? "ok" : ""}`}>2 {t.tr("Runtime", "运行时")}</span>
                  <span className={`badge ${installStep === 3 ? "ok" : ""}`}>3 FRP</span>
                </div>

                <div className="grid2" style={{ alignItems: "start", marginTop: 10 }}>
                  {installStep === 1 ? (
                    <>
	                  <div className="field">
	                    <label>{t.tr("Instance ID", "实例 ID")}</label>
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
	                      <div className="hint">
	                        {t.tr("Suggestion: A-Z a-z 0-9 . _ - (max 64)", "建议：A-Z a-z 0-9 . _ -（最长 64）")}
	                      </div>
	                    )}
	                  </div>
			                  <div className="field">
			                    <label>{t.tr("Type", "类型")}</label>
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
				                        { value: "vanilla", label: t.tr("Vanilla", "原版") },
				                        { value: "paper", label: t.tr("Paper", "Paper") },
				                        { value: "purpur", label: t.tr("Purpur", "Purpur") },
				                        { value: "modrinth", label: t.tr("Modrinth (Search)", "Modrinth（搜索）") },
				                        { value: "curseforge", label: t.tr("CurseForge (Search)", "CurseForge（搜索）"), disabled: !curseforgeEnabled },
				                        { value: "zip", label: t.tr("Server Pack ZIP (Upload)", "服务器包 ZIP（上传）") },
				                        { value: "zip_url", label: t.tr("Server Pack ZIP/MRPACK (URL)", "服务器包 ZIP/MRPACK（URL）") },
				                      ]}
			                    />
			                    {installValidation.kindErr ? (
			                      <div className="hint" style={{ color: "var(--danger)" }}>
			                        {installValidation.kindErr}
			                      </div>
			                    ) : (
			                      <div className="hint">
				                        {locale === "zh" ? (
				                          <>
				                            Vanilla/Paper/Purpur：自动下载服务端；Modrinth：支持 Fabric/Quilt/Forge/NeoForge mrpack；CurseForge：需要 API Key；ZIP：用于服务器包（Forge/NeoForge
				                            建议用 server pack zip）
				                          </>
				                        ) : (
				                          <>
				                            Vanilla/Paper/Purpur: download the server automatically. Modrinth: supports Fabric/Quilt/Forge/NeoForge mrpack. CurseForge: requires an API
				                            key. ZIP: for server packs (Forge/NeoForge: use the server pack zip).
				                          </>
				                        )}
				                      </div>
				                    )}
			                  </div>

			                  {installForm.kind === "zip" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>{t.tr("Modpack ZIP / MRPACK", "整合包 ZIP / MRPACK")}</label>
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
		                          {locale === "zh" ? (
		                            <>
		                              支持 <code>.zip</code> / <code>.mrpack</code>：上传到 <code>servers/&lt;instance&gt;/</code> 并自动安装/解压（mrpack 目前只支持
		                              Fabric）
		                            </>
		                          ) : (
		                            <>
		                              Supports <code>.zip</code> / <code>.mrpack</code>: upload to <code>servers/&lt;instance&gt;/</code> and install/extract automatically
		                              (mrpack currently supports Fabric only).
		                            </>
		                          )}
		                        </div>
		                      )}
		                    </div>
			                  ) : installForm.kind === "zip_url" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>{t.tr("Modpack URL", "整合包 URL")}</label>
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
			                            title={t.tr(
			                              "Resolve a CurseForge file page URL to a direct download URL",
			                              "将 CurseForge 文件页面 URL 解析为直链下载 URL"
			                            )}
			                          >
			                            <Icon name="download" />
			                            {t.tr("Resolve", "解析")}
			                          </button>
			                        ) : null}
			                      </div>
			                      <div className="hint">
			                        {locale === "zh" ? (
			                          <>
			                            直接粘贴下载链接（支持 <code>.zip</code> / <code>.mrpack</code>）。如果你只有 CurseForge 文件页面链接（<code>/files/&lt;id&gt;</code>），点 Resolve
			                            自动转换为直链。
			                          </>
			                        ) : (
			                          <>
			                            Paste a direct download URL (supports <code>.zip</code> / <code>.mrpack</code>). If you only have a CurseForge file page URL (
			                            <code>/files/&lt;id&gt;</code>), click Resolve to convert it into a direct download URL.
			                          </>
			                        )}
			                      </div>
			                      {cfResolveStatus ? <div className="hint">{cfResolveStatus}</div> : null}
			                      <div className="field" style={{ marginTop: 10 }}>
			                        <label>{t.tr("Filename (optional)", "文件名（可选）")}</label>
			                        <input
			                          value={installForm.remoteFileName}
			                          onChange={(e) => setInstallForm((f) => ({ ...f, remoteFileName: e.target.value }))}
			                          placeholder="modpack.zip"
			                        />
			                      </div>
			                    </div>
			                  ) : installForm.kind === "modrinth" || installForm.kind === "curseforge" ? (
			                    <div className="field" style={{ gridColumn: "1 / -1" }}>
			                      <label>
			                        {installForm.kind === "modrinth"
			                          ? t.tr("Modrinth Modpacks", "Modrinth 整合包")
			                          : t.tr("CurseForge Modpacks", "CurseForge 整合包")}
			                      </label>
			                      <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
			                        <input
			                          value={marketQuery}
			                          onChange={(e) => setMarketQuery(e.target.value)}
			                          placeholder={t.tr("Search modpacks…", "搜索整合包…")}
			                          style={{ flex: 1, minWidth: 220 }}
			                        />
			                        <button
			                          type="button"
			                          className="iconBtn"
			                          onClick={runMarketSearch}
			                          disabled={!marketQuery.trim() || installRunning || (installForm.kind === "curseforge" && !curseforgeEnabled)}
			                        >
			                          <Icon name="search" />
			                          {t.tr("Search", "搜索")}
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
			                          {t.tr("Clear", "清除")}
			                        </button>
			                      </div>
			                      {marketStatus ? (
			                        <div className="hint">{marketStatus}</div>
			                      ) : installForm.kind === "curseforge" && !curseforgeEnabled ? (
			                        <div className="hint">
			                          {locale === "zh" ? (
			                            <>
			                              CurseForge 搜索需要 API Key（去{" "}
			                              <button className="linkBtn" onClick={() => setTab("panel")}>
			                                Panel
			                              </button>{" "}
			                              配置）。或者改用 <b>Modpack ZIP (URL)</b> 粘贴下载链接。
			                            </>
			                          ) : (
			                            <>
			                              CurseForge search requires an API key (configure it in{" "}
			                              <button className="linkBtn" onClick={() => setTab("panel")}>
			                                Panel
			                              </button>
			                              ). Or use <b>Modpack ZIP (URL)</b> and paste a direct download URL.
			                            </>
			                          )}
			                        </div>
			                      ) : installForm.kind === "curseforge" ? (
			                        <div className="hint">{t.tr("CurseForge is enabled (API key configured).", "CurseForge 已启用（API Key 已配置）。")}</div>
			                      ) : (
			                        <div className="hint">
			                          {t.tr(
			                            "Tip: Modrinth mrpack currently supports Fabric only (it will install the server + download mods automatically).",
			                            "提示：Modrinth mrpack 目前只支持 Fabric（会自动安装服务端 + 下载 mods）。"
			                          )}
			                        </div>
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
			                                <span className="badge">
			                                  {typeof p.downloads === "number"
			                                    ? `${p.downloads} ${t.tr("downloads", "下载")}`
			                                    : `${t.tr("downloads", "下载")} -`}
			                                </span>
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
			                            <span className="badge ok">{t.tr("selected", "已选择")}</span>
			                          </div>

			                          {installForm.kind === "modrinth" ? (
			                            <>
			                              <div className="field" style={{ marginTop: 10 }}>
			                                <label>{t.tr("Version", "版本")}</label>
			                                <Select
			                                  value={marketSelectedVersionId}
			                                  onChange={(v) => pickModrinthVersion(v)}
			                                  disabled={!marketVersions.length}
			                                  options={marketVersions.map((v: any) => ({
			                                    value: String(v.id),
			                                    label: String(v.version_number || v.name || v.id),
			                                  }))}
			                                />
			                                <div className="hint">
			                                  {t.tr(
			                                    "Picking a version selects its primary file (or the first file if none).",
			                                    "选择后会自动选取该版本的 primary file（若无则取第一个文件）"
			                                  )}
			                                </div>
			                              </div>
			                            </>
			                          ) : (
			                            <>
			                              <div className="field" style={{ marginTop: 10 }}>
			                                <label>{t.tr("File", "文件")}</label>
			                                <Select
			                                  value={marketSelectedVersionId}
			                                  onChange={(v) => pickCurseForgeFile(v)}
			                                  disabled={!marketVersions.length}
			                                  options={marketVersions.map((f: any) => ({
			                                    value: String(f.id),
			                                    label: String(f.display_name || f.file_name || f.id),
			                                  }))}
			                                />
			                                <div className="hint">
			                                  {t.tr(
			                                    "After selecting, we will resolve/fetch the download URL and use it for install.",
			                                    "选择后会解析/获取 download url 并用于安装"
			                                  )}
			                                </div>
			                              </div>
			                            </>
			                          )}

			                          {installForm.kind === "modrinth" && marketSelectedVersion ? (
			                            <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
			                              {Array.isArray((marketSelectedVersion as any).game_versions) && (marketSelectedVersion as any).game_versions.length ? (
			                                <span className="badge">
			                                  {t.tr("mc", "mc")}: {(marketSelectedVersion as any).game_versions[0]}
			                                </span>
			                              ) : null}
			                              {Array.isArray((marketSelectedVersion as any).loaders) && (marketSelectedVersion as any).loaders.length ? (
			                                <span className="badge">
			                                  {t.tr("loader", "加载器")}: {(marketSelectedVersion as any).loaders.join(", ")}
			                                </span>
			                              ) : null}
			                              <span className="badge">
			                                {t.tr("files", "文件")}: {Array.isArray((marketSelectedVersion as any).files) ? (marketSelectedVersion as any).files.length : 0}
			                              </span>
			                            </div>
			                          ) : null}

			                          {installValidation.remoteErr ? (
			                            <div className="hint" style={{ color: "var(--danger)" }}>
			                              {installValidation.remoteErr}
			                            </div>
			                          ) : installForm.remoteUrl ? (
			                            <div className="hint" style={{ marginTop: 8 }}>
			                              {t.tr("file", "文件")}: <code>{installForm.remoteFileName || "-"}</code>
			                            </div>
			                          ) : null}
			                        </div>
			                      ) : null}
			                    </div>
			                  ) : (
			                    <>
				                      <div className="field" style={{ gridColumn: installForm.kind === "paper" || installForm.kind === "purpur" ? undefined : "1 / -1" }}>
				                        <label>{t.tr("Version", "版本")}</label>
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
		                        {versionsStatus ? (
		                          <div className="hint">
		                            {t.tr("Version list", "版本列表")}：{versionsStatus}
		                          </div>
		                        ) : (
		                          <div className="hint">{t.tr("You can type any version string.", "可直接手输任意版本号")}</div>
		                        )}
		                      </div>
			                      {installForm.kind === "paper" || installForm.kind === "purpur" ? (
			                        <div className="field">
			                          <label>
			                            {installForm.kind === "paper"
			                              ? t.tr("Paper Build (optional)", "Paper Build（可选）")
			                              : t.tr("Purpur Build (optional)", "Purpur Build（可选）")}
			                          </label>
			                          <input
			                            type="number"
			                            value={Number.isFinite(installForm.paperBuild) ? installForm.paperBuild : 0}
			                            onChange={(e) => setInstallForm((f) => ({ ...f, paperBuild: Number(e.target.value) }))}
			                            placeholder={t.tr("0 (latest)", "0（最新）")}
			                            min={0}
			                          />
			                          <div className="hint">{t.tr("Use 0 to download the latest build.", "填 0 表示下载最新 build")}</div>
			                        </div>
			                      ) : null}
		                    </>
		                  )}

	                  <div className="field">
	                    <label>{t.tr("Memory", "内存")}</label>
	                    <div className="row">
	                      <input
	                        value={installForm.xms}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, xms: e.target.value }))}
	                        placeholder={t.tr("Xms (e.g. 1G)", "Xms（例如 1G）")}
	                      />
	                      <input
	                        value={installForm.xmx}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, xmx: e.target.value }))}
	                        placeholder={t.tr("Xmx (e.g. 2G)", "Xmx（例如 2G）")}
	                      />
	                    </div>
	                  </div>
	                  <div className="field">
	                    <label>{t.tr("Game Port", "游戏端口")}</label>
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
	                      <div className="hint">
	                        {t.tr(
	                          "Written into server.properties as server-port (Docker default mapping: 25565-25600).",
	                          "写入 server.properties 的 server-port（Docker 默认映射 25565-25600）"
	                        )}
	                      </div>
	                    )}
	                  </div>

                    </>
                  ) : null}

                  {installStep === 2 ? (
                    <>
		                  <div className="field">
		                    <label>
		                      {installForm.kind === "zip" || installForm.kind === "zip_url" || installForm.kind === "modrinth" || installForm.kind === "curseforge"
		                        ? t.tr("Jar path (after extract)", "Jar 路径（解压后）")
		                        : t.tr("Jar name", "Jar 文件名")}
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
		                          ? t.tr(
		                            "Jar path relative to the instance directory (can include subfolders), used for one-click Start.",
		                            "相对 instance 目录的 jar 路径（可带子目录），用于一键 Start"
		                          )
		                          : t.tr("Filename only (no path), e.g. server.jar", "只填文件名（不含路径），例如 server.jar")}
		                      </div>
		                    )}
		                  </div>
	                  <div className="field">
	                    <label>{t.tr("Java (optional)", "Java（可选）")}</label>
	                    <input
	                      value={installForm.javaPath}
	                      onChange={(e) => setInstallForm((f) => ({ ...f, javaPath: e.target.value }))}
	                      placeholder="java / /opt/jdk21/bin/java"
	                    />
	                    <div className="hint">{t.tr("Leave blank to let the daemon pick automatically (recommended).", "留空则由 Daemon 自动选择（推荐）")}</div>
	                  </div>
		                  <div className="field">
		                    <label>{t.tr("EULA", "EULA")}</label>
		                    <label className="checkRow">
		                      <input
		                        type="checkbox"
		                        checked={!!installForm.acceptEula}
		                        onChange={(e) => setInstallForm((f) => ({ ...f, acceptEula: e.target.checked }))}
		                      />
		                      {t.tr("Write eula.txt automatically (recommended).", "自动写入 eula.txt（推荐）")}
		                    </label>
		                  </div>

                    </>
                  ) : null}

                  {installStep === 3 ? (
                    <>
	                  <div className="field">
	                    <label>{t.tr("FRP (optional)", "FRP（可选）")}</label>
	                    <label className="checkRow">
	                      <input
	                        type="checkbox"
	                        checked={!!installForm.enableFrp}
	                        onChange={(e) => setInstallForm((f) => ({ ...f, enableFrp: e.target.checked }))}
	                      />
	                      {t.tr("Enable FRP automatically when starting after install.", "安装完成后启动时自动开启 FRP")}
	                    </label>
	                  </div>
	                  <div className="field">
	                    <label>{t.tr("FRP Remote Port", "FRP 远端端口")}</label>
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
	                      <div className="hint">{t.tr("Use 0 for auto (assigned by FRP server policy).", "填 0 表示不指定（由 FRP 服务端策略分配）")}</div>
	                    )}
	                  </div>
	                  <div className="field" style={{ gridColumn: "1 / -1" }}>
	                    <label>{t.tr("FRP Server", "FRP 服务器")}</label>
	                    <Select
	                      value={installForm.frpProfileId}
	                      onChange={(v) => setInstallForm((f) => ({ ...f, frpProfileId: v }))}
	                      disabled={!installForm.enableFrp || !profiles.length}
	                      placeholder={profiles.length ? t.tr("Select FRP server…", "选择 FRP 服务器…") : t.tr("No servers", "暂无服务器")}
	                      options={profiles.map((p) => ({
	                        value: p.id,
	                        label: `${p.name} (${p.server_addr}:${p.server_port})`,
	                      }))}
	                    />
                    {installForm.enableFrp && installValidation.frpProfileErr ? (
                      <div className="hint" style={{ color: "var(--danger)" }}>
                        {installValidation.frpProfileErr}{" "}
                        {locale === "zh" ? (
                          <>
                            （去{" "}
                            <button className="linkBtn" onClick={() => setTab("frp")}>
                              FRP
                            </button>{" "}
                            添加，不会关闭此窗口）
                          </>
                        ) : (
                          <>
                            (add one in{" "}
                            <button className="linkBtn" onClick={() => setTab("frp")}>
                              FRP
                            </button>
                            , this modal will stay open)
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="hint">
                        {locale === "zh" ? (
                          <>
                            没有可用服务器？去{" "}
                            <button className="linkBtn" onClick={() => setTab("frp")}>
                              FRP
                            </button>{" "}
                            添加（不会关闭此窗口）
                          </>
                        ) : (
                          <>
                            No servers yet? Add one in{" "}
                            <button className="linkBtn" onClick={() => setTab("frp")}>
                              FRP
                            </button>{" "}
                            (this modal will stay open).
                          </>
                        )}
                      </div>
                    )}
                  </div>

                    </>
                  ) : null}
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <span className="badge">
                      {t.tr("step", "步骤")} {installStep}/3
                    </span>
                    {installStep > 1 ? (
                      <button type="button" onClick={() => setInstallStep((s) => (Math.max(1, s - 1) as 1 | 2 | 3))} disabled={installRunning}>
                        {t.tr("Back", "上一步")}
                      </button>
                    ) : null}
                    {installStep < 3 ? (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setInstallStep((s) => (Math.min(3, s + 1) as 1 | 2 | 3))}
                        disabled={installRunning || (installStep === 1 ? !installWizardStep1Ok : !installWizardStep2Ok)}
                      >
                        {t.tr("Next", "下一步")}
                      </button>
                    ) : (
                      <>
                        <button
                          className="primary"
                          onClick={() => runInstall(false)}
                          disabled={!selectedDaemon?.connected || installRunning || !installValidation.canInstall}
                        >
                          {t.tr("Install", "安装")}
                        </button>
                        <button
                          className="primary"
                          onClick={() => runInstall(true)}
                          disabled={!selectedDaemon?.connected || installRunning || !installValidation.canInstallAndStart}
                        >
                          {t.tr("Install & Start", "安装并启动")}
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
	                      {t.tr("Reset Logs", "重置日志")}
	                    </button>
	                    {installRunning ? <span className="badge">{t.tr("installing…", "安装中…")}</span> : null}
	                    {serverOpStatus ? <span className="muted">{serverOpStatus}</span> : null}
	                  </div>
	                </div>

                  {installProgress && installProgress.total > 0 ? (
                    <div className="itemCard" style={{ marginTop: 12 }}>
                      <div className="hint">
                        {installProgress.phase} · {installProgress.done}/{installProgress.total}
                      </div>
                      {installProgress.currentFile ? (
                        <div className="hint" style={{ marginTop: 6 }}>
                          <span className="muted">{t.tr("file", "文件")}:</span> <code>{installProgress.currentFile}</code>
                        </div>
                      ) : null}
                      <progress value={installProgress.done} max={installProgress.total} style={{ width: "100%", height: 14, marginTop: 8 }} />
                    </div>
                  ) : null}

	                <h3 style={{ marginTop: 12 }}>{t.tr("Install Logs", "安装日志")}</h3>
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
                    .join("\n") || t.tr("<no install logs>", "<无安装日志>")}
                </pre>
              </div>
            </div>
	          ) : null}

          {datapackOpen ? (
            <div className="modalOverlay" onClick={() => (!datapackBusy ? setDatapackOpen(false) : null)}>
              <div className="modal" style={{ width: "min(820px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>{t.tr("Datapack installer", "Datapack 安装器")}</div>
                    <div className="hint">
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code>
                      {" · "}
                      {t.tr("target", "目标")}: <code>servers/{instanceId.trim() || "instance"}/{datapackWorld || "world"}/datapacks/</code>
                    </div>
                    {datapackStatus ? <div className="hint">{datapackStatus}</div> : null}
                  </div>
                  <button type="button" onClick={() => setDatapackOpen(false)} disabled={datapackBusy}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  <div className="field">
                    <label>{t.tr("World folder", "世界目录")}</label>
                    <input value={datapackWorld} onChange={(e) => setDatapackWorld(e.target.value)} placeholder="world" />
                    <div className="hint">{t.tr("Usually 'world'. Datapacks go to <world>/datapacks/.", "一般是 world。datapack 会安装到 <world>/datapacks/。")}</div>
                  </div>
                  <div className="field">
                    <label>{t.tr("Datapack URL (zip)", "Datapack URL（zip）")}</label>
                    <input value={datapackUrl} onChange={(e) => setDatapackUrl(e.target.value)} placeholder="https://..." />
                    <div className="hint">{t.tr("Optional. If provided, Panel will download and extract it.", "可选。填写后将下载并解压。")}</div>
                  </div>
                </div>

                <div className="field" style={{ marginTop: 10 }}>
                  <label>{t.tr("Or upload a zip", "或上传 zip")}</label>
                  <input
                    key={datapackInputKey}
                    type="file"
                    accept=".zip"
                    onChange={(e) => setDatapackFile(e.target.files?.[0] || null)}
                    disabled={datapackBusy}
                  />
                  <div className="hint">{t.tr("Supports standard datapack zips.", "支持标准 datapack zip。")}</div>
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    {datapackBusy ? <span className="badge">{t.tr("working…", "处理中…")}</span> : null}
                  </div>
                  <button type="button" className="primary" onClick={installDatapack} disabled={datapackBusy || !selectedDaemon?.connected || !instanceId.trim()}>
                    {t.tr("Install", "安装")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {resPackOpen ? (
            <div className="modalOverlay" onClick={() => (!resPackBusy ? setResPackOpen(false) : null)}>
              <div className="modal" style={{ width: "min(920px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>{t.tr("Resource pack helper", "资源包助手")}</div>
                    <div className="hint">
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code>
                    </div>
                    {resPackStatus ? <div className="hint">{resPackStatus}</div> : null}
                  </div>
                  <button type="button" onClick={() => setResPackOpen(false)} disabled={resPackBusy}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="hint">
                  {locale === "zh" ? (
                    <>
                      服务器资源包需要一个可公开访问的 URL。你可以把 zip 放到任意静态文件托管（CDN/GitHub Pages/对象存储等），然后在 <code>server.properties</code> 里设置{" "}
                      <code>resource-pack</code> 与可选的 <code>resource-pack-sha1</code>。
                    </>
                  ) : (
                    <>
                      Server resource packs require a publicly reachable URL. Host the zip on any static hosting (CDN/GitHub Pages/object storage), then set{" "}
                      <code>resource-pack</code> and optionally <code>resource-pack-sha1</code> in <code>server.properties</code>.
                    </>
                  )}
                </div>

                <div className="grid2" style={{ alignItems: "start", marginTop: 12 }}>
                  <div className="field">
                    <label>resource-pack</label>
                    <input value={resPackUrl} onChange={(e) => setResPackUrl(e.target.value)} placeholder="https://..." />
                  </div>
                  <div className="field">
                    <label>resource-pack-sha1 (optional)</label>
                    <input value={resPackSha1} onChange={(e) => setResPackSha1(e.target.value)} placeholder="40-hex sha1" />
                    <div className="hint">{t.tr("If provided, clients can validate the download.", "填写后客户端可校验下载。")}</div>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <button type="button" onClick={openServerPropertiesEditor} disabled={!selectedDaemon?.connected || !instanceId.trim() || resPackBusy}>
                      server.properties…
                    </button>
                  </div>
                  <button type="button" className="primary" onClick={applyResourcePackSettings} disabled={!selectedDaemon?.connected || !instanceId.trim() || resPackBusy}>
                    {t.tr("Save", "保存")}
                  </button>
                </div>

                <h3 style={{ marginTop: 14 }}>{t.tr("Upload (optional)", "上传（可选）")}</h3>
                <div className="hint">
                  {t.tr("This only stores the zip under servers/<instance>/resourcepacks/. You still need external hosting for clients to download.", "这只会把 zip 存到 servers/<instance>/resourcepacks/。客户端仍需要外部可访问 URL。")}
                </div>
                <div className="row" style={{ marginTop: 10, gap: 10, alignItems: "center" }}>
                  <input
                    key={resPackInputKey}
                    type="file"
                    accept=".zip"
                    onChange={(e) => setResPackFile(e.target.files?.[0] || null)}
                    disabled={resPackBusy}
                  />
                  <button type="button" onClick={uploadResourcePackZip} disabled={!resPackFile || resPackBusy || !selectedDaemon?.connected || !instanceId.trim()}>
                    {t.tr("Upload", "上传")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

	          {settingsOpen ? (
	            <div className="modalOverlay" onClick={cancelEditSettings}>
	              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 700 }}>{t.tr("Settings", "设置")}</div>
                    <div className="hint">
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code>
                    </div>
                    <div className="hint">
                      {t.tr("saved", "保存到")}: <code>{joinRelPath(instanceId.trim() || ".", INSTANCE_CONFIG_NAME)}</code>
                    </div>
                  </div>
                  <button type="button" onClick={cancelEditSettings}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <input
                    value={settingsSearch}
                    onChange={(e) => setSettingsSearch(e.target.value)}
                    placeholder={t.tr("Search settings…", "搜索设置…")}
                    style={{ width: 260 }}
                  />
                  {settingsSearch ? (
                    <button type="button" className="iconBtn" onClick={() => setSettingsSearch("")}>
                      {t.tr("Clear", "清除")}
                    </button>
                  ) : null}
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  {showSettingsField("jar path", "jar", "path", "server.jar") ? (
                    <div className="field">
                      <label>{t.tr("Jar path (relative)", "Jar 路径（相对）")}</label>
                      <input value={jarPath} onChange={(e) => setJarPath(e.target.value)} placeholder="server.jar" />
                      {settingsValidation.jarErr ? (
                        <div className="hint" style={{ color: "var(--danger)" }}>
                          {settingsValidation.jarErr}
                        </div>
                      ) : (
                        <div className="hint">
                          {t.tr(
                            "Relative path under servers/<instance>/, e.g. server.jar",
                            "相对路径（在 servers/<instance>/ 下），例如 server.jar"
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {showSettingsField("pick a jar", "jar list", "scan", "refresh") ? (
                    <div className="field">
                      <label>{t.tr("Pick a jar", "选择 Jar")}</label>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Select
                            value=""
                            onChange={(v) => setJarPath(v)}
                            disabled={!jarCandidates.length}
                            placeholder={jarCandidates.length ? t.tr("Select jar…", "选择 Jar…") : jarCandidatesStatus || t.tr("No jars", "暂无 Jar")}
                            options={jarCandidates.map((j) => ({ value: j, label: j }))}
                          />
                        </div>
                        <button
                          type="button"
                          className="iconBtn iconOnly"
                          title={t.tr("Refresh jar list", "刷新 Jar 列表")}
                          aria-label={t.tr("Refresh jar list", "刷新 Jar 列表")}
                          onClick={() => refreshJarCandidates()}
                          disabled={!selectedDaemon?.connected || !instanceId.trim()}
                        >
                          <Icon name="refresh" />
                        </button>
                      </div>
                      <div className="hint">
                        {t.tr(
                          "Recursively scans for .jar under servers/<instance>/ (skips mods/libraries/world, etc).",
                          "递归扫描 servers/<instance>/ 下的 .jar（跳过 mods/libraries/world 等目录）"
                        )}
                      </div>
                    </div>
                  ) : null}
                  {showSettingsField("java", "jre", "temurin") ? (
                    <div className="field">
                      <label>{t.tr("Java (optional)", "Java（可选）")}</label>
                      <input value={javaPath} onChange={(e) => setJavaPath(e.target.value)} placeholder="java / /opt/jdk21/bin/java" />
                      <div className="hint">{t.tr("Leave blank to let the daemon pick automatically (recommended).", "留空则由 Daemon 自动选择（推荐）")}</div>
                    </div>
                  ) : null}
                  {showSettingsField("jvm", "args", "aikar", "gc") ? (
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <label>{t.tr("JVM args", "JVM 参数")}</label>
                      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ width: 260 }}>
                          <Select
                            value={jvmArgsPreset}
                            onChange={(v) => setJvmArgsPreset(normalizeJvmPreset(v))}
                            options={[
                              { value: "default", label: t.tr("Default (none)", "默认（无）") },
                              { value: "conservative", label: t.tr("Conservative", "保守") },
                              { value: "aikar", label: "Aikar" },
                            ]}
                          />
                        </div>
                        <button type="button" className="iconBtn" onClick={() => copyText(jvmArgsComputed.join("\n") || "<empty>")} disabled={!jvmArgsComputed.length}>
                          <Icon name="copy" />
                          {t.tr("Copy", "复制")}
                        </button>
                      </div>
                      <textarea
                        value={jvmArgsExtra}
                        onChange={(e) => setJvmArgsExtra(e.target.value)}
                        placeholder={t.tr("Extra JVM args (one per line). Lines starting with # are ignored.", "额外 JVM 参数（每行一个）。以 # 开头的行会被忽略。")}
                        rows={3}
                        style={{ width: "100%", marginTop: 8 }}
                      />
                      <div className="hint" style={{ marginTop: 6 }}>
                        {t.tr("These args are placed before -jar. Xms/Xmx are added automatically.", "这些参数会放在 -jar 前。Xms/Xmx 会自动追加。")}
                      </div>
                      <div className="hint" style={{ marginTop: 6 }}>
                        {t.tr("Resulting JVM args:", "最终 JVM 参数：")}
                      </div>
                      <pre style={{ marginTop: 6, maxHeight: 160, overflow: "auto" }}>
                        {jvmArgsComputed.length ? jvmArgsComputed.join("\n") : t.tr("<none>", "<无>")}
                      </pre>
                    </div>
                  ) : null}
                  {showSettingsField("memory", "xms", "xmx") ? (
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <label>{t.tr("Memory", "内存")}</label>
                      <div className="row">
                        <input value={xms} onChange={(e) => setXms(e.target.value)} placeholder={t.tr("Xms (e.g. 1G)", "Xms（例如 1G）")} />
                        <input value={xmx} onChange={(e) => setXmx(e.target.value)} placeholder={t.tr("Xmx (e.g. 2G)", "Xmx（例如 2G）")} />
                      </div>
                      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                        {memoryPresets.map((b) => {
                          const label = fmtMemPreset(b);
                          return (
                            <button
                              key={label}
                              type="button"
                              onClick={() => {
                                setXms(label);
                                setXmx(label);
                              }}
                              disabled={!instanceId.trim()}
                            >
                              {label}
                            </button>
                          );
                        })}
                        <button type="button" onClick={() => setXms(String(xmx || "").trim())} disabled={!instanceId.trim() || !String(xmx || "").trim()}>
                          {t.tr("Xms = Xmx", "Xms = Xmx")}
                        </button>
                      </div>
                      <div className="hint" style={{ marginTop: 6 }}>
                        {t.tr("node memory", "节点内存")}: <code>{memoryInfo.totalBytes > 0 ? fmtBytes(memoryInfo.totalBytes) : "-"}</code>
                        {" · "}
                        Xms: <code>{memoryInfo.xmsBytes != null ? fmtBytes(memoryInfo.xmsBytes) : String(xms || "").trim() || "-"}</code>
                        {" · "}
                        Xmx: <code>{memoryInfo.xmxBytes != null ? fmtBytes(memoryInfo.xmxBytes) : String(xmx || "").trim() || "-"}</code>
                      </div>
                      {memoryInfo.warnings.length ? (
                        <div className="hint" style={{ marginTop: 6 }}>
                          {memoryInfo.warnings.map((w, i) => (
                            <div key={i} style={{ color: w.kind === "danger" ? "var(--danger)" : "var(--warn)" }}>
                              {w.text}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {showSettingsField("port", "game port", "25565") ? (
                    <div className="field">
                      <label>{t.tr("Port", "端口")}</label>
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
                        <div className="hint">{t.tr("Written into server.properties after saving (restart required if running).", "保存后会写入 server.properties（运行中需要重启生效）")}</div>
                      )}
                    </div>
                  ) : null}

                  {showSettingsField("frp", "proxy") ? (
                    <div className="field">
                      <label>FRP</label>
                      <label className="checkRow">
                        <input type="checkbox" checked={enableFrp} onChange={(e) => setEnableFrp(e.target.checked)} />
                        {t.tr("Enable automatically on start.", "启动时自动开启")}
                      </label>
                    </div>
                  ) : null}
                  {showSettingsField("frp remote port", "remote port", "25566") ? (
                    <div className="field">
                      <label>{t.tr("FRP Remote Port", "FRP 远端端口")}</label>
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
                        <div className="hint">{t.tr("Use 0 for auto (assigned by FRP server policy).", "填 0 表示不指定（由 FRP 服务端策略分配）")}</div>
                      )}
                    </div>
                  ) : null}
                  {showSettingsField("frp server", "server addr", "server port") ? (
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <label>{t.tr("FRP Server", "FRP 服务器")}</label>
                      <Select
                        value={frpProfileId}
                        onChange={(v) => setFrpProfileId(v)}
                        disabled={!enableFrp || !profiles.length}
                        placeholder={profiles.length ? t.tr("Select FRP server…", "选择 FRP 服务器…") : t.tr("No servers", "暂无服务器")}
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
                    {t.tr("Save", "保存")}
                  </button>
                  <button type="button" onClick={cancelEditSettings}>
                    {t.tr("Cancel", "取消")}
                  </button>
                  {serverOpStatus ? <span className="muted">{serverOpStatus}</span> : null}
                </div>
              </div>
            </div>
	          ) : null}

          {jarUpdateOpen ? (
            <div className="modalOverlay" onClick={() => (!jarUpdateBusy ? setJarUpdateOpen(false) : null)}>
              <div className="modal" style={{ width: "min(760px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>{t.tr("Update server jar", "更新服务端 Jar")}</div>
                    <div className="hint">
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code>
                      {" · "}
                      {t.tr("current", "当前")}: <code>{jarPath || "server.jar"}</code>
                    </div>
                    {jarUpdateStatus ? <div className="hint">{jarUpdateStatus}</div> : null}
                  </div>
                  <button type="button" onClick={() => setJarUpdateOpen(false)} disabled={jarUpdateBusy}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  <div className="field">
                    <label>{t.tr("Server type", "服务端类型")}</label>
                    <Select
                      value={jarUpdateType}
                      onChange={(v) => setJarUpdateType((v as any) === "vanilla" ? "vanilla" : (v as any) === "purpur" ? "purpur" : "paper")}
                      options={[
                        { value: "paper", label: "Paper" },
                        { value: "purpur", label: "Purpur" },
                        { value: "vanilla", label: t.tr("Vanilla", "原版") },
                      ]}
                    />
                    <div className="hint">{t.tr("Used to resolve download URL safely.", "用于安全解析下载 URL。")}</div>
                  </div>

                  <div className="field">
                    <label>{t.tr("Version", "版本")}</label>
                    <input
                      value={jarUpdateVersion}
                      onChange={(e) => setJarUpdateVersion(e.target.value)}
                      placeholder="1.20.1"
                    />
                    <div className="hint">{t.tr("For Vanilla: Minecraft version (e.g. 1.20.1).", "Vanilla：Minecraft 版本（例如 1.20.1）。")}</div>
                  </div>

                  {jarUpdateType === "paper" || jarUpdateType === "purpur" ? (
                    <div className="field">
                      <label>{t.tr("Build (optional)", "Build（可选）")}</label>
                      <input
                        type="number"
                        value={Number.isFinite(jarUpdateBuild) ? jarUpdateBuild : 0}
                        onChange={(e) => setJarUpdateBuild(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                        min={0}
                      />
                      <div className="hint">{t.tr("0 = latest build.", "0 = 最新 build。")}</div>
                    </div>
                  ) : (
                    <div className="field">
                      <label>{t.tr("Build", "Build")}</label>
                      <input value="-" disabled />
                      <div className="hint">{t.tr("Not applicable for Vanilla.", "原版不使用 build。")}</div>
                    </div>
                  )}

                  <div className="field">
                    <label>{t.tr("Jar name", "Jar 文件名")}</label>
                    <input value={jarUpdateJarName} onChange={(e) => setJarUpdateJarName(e.target.value)} placeholder="server.jar" />
                    <div className="hint">
                      {t.tr("Saved as servers/<instance>/", "会保存到 servers/<instance>/ 下：")} <code>{jarUpdateJarName || "server.jar"}</code>
                    </div>
                  </div>

                  <div className="field">
                    <label>{t.tr("Backup before update", "更新前备份")}</label>
                    <label className="checkRow">
                      <input type="checkbox" checked={jarUpdateBackup} onChange={(e) => setJarUpdateBackup(e.target.checked)} />{" "}
                      {t.tr("Create a tar.gz backup before downloading.", "下载前创建 tar.gz 备份。")}
                    </label>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <button type="button" className="iconBtn" onClick={checkJarUpdateLatest} disabled={jarUpdateBusy}>
                      <Icon name="search" />
                      {t.tr("Check latest", "检查最新")}
                    </button>
                    {jarUpdateBusy ? <span className="badge">{t.tr("working…", "处理中…")}</span> : null}
                  </div>
                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                    <button type="button" onClick={() => setJarUpdateOpen(false)} disabled={jarUpdateBusy}>
                      {t.tr("Cancel", "取消")}
                    </button>
                    <button type="button" className="dangerBtn" onClick={applyJarUpdate} disabled={jarUpdateBusy || !instanceId.trim()}>
                      {t.tr("Update", "更新")}
                    </button>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 10 }}>
                  {t.tr(
                    "Tip: use 'Repair…' after updating if the jar path is wrong, then restart.",
                    "提示：更新后如果 jar 路径不对，可用“修复…”自动识别 jar，再重启。"
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {restoreOpen ? (
            <div className="modalOverlay" onClick={() => (!gameActionBusy ? setRestoreOpen(false) : null)}>
              <div className="modal" style={{ width: "min(680px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <div>
                    <div style={{ fontWeight: 800 }}>{t.tr("Restore Backup", "恢复备份")}</div>
                    <div className="hint">
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code> · {t.tr("from", "来源")}: <code>{restoreZipPath || "-"}</code>
                    </div>
                  </div>
                  <button type="button" onClick={() => setRestoreOpen(false)} disabled={gameActionBusy}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="field">
                  <label>{t.tr("Backup archive", "备份文件")}</label>
                  <Select
                    value={restoreZipPath}
                    onChange={(v) => setRestoreZipPath(v)}
                    disabled={!restoreCandidates.length || gameActionBusy}
                    placeholder={restoreCandidates.length ? t.tr("Select backup…", "选择备份…") : t.tr("No backups found", "未找到备份")}
                    options={restoreCandidates.map((p) => ({ value: p, label: p }))}
                  />
                  <div className="hint">
                    {t.tr("backups", "备份目录")}: <code>servers/_backups/{instanceId.trim() || "instance"}/</code>
                  </div>
                  {restoreStatus ? <div className="hint">{restoreStatus}</div> : null}
                </div>

                <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
                  <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                    <button type="button" onClick={() => refreshBackupZips(instanceId.trim())} disabled={gameActionBusy}>
                      {t.tr("Refresh", "刷新")}
                    </button>
                    {gameActionBusy ? <span className="badge">{t.tr("working…", "处理中…")}</span> : null}
                  </div>
                  <button type="button" className="dangerBtn" onClick={() => restoreBackupNow()} disabled={!restoreZipPath || gameActionBusy}>
                    {t.tr("Restore", "恢复")}
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
                    <div style={{ fontWeight: 800 }}>{t.tr("Trash", "回收站")}</div>
                    <div className="hint">
                      {t.tr("location", "位置")}: <code>servers/_trash/</code> ·{" "}
                      {trashShowAll ? t.tr("showing all trashed items", "显示全部回收站内容") : t.tr("showing games only", "仅显示游戏实例")}
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
                      {t.tr("Show all", "显示全部")}
                    </label>
                    <button type="button" onClick={() => refreshTrashItems()} disabled={!selectedDaemon?.connected}>
                      {t.tr("Refresh", "刷新")}
                    </button>
                    <button type="button" onClick={() => setTrashOpen(false)}>
                      {t.tr("Close", "关闭")}
                    </button>
                  </div>
                </div>

                {trashItems.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>{t.tr("Original", "原始路径")}</th>
                        <th>{t.tr("Deleted", "删除时间")}</th>
                        <th>{t.tr("Trash path", "回收站路径")}</th>
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
                                  {t.tr("Restore", "恢复")}
                                </button>
                                <button type="button" className="dangerBtn" onClick={() => deleteTrashItemForever(it)}>
                                  {t.tr("Delete forever", "永久删除")}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="hint">{t.tr("Trash is empty.", "回收站为空。")}</div>
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
                      {t.tr("game", "游戏")}: <code>{instanceId.trim() || "-"}</code> · {t.tr("path", "路径")}:
                      <code> {joinRelPath(instanceId.trim() || ".", "server.properties")}</code>
                    </div>
                    <div className="hint">
                      {t.tr(
                        "Edits common/safe fields only (other lines are preserved as-is).",
                        "只提供安全/常用字段编辑（其余内容保持原样）。"
                      )}
                    </div>
                  </div>
                  <button type="button" onClick={() => setServerPropsOpen(false)} disabled={serverPropsSaving}>
                    {t.tr("Close", "关闭")}
                  </button>
                </div>

                <div className="grid2" style={{ alignItems: "start" }}>
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label>{t.tr("MOTD", "MOTD")}</label>
                    <input value={serverPropsMotd} onChange={(e) => setServerPropsMotd(e.target.value)} placeholder="A Minecraft Server" />
                  </div>
                  <div className="field">
                    <label>{t.tr("Max players", "最大玩家数")}</label>
                    <input
                      type="number"
                      value={Number.isFinite(serverPropsMaxPlayers) ? serverPropsMaxPlayers : 20}
                      onChange={(e) => setServerPropsMaxPlayers(Number(e.target.value))}
                      min={1}
                      max={1000}
                    />
                  </div>
                  <div className="field">
                    <label>{t.tr("Online mode", "在线模式")}</label>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={serverPropsOnlineMode}
                        onChange={(e) => setServerPropsOnlineMode(e.target.checked)}
                      />
                      online-mode
                    </label>
                    <div className="hint">
                      {t.tr(
                        "Turning this off enables offline-mode (unsafe; not recommended for public servers).",
                        "关闭后为离线模式（不安全，不建议公网使用）。"
                      )}
                    </div>
                  </div>
                  <div className="field">
                    <label>{t.tr("Whitelist", "白名单")}</label>
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={serverPropsWhitelist}
                        onChange={(e) => setServerPropsWhitelist(e.target.checked)}
                      />
                      white-list
                    </label>
                    <div className="hint">{t.tr("When enabled, you must add players to the whitelist in-game.", "开启后需要在服务器内添加白名单玩家。")}</div>
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
                      {t.tr("Open in Files", "在文件中打开")}
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
                      {t.tr("Save", "保存")}
                    </button>
                    {serverPropsSaving ? <span className="badge">{t.tr("saving…", "保存中…")}</span> : null}
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
	                <div style={{ fontWeight: 700 }}>{t.tr("Node Details", "节点详情")}</div>
	                <div className="hint">
	                  {t.tr("node", "节点")}: <code>{nodeDetailsId || "-"}</code>
	                </div>
	              </div>
	              <button type="button" onClick={() => setNodeDetailsOpen(false)}>
	                {t.tr("Close", "关闭")}
	              </button>
	            </div>

	            {nodeDetailsNode ? (
	              <>
	                <div className="grid2" style={{ marginBottom: 12 }}>
	                  <div className="card">
                    <h3>{t.tr("Overview", "概览")}</h3>
                    <div className="row">
                      {nodeDetailsNode.connected ? (
                        <span className="badge ok">{t.tr("online", "在线")}</span>
                      ) : (
                        <span className="badge">{t.tr("offline", "离线")}</span>
                      )}
                      <span className="badge">
                        {t.tr("last", "最近")}: {fmtUnix(nodeDetailsNode.lastSeenUnix)}
                      </span>
                    </div>
                    <div className="hint" style={{ marginTop: 8 }}>
                      {nodeDetailsNode.hello?.os ? `${t.tr("os", "系统")}: ${nodeDetailsNode.hello.os}` : ""}
                      {nodeDetailsNode.hello?.arch ? ` · ${t.tr("arch", "架构")}: ${nodeDetailsNode.hello.arch}` : ""}
                    </div>
                    {nodeDetailsNode.hello?.version ? (
                      <div className="hint" style={{ marginTop: 8 }}>
                        {t.tr("version", "版本")}: <code>{String(nodeDetailsNode.hello.version)}</code>{" "}
                        {nodeDetailsUpdate?.outdated ? <span className="badge warn">{t.tr("outdated", "可更新")}</span> : null}
                      </div>
                    ) : null}
                    {nodeDetailsUpdate?.outdated ? (
                      <div className="btnGroup" style={{ marginTop: 8, justifyContent: "flex-start" }}>
                        <button
                          type="button"
                          className="iconBtn"
                          onClick={async () => {
                            const latest = String((updateInfo as any)?.latest?.version || "").trim();
                            const releaseUrl = String((updateInfo as any)?.latest?.url || "").trim();
                            const assets = Array.isArray((updateInfo as any)?.latest?.assets) ? (updateInfo as any).latest.assets : [];
                            const os = String(nodeDetailsNode?.hello?.os || "").trim().toLowerCase();
                            const arch = String(nodeDetailsNode?.hello?.arch || "").trim().toLowerCase();
                            const osAlts = os === "darwin" ? ["darwin", "macos", "osx"] : os ? [os] : [];
                            const archAlts =
                              arch === "amd64"
                                ? ["amd64", "x86_64"]
                                : arch === "arm64"
                                  ? ["arm64", "aarch64"]
                                  : arch
                                    ? [arch]
                                    : [];
                            let daemonAssetUrl = "";
                            for (const a of assets) {
                              const name = String(a?.name || "").toLowerCase();
                              if (!name.includes("daemon")) continue;
                              if (osAlts.length && !osAlts.some((x) => name.includes(x))) continue;
                              if (archAlts.length && !archAlts.some((x) => name.includes(x))) continue;
                              daemonAssetUrl = String(a?.url || "").trim();
                              if (daemonAssetUrl) break;
                            }

                            const lines: string[] = [];
                            if (latest) lines.push(`# Update ElegantMC Daemon to ${latest}`);
                            lines.push(`# Option A (docker compose): docker compose pull daemon && docker compose up -d daemon`);
                            if (daemonAssetUrl) {
                              lines.push(`# Option B (binary):`);
                              lines.push(`curl -fL '${daemonAssetUrl}' -o elegantmc-daemon && chmod +x elegantmc-daemon`);
                            } else if (releaseUrl) {
                              lines.push(`# Release: ${releaseUrl}`);
                            }
                            await copyText(lines.join("\n") + "\n");
                          }}
                        >
                          <Icon name="copy" /> {t.tr("Copy update commands", "复制更新命令")}
                        </button>
                      </div>
                    ) : null}
	                    <div className="hint" style={{ marginTop: 8 }}>
	                      {t.tr("CPU", "CPU")}:{" "}
	                      {typeof nodeDetailsNode.heartbeat?.cpu?.usage_percent === "number"
	                        ? `${nodeDetailsNode.heartbeat.cpu.usage_percent.toFixed(1)}%`
	                        : "-"}
	                      {" · "}
	                      {t.tr("MEM", "内存")}:{" "}
	                      {nodeDetailsNode.heartbeat?.mem?.total_bytes
	                        ? `${pct(nodeDetailsNode.heartbeat.mem.used_bytes, nodeDetailsNode.heartbeat.mem.total_bytes).toFixed(0)}%`
	                        : "-"}
	                      {" · "}
	                      {t.tr("DISK", "磁盘")}:{" "}
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
	                        {t.tr("Connect", "连接地址")}: {nodeDetailsNode.heartbeat.net.preferred_connect_addrs.slice(0, 6).join(", ")}
	                      </div>
	                    ) : null}
	                  </div>

	                  <div className="card">
	                    <h3>{t.tr("Charts", "图表")}</h3>
	                    <div className="row" style={{ justifyContent: "space-between", alignItems: "end", gap: 10, marginBottom: 8 }}>
	                      <div className="field" style={{ minWidth: 180 }}>
	                        <label>{t.tr("Range", "范围")}</label>
	                        <Select
	                          value={String(nodeDetailsRangeSec)}
	                          onChange={(v) => setNodeDetailsRangeSec(Number(v) || 0)}
	                          options={[
	                            { value: String(60), label: t.tr("Last 1m", "最近 1 分钟") },
	                            { value: String(5 * 60), label: t.tr("Last 5m", "最近 5 分钟") },
	                            { value: String(15 * 60), label: t.tr("Last 15m", "最近 15 分钟") },
	                            { value: String(60 * 60), label: t.tr("Last 1h", "最近 1 小时") },
	                            { value: String(0), label: t.tr("All", "全部") },
	                          ]}
	                        />
	                      </div>
	                      <div className="hint" style={{ marginBottom: 4 }}>
	                        {nodeDetailsHistoryMeta.points
	                          ? locale === "zh"
	                            ? `点数: ${nodeDetailsHistoryMeta.points} · ${fmtUnix(nodeDetailsHistoryMeta.fromUnix)} - ${fmtUnix(nodeDetailsHistoryMeta.toUnix)}`
	                            : `points: ${nodeDetailsHistoryMeta.points} · ${fmtUnix(nodeDetailsHistoryMeta.fromUnix)} - ${fmtUnix(nodeDetailsHistoryMeta.toUnix)}`
	                          : t.tr("No history yet", "暂无历史")}
	                      </div>
	                    </div>

	                    <div className="hint">
	                      CPU% · {t.tr("latest", "最新")}:{" "}
	                      {nodeDetailsHistoryMeta.cpuLatest == null ? "-" : `${nodeDetailsHistoryMeta.cpuLatest.toFixed(1)}%`}
	                    </div>
	                    <Sparkline
	                      values={nodeDetailsHistory.map((p: any) => p?.cpu_percent)}
	                      width={520}
	                      height={80}
	                      stroke="rgba(147, 197, 253, 0.95)"
	                    />
	                    <div className="hint" style={{ marginTop: 10 }}>
	                      MEM% · {t.tr("latest", "最新")}: {nodeDetailsHistoryMeta.memLatest == null ? "-" : `${nodeDetailsHistoryMeta.memLatest.toFixed(0)}%`}
	                    </div>
	                    <Sparkline
	                      values={nodeDetailsHistory.map((p: any) => p?.mem_percent)}
	                      width={520}
	                      height={80}
	                      stroke="rgba(34, 197, 94, 0.9)"
	                    />
	                    <div className="hint" style={{ marginTop: 10 }}>
	                      DISK% · {t.tr("latest", "最新")}: {nodeDetailsHistoryMeta.diskLatest == null ? "-" : `${nodeDetailsHistoryMeta.diskLatest.toFixed(0)}%`}
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
	                  <h3>{t.tr("Instances", "实例")}</h3>
	                  <table>
	                    <thead>
	                      <tr>
	                        <th>ID</th>
	                        <th>{t.tr("Status", "状态")}</th>
	                        <th>{t.tr("Size", "大小")}</th>
	                        <th />
	                      </tr>
	                    </thead>
	                    <tbody>
	                      {(nodeDetailsNode.heartbeat?.instances || []).map((i: any) => {
	                        const key = `${nodeDetailsId}:${String(i?.id || "").trim()}`;
	                        const usage = nodeInstanceUsageByKey[key];
	                        const busy = !!usage?.busy;
	                        const bytes = usage?.bytes;
	                        const status = String(usage?.status || "").trim();
	                        return (
	                          <tr key={i.id}>
	                            <td style={{ fontWeight: 650 }}>{i.id}</td>
	                            <td>
	                              {i.running ? (
	                                <span className="badge ok">
	                                  {t.tr(`running (pid ${i.pid || "-"})`, `运行中（pid ${i.pid || "-"}）`)}
	                                </span>
	                              ) : (
	                                <span className="badge">{t.tr("stopped", "已停止")}</span>
	                              )}
	                            </td>
	                            <td>
	                              {busy ? (
	                                <span className="badge">{t.tr("Scanning...", "扫描中...")}</span>
	                              ) : bytes != null ? (
	                                <code title={status || ""}>{fmtBytes(bytes)}</code>
	                              ) : status ? (
	                                <span className="badge warn" title={status}>
	                                  {t.tr("error", "错误")}
	                                </span>
	                              ) : (
	                                <span className="muted">-</span>
	                              )}
	                            </td>
	                            <td style={{ textAlign: "right" }}>
	                              <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
	                                <button
	                                  type="button"
	                                  className="iconBtn"
	                                  onClick={() => computeNodeInstanceUsage(nodeDetailsId, String(i?.id || ""))}
	                                  disabled={!nodeDetailsNode.connected || busy}
	                                >
	                                  <Icon name="search" />
	                                  {t.tr("Scan", "扫描")}
	                                </button>
	                              </div>
	                            </td>
	                          </tr>
	                        );
	                      })}
	                      {!(nodeDetailsNode.heartbeat?.instances || []).length ? (
	                        <tr>
	                          <td colSpan={4} className="muted">
	                            {t.tr("No instances reported yet", "暂无实例上报")}
	                          </td>
	                        </tr>
	                      ) : null}
	                    </tbody>
	                  </table>
	                </div>

	                <div className="card">
	                  <h3>{t.tr("Danger Zone", "危险区")}</h3>
	                  <DangerZone
	                    title={t.tr("Danger Zone", "危险区")}
	                    hint={t.tr(
	                      "Deleting a node removes its token mapping; the daemon will not be able to reconnect until re-added.",
	                      "删除节点会移除 token 映射；daemon 将无法再次连接（除非重新添加）。"
	                    )}
	                  >
	                    <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
	                      <button
	                        type="button"
	                        className="dangerBtn"
	                        onClick={() => deleteNodeNow(nodeDetailsId)}
	                        disabled={!String(nodeDetailsId || "").trim()}
	                      >
	                        {t.tr("Delete node…", "删除节点…")}
	                      </button>
	                    </div>
	                  </DangerZone>
	                </div>
	              </>
	            ) : (
	              <div className="hint">{t.tr("No data", "暂无数据")}</div>
	            )}
	          </div>
        </div>
      ) : null}

      {deployOpen ? (
        <div className="modalOverlay" onClick={() => setDeployOpen(false)}>
          <div className="modal" style={{ width: "min(860px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>{t.tr("Deploy Daemon (docker compose)", "部署 Daemon（docker compose）")}</div>
                <div className="hint">
                  {t.tr("node", "节点")}: <code>{deployNodeId || "-"}</code> ·{" "}
                  {locale === "zh" ? (
                    <>
                      复制/下载后在节点机器上运行 <code>docker compose up -d</code>
                    </>
                  ) : (
                    <>
                      after copying/downloading, run <code>docker compose up -d</code> on the node machine
                    </>
                  )}
                </div>
              </div>
              <button type="button" onClick={() => setDeployOpen(false)}>
                {t.tr("Close", "关闭")}
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Panel WS URL", "Panel WS 地址")}</label>
                <input value={deployPanelWsUrl} onChange={(e) => setDeployPanelWsUrl(e.target.value)} placeholder="wss://panel.example.com/ws/daemon" />
                <div className="hint">{t.tr("Use wss:// for HTTPS panels; use ws:// for HTTP panels.", "如果面板是 HTTPS，请用 wss://；HTTP 则用 ws://")}</div>
              </div>
              <div className="field">
                <label>{t.tr("daemon_id", "daemon_id")}</label>
                <input value={deployNodeId} readOnly />
              </div>
              <div className="field">
                <label>{t.tr("token", "token")}</label>
                <input value={deployToken} readOnly />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("docker-compose.yml", "docker-compose.yml")}</label>
                <textarea readOnly rows={12} value={deployComposeYml} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
                <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="iconBtn" onClick={() => copyText(deployComposeYml)}>
                    <Icon name="copy" />
                    {t.tr("Copy", "复制")}
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
                    {t.tr("Download", "下载")}
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
                <div style={{ fontWeight: 800 }}>{t.tr("Add Node", "添加节点")}</div>
                <div className="hint">
                  {t.tr(
                    "A token will be generated/saved after creation. To rotate a token, delete and recreate the node.",
                    "创建后会生成/保存 token；如需换 token，请先删除再创建。"
                  )}
                </div>
                {nodesStatus ? <div className="hint">{nodesStatus}</div> : null}
              </div>
              <button type="button" onClick={() => setAddNodeOpen(false)}>
                {t.tr("Close", "关闭")}
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>{t.tr("daemon_id", "daemon_id")}</label>
                <input value={newNodeId} onChange={(e) => setNewNodeId(e.target.value)} placeholder="my-node" />
                <div className="hint">{t.tr("Suggestion: A-Z a-z 0-9 . _ - (max 64)", "建议：A-Z a-z 0-9 . _ -（最长 64）")}</div>
              </div>
              <div className="field">
                <label>{t.tr("token (optional)", "token（可选）")}</label>
                <input value={newNodeToken} onChange={(e) => setNewNodeToken(e.target.value)} placeholder={t.tr("leave blank to auto-generate", "留空则自动生成")} />
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
                    if (!res.ok) throw new Error(json?.error || t.tr("failed", "失败"));
                    const node = json.node;
                    setCreatedNode({ id: node.id, token: node.token });
                    setNewNodeId("");
                    setNewNodeToken("");
                    setNodesStatus(t.tr(`Created: ${node.id}`, `已创建：${node.id}`));
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
                {t.tr("Create", "创建")}
              </button>
            </div>

	            {createdNode ? (
	              <div className="card" style={{ marginTop: 12 }}>
	                <h3>{t.tr("Token", "Token")}</h3>
	                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
	                  <code>{createdNode.token}</code>
	                  <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
	                    <button
	                      type="button"
	                      className="iconBtn iconOnly"
	                      title={t.tr("Copy token", "复制 token")}
	                      aria-label={t.tr("Copy token", "复制 token")}
	                      onClick={async () => {
	                        await copyText(createdNode.token);
	                        setNodesStatus(t.tr("Copied", "已复制"));
	                        setTimeout(() => setNodesStatus(""), 800);
	                      }}
	                    >
	                      <Icon name="copy" />
	                    </button>
	                    <button type="button" className="iconBtn" onClick={() => openDeployDaemonModal(createdNode.id, createdNode.token)}>
	                      <Icon name="download" />
	                      {t.tr("Compose", "Compose")}
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
                <div style={{ fontWeight: 800 }}>{t.tr("Add FRP Server", "添加 FRP 服务器")}</div>
                <div className="hint">{t.tr("After saving, you can reuse it in Games with one click.", "保存后可在 Games 一键复用。")}</div>
                {profilesStatus ? <div className="hint">{profilesStatus}</div> : null}
              </div>
              <button type="button" onClick={() => setAddFrpOpen(false)}>
                {t.tr("Close", "关闭")}
              </button>
            </div>

            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>{t.tr("Name", "名称")}</label>
                <input value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="My FRP" />
              </div>
              <div className="field">
                <label>{t.tr("Server Addr", "服务器地址")}</label>
                <input value={newProfileAddr} onChange={(e) => setNewProfileAddr(e.target.value)} placeholder="frp.example.com" />
              </div>
              <div className="field">
                <label>{t.tr("Server Port", "服务器端口")}</label>
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
                <label>{t.tr("Token (optional)", "Token（可选）")}</label>
                <input value={newProfileToken} onChange={(e) => setNewProfileToken(e.target.value)} placeholder="******" />
              </div>
            </div>

            <div className="btnGroup" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="primary" type="button" disabled={!newProfileName.trim() || !newProfileAddr.trim()} onClick={addFrpProfile}>
                {t.tr("Save", "保存")}
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
