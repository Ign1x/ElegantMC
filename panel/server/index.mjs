import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";

import {
  attachConnection,
  createNode,
  createFrpProfile,
  deleteNode,
  deleteFrpProfile,
  ensureReady,
  getOrCreateDaemon,
  getDaemonTokenSync,
  PANEL_DATA_DIR,
  getPanelSettings,
  handleDaemonMessage,
  listFrpProfiles,
  listNodes,
  savePanelSettings,
  sendCommand,
  state,
} from "./state.mjs";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 2_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function text(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function getAuthToken(req) {
  const raw = req.headers["authorization"];
  if (!raw || typeof raw !== "string") return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function parseCookies(req) {
  const raw = req.headers["cookie"];
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  return parts.join("; ");
}

function truthy(v) {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function maskToken(token) {
  const t = String(token ?? "");
  if (!t) return "";
  if (t.length <= 4) return "****";
  const stars = "*".repeat(Math.min(12, Math.max(0, t.length - 4)));
  return `${stars}${t.slice(-4)}`;
}

const host = process.env.ELEGANTMC_PANEL_HOST || "0.0.0.0";
const port = Number(process.env.ELEGANTMC_PANEL_PORT || "3000");

const dev = process.env.NODE_ENV !== "production";
const secureCookie = String(process.env.ELEGANTMC_PANEL_SECURE_COOKIE || "").trim() === "1";
const enableAdvanced = truthy(process.env.ELEGANTMC_ENABLE_ADVANCED);
const enableHSTS = truthy(process.env.ELEGANTMC_PANEL_HSTS);

const SESSION_COOKIE = "elegantmc_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const sessions = new Map(); // token -> { expiresAtUnix }
const SESSIONS_PATH = path.join(PANEL_DATA_DIR, "sessions.json");
let sessionsWriteChain = Promise.resolve();

const AUDIT_LOG_PATH = path.join(PANEL_DATA_DIR, "audit.log");

async function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  try {
    await fs.rename(tmp, filePath);
  } catch {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      // ignore
    }
    await fs.rename(tmp, filePath);
  } finally {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function sanitizeForAudit(v, depth = 0) {
  if (depth > 6) return "[depth]";
  if (v == null) return v;
  if (typeof v === "string") {
    if (v.length > 800) return `${v.slice(0, 800)}…`;
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 80).map((x) => sanitizeForAudit(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    const entries = Object.entries(v).slice(0, 120);
    for (const [k, val] of entries) {
      const key = String(k || "");
      if (/token|password|secret|api[_-]?key|authorization/i.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeForAudit(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

function appendAudit(req, action, detail = {}) {
  try {
    const session = getSession(req);
    const entry = {
      ts_unix: nowUnix(),
      ip: getClientIP(req) || "",
      action: String(action || "").trim(),
      session: session?.token ? maskToken(session.token) : "",
      detail: sanitizeForAudit(detail),
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFile(AUDIT_LOG_PATH, line, { mode: 0o600 }).catch(() => {});
  } catch {
    // ignore
  }
}

function serializeSessions() {
  const out = {};
  for (const [token, s] of sessions.entries()) {
    if (!token || typeof token !== "string") continue;
    const expiresAtUnix = Number(s?.expiresAtUnix || 0);
    if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= 0) continue;
    out[token] = { expiresAtUnix };
  }
  return { updated_at_unix: nowUnix(), sessions: out };
}

function queueSessionsSave() {
  sessionsWriteChain = sessionsWriteChain
    .then(async () => {
      const payload = JSON.stringify(serializeSessions(), null, 2);
      await writeFileAtomic(SESSIONS_PATH, payload);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[panel] sessions save failed:", e?.message || e);
    });
  return sessionsWriteChain;
}

async function loadSessionsFromDisk() {
  try {
    const raw = await fs.readFile(SESSIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const obj = parsed?.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions) ? parsed.sessions : {};
    const now = nowUnix();
    for (const [token, s] of Object.entries(obj)) {
      const expiresAtUnix = Number(s?.expiresAtUnix || 0);
      if (!token || typeof token !== "string") continue;
      if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= now) continue;
      sessions.set(token, { expiresAtUnix });
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load sessions:", e?.message || e);
    }
  }
}

const LOGIN_WINDOW_SEC = 5 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map(); // ip -> { count, resetAtUnix }

let adminPassword = String(process.env.ELEGANTMC_PANEL_ADMIN_PASSWORD || "").trim();
if (!adminPassword) {
  adminPassword = randomBytes(9).toString("base64url");
  // eslint-disable-next-line no-console
  console.log(
    `[panel] generated admin password: ${adminPassword} (set ELEGANTMC_PANEL_ADMIN_PASSWORD to override)`
  );
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getClientIP(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  const ra = req.socket?.remoteAddress;
  return typeof ra === "string" ? ra : "";
}

function checkLoginRateLimit(req, res) {
  const ip = getClientIP(req) || "unknown";
  const now = nowUnix();
  let st = loginAttempts.get(ip);
  if (!st || now >= (st.resetAtUnix || 0)) {
    st = { count: 0, resetAtUnix: now + LOGIN_WINDOW_SEC };
  }
  st.count += 1;
  loginAttempts.set(ip, st);
  if (st.count > LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, (st.resetAtUnix || now) - now);
    res.setHeader("Retry-After", String(retryAfter));
    json(res, 429, { error: "rate limited", retry_after_sec: retryAfter });
    return false;
  }
  return true;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = String(cookies?.[SESSION_COOKIE] || "").trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const now = nowUnix();
  if (session.expiresAtUnix && now > session.expiresAtUnix) {
    sessions.delete(token);
    queueSessionsSave();
    return null;
  }
  return { token, ...session };
}

function requireAdmin(req, res) {
  if (getSession(req)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

function setSecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), midi=(), payment=(), usb=()"
  );
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  if (enableHSTS) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  // Minimal CSP for a Next.js app. Keep dev permissive to avoid breaking HMR.
  const cspParts = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "connect-src 'self' ws: wss:",
  ];
  res.setHeader("Content-Security-Policy", cspParts.join("; "));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(__dirname, "..");
const nextApp = next({ dev, dir: panelDir });
const nextHandle = nextApp.getRequestHandler();

await nextApp.prepare();
await ensureReady();
await loadSessionsFromDisk();

// Periodic GC for expired sessions and rate-limit buckets.
setInterval(() => {
  const now = nowUnix();
  let sessionsChanged = false;
  for (const [token, s] of sessions.entries()) {
    if (s?.expiresAtUnix && now > s.expiresAtUnix) {
      sessions.delete(token);
      sessionsChanged = true;
    }
  }
  for (const [ip, st] of loginAttempts.entries()) {
    if (!st?.resetAtUnix || now >= st.resetAtUnix) loginAttempts.delete(ip);
  }
  if (sessionsChanged) queueSessionsSave();
}, 60_000).unref?.();

let mcVersionsCache = { atUnix: 0, versions: null, error: "" };
async function getMcVersions() {
  const now = nowUnix();
  if (mcVersionsCache.versions && now-mcVersionsCache.atUnix < 600) {
    return mcVersionsCache.versions;
  }

  const base = process.env.ELEGANTMC_MOJANG_META_BASE_URL || "https://piston-meta.mojang.com";
  const url = `${base.replace(/\/+$/, "")}/mc/game/version_manifest_v2.json`;
  const res = await fetch(url, { headers: { "User-Agent": "ElegantMC Panel" } });
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status}`);
  }
  const json = await res.json();
  const versions = Array.isArray(json?.versions)
    ? json.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }))
    : [];
  mcVersionsCache = { atUnix: now, versions, error: "" };
  return versions;
}

async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    return { res, json };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRedirectUrl(startUrl, maxHops = 6) {
  let cur = String(startUrl || "").trim();
  if (!cur) throw new Error("url is required");
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetchWithTimeout(cur, { redirect: "manual", headers: { "User-Agent": "ElegantMC Panel" } }, 12_000);
    try {
      res.body?.cancel?.();
    } catch {
      // ignore
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      continue;
    }
    return cur;
  }
  return cur;
}

function buildCurseForgeCandidates(inputUrl) {
  const u = new URL(String(inputUrl || "").trim());
  const origin = u.origin;
  const path = u.pathname.replace(/\/+$/, "");
  const out = [u.toString()];

  const m = path.match(/^(.*)\/files\/(\d+)$/);
  if (m) {
    out.push(`${origin}${m[1]}/download/${m[2]}`);
    out.push(`${origin}${m[1]}/files/${m[2]}/download`);
  }

  return Array.from(new Set(out));
}

function isAllowedCurseForgeHost(hostname) {
  const h = String(hostname || "").toLowerCase().trim();
  return h === "www.curseforge.com" || h === "curseforge.com" || h === "legacy.curseforge.com";
}

function isLikelyDirectDownloadUrl(urlText) {
  try {
    const u = new URL(String(urlText || "").trim());
    const host = String(u.hostname || "").toLowerCase();
    const p = String(u.pathname || "").toLowerCase();
    if (p.endsWith(".zip") || p.endsWith(".mrpack")) return true;
    if (host.endsWith("forgecdn.net") && p.includes("/files/")) return true;
    return false;
  } catch {
    return false;
  }
}

const MODRINTH_BASE_URL = String(process.env.ELEGANTMC_MODRINTH_BASE_URL || "https://api.modrinth.com").replace(/\/+$/, "");
const CURSEFORGE_BASE_URL = String(process.env.ELEGANTMC_CURSEFORGE_BASE_URL || "https://api.curseforge.com").replace(/\/+$/, "");
const FABRIC_META_BASE_URL = String(process.env.ELEGANTMC_FABRIC_META_BASE_URL || "https://meta.fabricmc.net").replace(/\/+$/, "");
const QUILT_META_BASE_URL = String(process.env.ELEGANTMC_QUILT_META_BASE_URL || "https://meta.quiltmc.org").replace(/\/+$/, "");

function getCurseForgeApiKey() {
  const fromSettings = String(state?.panelSettings?.curseforge_api_key || "").trim();
  if (fromSettings) return fromSettings;
  return String(process.env.ELEGANTMC_CURSEFORGE_API_KEY || "").trim();
}

async function fabricResolveServerJar(minecraftVersion, loaderVersion) {
  const mc = String(minecraftVersion || "").trim();
  const loader = String(loaderVersion || "").trim();
  if (!mc) throw new Error("mc is required");
  if (!loader) throw new Error("loader is required");
  if (mc.length > 64) throw new Error("mc too long");
  if (loader.length > 64) throw new Error("loader too long");

  const installerUrl = `${FABRIC_META_BASE_URL}/v2/versions/installer`;
  const { res, json } = await fetchJsonWithTimeout(installerUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 12_000);
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const list = Array.isArray(json) ? json : [];
  const installer = String(list?.[0]?.version || "").trim();
  if (!installer) throw new Error("no fabric installer versions");

  const jarUrl = `${FABRIC_META_BASE_URL}/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
  return { mc, loader, installer, url: jarUrl };
}

async function quiltResolveServerJar(minecraftVersion, loaderVersion) {
  const mc = String(minecraftVersion || "").trim();
  const loader = String(loaderVersion || "").trim();
  if (!mc) throw new Error("mc is required");
  if (!loader) throw new Error("loader is required");
  if (mc.length > 64) throw new Error("mc too long");
  if (loader.length > 64) throw new Error("loader too long");

  const installerUrl = `${QUILT_META_BASE_URL}/v3/versions/installer`;
  const { res, json } = await fetchJsonWithTimeout(installerUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 12_000);
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const list = Array.isArray(json) ? json : [];
  const installer = String(list?.[0]?.version || "").trim();
  if (!installer) throw new Error("no quilt installer versions");

  const jarUrl = `${QUILT_META_BASE_URL}/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
  return { mc, loader, installer, url: jarUrl };
}

async function modrinthSearchModpacks(query, limit = 12, offset = 0) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  if (q.length > 120) throw new Error("query too long");
  const lim = Math.max(1, Math.min(50, Number(limit || 12)));
  const off = Math.max(0, Math.min(5000, Number(offset || 0)));

  const params = new URLSearchParams();
  params.set("query", q);
  params.set("limit", String(lim));
  params.set("offset", String(off));
  params.set("facets", JSON.stringify([["project_type:modpack"]]));

  const url = `${MODRINTH_BASE_URL}/v2/search?${params.toString()}`;
  const { res, json } = await fetchJsonWithTimeout(url, { headers: { "User-Agent": "ElegantMC Panel" } }, 12_000);
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  return hits.map((h) => ({
    provider: "modrinth",
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon_url: h.icon_url,
    downloads: h.downloads,
    follows: h.follows,
    updated: h.date_modified,
    game_versions: Array.isArray(h.versions) ? h.versions : [],
  }));
}

async function modrinthProjectVersions(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("project_id is required");
  if (id.length > 128) throw new Error("project_id too long");
  const url = `${MODRINTH_BASE_URL}/v2/project/${encodeURIComponent(id)}/version`;
  const { res, json } = await fetchJsonWithTimeout(url, { headers: { "User-Agent": "ElegantMC Panel" } }, 15_000);
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const list = Array.isArray(json) ? json : [];
  return list.slice(0, 60).map((v) => ({
    provider: "modrinth",
    id: v.id,
    name: v.name,
    version_number: v.version_number,
    date_published: v.date_published,
    game_versions: Array.isArray(v.game_versions) ? v.game_versions : [],
    loaders: Array.isArray(v.loaders) ? v.loaders : [],
    files: Array.isArray(v.files)
      ? v.files.map((f) => ({
          filename: f.filename,
          size: f.size,
          primary: !!f.primary,
          url: f.url,
          hashes: f.hashes || {},
        }))
      : [],
  }));
}

async function curseforgeSearchModpacks(query, pageSize = 12, index = 0) {
  const apiKey = getCurseForgeApiKey();
  if (!apiKey) throw new Error("CurseForge API key not configured (set it in Panel settings or ELEGANTMC_CURSEFORGE_API_KEY)");
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  if (q.length > 120) throw new Error("query too long");

  const size = Math.max(1, Math.min(50, Number(pageSize || 12)));
  const idx = Math.max(0, Math.min(5000, Number(index || 0)));
  const params = new URLSearchParams();
  params.set("gameId", "432"); // Minecraft
  params.set("classId", "4471"); // Modpacks
  params.set("pageSize", String(size));
  params.set("index", String(idx));
  params.set("searchFilter", q);

  const url = `${CURSEFORGE_BASE_URL}/v1/mods/search?${params.toString()}`;
  const { res, json } = await fetchJsonWithTimeout(
    url,
    { headers: { "User-Agent": "ElegantMC Panel", "x-api-key": apiKey } },
    15_000
  );
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((m) => ({
    provider: "curseforge",
    id: String(m.id),
    title: m.name,
    description: m.summary,
    icon_url: m.logo?.url || "",
    downloads: m.downloadCount,
    game_versions: Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes.map((x) => x?.gameVersion).filter(Boolean) : [],
  }));
}

async function curseforgeModFiles(modId, pageSize = 25, index = 0) {
  const apiKey = getCurseForgeApiKey();
  if (!apiKey) throw new Error("CurseForge API key not configured (set it in Panel settings or ELEGANTMC_CURSEFORGE_API_KEY)");
  const id = String(modId || "").trim();
  if (!id) throw new Error("mod_id is required");
  const size = Math.max(1, Math.min(50, Number(pageSize || 25)));
  const idx = Math.max(0, Math.min(5000, Number(index || 0)));

  const params = new URLSearchParams();
  params.set("pageSize", String(size));
  params.set("index", String(idx));
  const url = `${CURSEFORGE_BASE_URL}/v1/mods/${encodeURIComponent(id)}/files?${params.toString()}`;
  const { res, json } = await fetchJsonWithTimeout(
    url,
    { headers: { "User-Agent": "ElegantMC Panel", "x-api-key": apiKey } },
    15_000
  );
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((f) => ({
    provider: "curseforge",
    id: String(f.id),
    display_name: f.displayName,
    file_name: f.fileName,
    file_date: f.fileDate,
    release_type: f.releaseType,
    download_url: f.downloadUrl || "",
    file_length: f.fileLength,
    game_versions: Array.isArray(f.gameVersions) ? f.gameVersions : [],
  }));
}

async function curseforgeFileDownloadUrl(fileId) {
  const apiKey = getCurseForgeApiKey();
  if (!apiKey) throw new Error("CurseForge API key not configured (set it in Panel settings or ELEGANTMC_CURSEFORGE_API_KEY)");
  const id = String(fileId || "").trim();
  if (!id) throw new Error("file_id is required");
  const url = `${CURSEFORGE_BASE_URL}/v1/mods/files/${encodeURIComponent(id)}/download-url`;
  const { res, json } = await fetchJsonWithTimeout(
    url,
    { headers: { "User-Agent": "ElegantMC Panel", "x-api-key": apiKey } },
    15_000
  );
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);
  const dl = json?.data;
  if (!dl || typeof dl !== "string") throw new Error("no download url");
  return dl;
}

const frpStatusCache = new Map(); // profileId -> { checkedAtUnix, online, latencyMs, error }
const FRP_STATUS_TTL_SEC = 15;

function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port: Number(port) });

    const done = (online, error = "") => {
      const latencyMs = Date.now() - startedAt;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve({ online, latencyMs, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, ""));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (e) => done(false, String(e?.message || e)));
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getFrpStatuses(profiles, { force } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const stale = [];

  for (const p of profiles) {
    if (force) {
      stale.push(p);
      continue;
    }
    const cached = frpStatusCache.get(p.id);
    if (cached && now - (cached.checkedAtUnix || 0) < FRP_STATUS_TTL_SEC) continue;
    stale.push(p);
  }

  if (stale.length) {
    await mapLimit(stale, 8, async (p) => {
      const host = String(p.server_addr || "").trim();
      const port = Number(p.server_port || 0);
      if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
        frpStatusCache.set(p.id, { checkedAtUnix: now, online: false, latencyMs: 0, error: "invalid host/port" });
        return;
      }
      const res = await probeTcp(host, port, 1200);
      frpStatusCache.set(p.id, { checkedAtUnix: now, online: !!res.online, latencyMs: res.latencyMs, error: res.error || "" });
    });
  }

  const out = new Map();
  for (const p of profiles) {
    const st = frpStatusCache.get(p.id);
    out.set(p.id, st || { checkedAtUnix: 0, online: null, latencyMs: 0, error: "" });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    setSecurityHeaders(req, res);

    if (url.pathname === "/healthz") {
      return text(res, 200, "ok");
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return json(res, 200, {
        enable_advanced: enableAdvanced,
        panel_id: state.panel_id || "",
        panel_version: String(process.env.ELEGANTMC_VERSION || "dev"),
        panel_revision: String(process.env.ELEGANTMC_REVISION || ""),
        panel_build_date: String(process.env.ELEGANTMC_BUILD_DATE || ""),
      });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const ok = !!getSession(req);
      return ok ? json(res, 200, { authed: true }) : json(res, 401, { authed: false });
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!checkLoginRateLimit(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const password = String(body?.password || "");
        if (!safeEqual(password, adminPassword)) {
          appendAudit(req, "auth.login_failed", { reason: "invalid_password" });
          return json(res, 401, { error: "invalid password" });
        }
        const token = randomBytes(24).toString("base64url");
        const now = nowUnix();
        sessions.set(token, { expiresAtUnix: now + SESSION_TTL_SEC });
        queueSessionsSave();
        appendAudit(req, "auth.login_ok", { token: maskToken(token) });
        loginAttempts.delete(getClientIP(req) || "unknown");
        res.setHeader(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: "Lax",
            path: "/",
            maxAge: SESSION_TTL_SEC,
          })
        );
        return json(res, 200, { authed: true });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const session = getSession(req);
      if (session?.token) {
        appendAudit(req, "auth.logout", { token: maskToken(session.token) });
        sessions.delete(session.token);
        queueSessionsSave();
      }
      res.setHeader(
        "Set-Cookie",
        serializeCookie(SESSION_COOKIE, "", {
          httpOnly: true,
          secure: secureCookie,
          sameSite: "Lax",
          path: "/",
          maxAge: 0,
        })
      );
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      const open = url.pathname === "/api/mc/versions" || url.pathname === "/api/config" || url.pathname.startsWith("/api/auth/");
      if (!open && !requireAdmin(req, res)) return;
    }

    if (url.pathname === "/api/panel/settings" && req.method === "GET") {
      const settings = await getPanelSettings();
      return json(res, 200, { settings });
    }
    if (url.pathname === "/api/panel/settings" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const settings = await savePanelSettings(body);
        appendAudit(req, "panel.settings_save", {
          brand_name: settings?.brand_name || "",
          has_curseforge_api_key: !!String(settings?.curseforge_api_key || "").trim(),
          defaults: settings?.defaults || {},
        });
        return json(res, 200, { settings });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/daemons" && req.method === "GET") {
      // Include configured nodes even if never connected.
      const nodes = await listNodes();
      for (const n of nodes) {
        getOrCreateDaemon(n.id);
      }
      const list = Array.from(state.daemons.values()).map((d) => ({
        id: d.id,
        connected: d.connected,
        connectedAtUnix: d.connectedAtUnix,
        lastSeenUnix: d.lastSeenUnix,
        hello: d.hello,
        heartbeat: d.heartbeat,
        history: Array.isArray(d.history) ? d.history.slice(-180) : [],
      }));
      return json(res, 200, { daemons: list });
    }

    if (url.pathname === "/api/mc/versions" && req.method === "GET") {
      try {
        const versions = await getMcVersions();
        return json(res, 200, { versions });
      } catch (e) {
        mcVersionsCache.error = String(e?.message || e);
        return json(res, 502, { error: mcVersionsCache.error });
      }
    }

    if (url.pathname === "/api/mc/fabric/server-jar" && req.method === "GET") {
      const mc = String(url.searchParams.get("mc") || "").trim();
      const loader = String(url.searchParams.get("loader") || "").trim();
      try {
        const resolved = await fabricResolveServerJar(mc, loader);
        return json(res, 200, resolved);
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/mc/quilt/server-jar" && req.method === "GET") {
      const mc = String(url.searchParams.get("mc") || "").trim();
      const loader = String(url.searchParams.get("loader") || "").trim();
      try {
        const resolved = await quiltResolveServerJar(mc, loader);
        return json(res, 200, resolved);
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/modpacks/providers" && req.method === "GET") {
      return json(res, 200, {
        providers: [
          { id: "modrinth", name: "Modrinth", enabled: true },
          { id: "curseforge", name: "CurseForge", enabled: !!getCurseForgeApiKey() },
        ],
      });
    }

    if (url.pathname === "/api/modpacks/search" && req.method === "GET") {
      const provider = String(url.searchParams.get("provider") || "modrinth").trim().toLowerCase();
      const query = String(url.searchParams.get("query") || "").trim();
      const limit = Number(url.searchParams.get("limit") || "12");
      const offset = Number(url.searchParams.get("offset") || "0");
      try {
        if (provider === "modrinth") {
          const results = await modrinthSearchModpacks(query, limit, offset);
          return json(res, 200, { provider, results });
        }
        if (provider === "curseforge") {
          const results = await curseforgeSearchModpacks(query, limit, offset);
          return json(res, 200, { provider, results });
        }
        return json(res, 400, { error: "unknown provider" });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    const mMrVersions = url.pathname.match(/^\/api\/modpacks\/modrinth\/([^/]+)\/versions$/);
    if (mMrVersions && req.method === "GET") {
      const id = decodeURIComponent(mMrVersions[1]);
      try {
        const versions = await modrinthProjectVersions(id);
        return json(res, 200, { provider: "modrinth", project_id: id, versions });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    const mCfFiles = url.pathname.match(/^\/api\/modpacks\/curseforge\/([^/]+)\/files$/);
    if (mCfFiles && req.method === "GET") {
      const id = decodeURIComponent(mCfFiles[1]);
      const limit = Number(url.searchParams.get("limit") || "25");
      const offset = Number(url.searchParams.get("offset") || "0");
      try {
        const files = await curseforgeModFiles(id, limit, offset);
        return json(res, 200, { provider: "curseforge", mod_id: id, files });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    const mCfDl = url.pathname.match(/^\/api\/modpacks\/curseforge\/files\/([^/]+)\/download-url$/);
    if (mCfDl && req.method === "GET") {
      const id = decodeURIComponent(mCfDl[1]);
      try {
        const urlText = await curseforgeFileDownloadUrl(id);
        return json(res, 200, { provider: "curseforge", file_id: id, url: urlText });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/modpacks/curseforge/resolve-url" && req.method === "GET") {
      const inputUrl = String(url.searchParams.get("url") || "").trim();
      try {
        if (!inputUrl) throw new Error("url is required");
        const u = new URL(inputUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("invalid protocol");
        if (!isAllowedCurseForgeHost(u.hostname)) throw new Error("only curseforge.com urls are allowed");

        const candidates = buildCurseForgeCandidates(u.toString());
        for (const cand of candidates) {
          const resolved = await resolveRedirectUrl(cand, 8);
          if (isLikelyDirectDownloadUrl(resolved)) {
            const fileName = decodeURIComponent(new URL(resolved).pathname.split("/").pop() || "");
            return json(res, 200, {
              input: u.toString(),
              resolved,
              file_name: fileName || "",
              candidates,
            });
          }
        }

        return json(res, 404, {
          error: "could not resolve a direct download url (try copying the /files/<id> link)",
          input: u.toString(),
          candidates,
        });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/frp/profiles" && req.method === "GET") {
      const profiles = await listFrpProfiles();
      const force = url.searchParams.get("force") === "1";
      const statuses = await getFrpStatuses(profiles, { force });
      const out = profiles.map((p) => ({
        id: p.id,
        name: p.name,
        server_addr: p.server_addr,
        server_port: p.server_port,
        created_at_unix: p.created_at_unix,
        has_token: !!(p.token && String(p.token).trim()),
        token_masked: maskToken(p.token),
        status: statuses.get(p.id) || { checkedAtUnix: 0, online: null, latencyMs: 0, error: "" },
      }));
      return json(res, 200, { profiles: out });
    }
    if (url.pathname === "/api/frp/profiles" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const profile = await createFrpProfile(body);
        appendAudit(req, "frp.create_profile", {
          id: profile?.id || "",
          name: profile?.name || "",
          server_addr: profile?.server_addr || "",
          server_port: profile?.server_port || 0,
          has_token: !!(profile?.token && String(profile.token).trim()),
        });
        return json(res, 200, {
          profile: {
            id: profile.id,
            name: profile.name,
            server_addr: profile.server_addr,
            server_port: profile.server_port,
            created_at_unix: profile.created_at_unix,
            has_token: !!(profile.token && String(profile.token).trim()),
            token_masked: maskToken(profile.token),
          },
        });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }
    const mFrpToken = url.pathname.match(/^\/api\/frp\/profiles\/([^/]+)\/token$/);
    if (mFrpToken && req.method === "GET") {
      const id = decodeURIComponent(mFrpToken[1]);
      const profiles = await listFrpProfiles();
      const p = profiles.find((x) => x && x.id === id);
      if (!p) return json(res, 404, { error: "not found" });
      const token = String(p.token || "");
      if (!token) return json(res, 404, { error: "no token set" });
      appendAudit(req, "frp.reveal_token", { id });
      return json(res, 200, { id, token });
    }
    const mFrpProbe = url.pathname.match(/^\/api\/frp\/profiles\/([^/]+)\/probe$/);
    if (mFrpProbe && req.method === "POST") {
      const id = decodeURIComponent(mFrpProbe[1]);
      const profiles = await listFrpProfiles();
      const p = profiles.find((x) => x && x.id === id);
      if (!p) return json(res, 404, { error: "not found" });

      const host = String(p.server_addr || "").trim();
      const port = Number(p.server_port || 0);
      if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return json(res, 400, { error: "invalid host/port" });

      const now = Math.floor(Date.now() / 1000);
      const status = await probeTcp(host, port, 1200);
      frpStatusCache.set(id, { checkedAtUnix: now, online: status.online, latencyMs: status.latencyMs, error: status.error || "" });
      return json(res, 200, { id, status: frpStatusCache.get(id) });
    }
    const mFrp = url.pathname.match(/^\/api\/frp\/profiles\/([^/]+)$/);
    if (mFrp && req.method === "DELETE") {
      const id = decodeURIComponent(mFrp[1]);
      const ok = await deleteFrpProfile(id);
      if (!ok) return json(res, 404, { error: "not found" });
      appendAudit(req, "frp.delete_profile", { id });
      return json(res, 200, { deleted: true });
    }

    if (url.pathname === "/api/nodes" && req.method === "GET") {
      const nodes = await listNodes();
      const out = nodes.map((n) => {
        const id = n.id;
        const token = getDaemonTokenSync(id);
        const d = state.daemons.get(id);
        return {
          id,
          token_masked: maskToken(token),
          connected: d?.connected ?? false,
          connectedAtUnix: d?.connectedAtUnix ?? null,
          lastSeenUnix: d?.lastSeenUnix ?? null,
          hello: d?.hello ?? null,
          heartbeat: d?.heartbeat ?? null,
          history: Array.isArray(d?.history) ? d.history.slice(-180) : [],
        };
      });
      return json(res, 200, { nodes: out });
    }
    if (url.pathname === "/api/nodes" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const node = await createNode(body);
        appendAudit(req, "nodes.create", { id: node?.id || "" });
        return json(res, 200, { node });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }
    const mNodeToken = url.pathname.match(/^\/api\/nodes\/([^/]+)\/token$/);
    if (mNodeToken && req.method === "GET") {
      const id = decodeURIComponent(mNodeToken[1]);
      const token = getDaemonTokenSync(id);
      if (!token) return json(res, 404, { error: "not found" });
      return json(res, 200, { id, token });
    }
    const mNode = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
    if (mNode && req.method === "DELETE") {
      const id = decodeURIComponent(mNode[1]);
      const ok = await deleteNode(id);
      if (!ok) return json(res, 404, { error: "not found" });
      appendAudit(req, "nodes.delete", { id });
      return json(res, 200, { deleted: true });
    }

    const mDaemon = url.pathname.match(/^\/api\/daemons\/([^/]+)(?:\/(logs|command))?$/);
    if (mDaemon) {
      const daemonId = decodeURIComponent(mDaemon[1]);
      const suffix = mDaemon[2] || "";

      if (suffix === "" && req.method === "GET") {
        const d = state.daemons.get(daemonId);
        if (!d) return json(res, 404, { error: "not found" });
        return json(res, 200, d);
      }

      if (suffix === "logs" && req.method === "GET") {
        const d = state.daemons.get(daemonId);
        if (!d) return json(res, 404, { error: "not found" });
        const limit = Math.min(Number(url.searchParams.get("limit") || "200"), 2000);
        return json(res, 200, { logs: d.logs.slice(-limit) });
      }

      if (suffix === "command" && req.method === "POST") {
        const body = await readJsonBody(req);
        const name = body?.name;
        const args = body?.args ?? {};
        if (!name || typeof name !== "string") {
          return json(res, 400, { error: "name is required" });
        }
        const timeoutMs = Number(body?.timeoutMs || 30_000);
        try {
          const result = await sendCommand(daemonId, { name, args }, { timeoutMs });
          appendAudit(req, "daemon.command", {
            daemon_id: daemonId,
            name,
            args,
            timeout_ms: timeoutMs,
            ok: !!result?.ok,
            error: String(result?.error || ""),
          });
          return json(res, 200, { result });
        } catch (e) {
          appendAudit(req, "daemon.command_failed", {
            daemon_id: daemonId,
            name,
            args,
            timeout_ms: timeoutMs,
            error: String(e?.message || e),
          });
          throw e;
        }
      }
    }

    return nextHandle(req, res);
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws/daemon") {
      socket.destroy();
      return;
    }

    const daemonId = req.headers["x-elegantmc-daemon"];
    const token = getAuthToken(req);
    if (!daemonId || typeof daemonId !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\\r\\n\\r\\n");
      socket.destroy();
      return;
    }
    const expected = getDaemonTokenSync(daemonId);
    if (!expected || !token || expected !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(daemonId, ws);
      ws.on("message", (data) => {
        handleDaemonMessage(daemonId, data);
      });
    });
  } catch {
    socket.destroy();
  }
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[panel] listening on http://${host}:${port}`);
});
