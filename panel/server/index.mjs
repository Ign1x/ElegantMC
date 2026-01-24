import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

function sessionID(token) {
  return createHash("sha256").update(String(token ?? "")).digest("hex");
}

function extractLatestChangelogSection(md) {
  const raw = String(md || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start < 0) return raw.trim();
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const slice = lines.slice(start, end < 0 ? lines.length : end).join("\n").trim();
  return slice || raw.trim();
}

async function readChangelogText() {
  const candidates = [
    // Prefer bundling inside panel/ (included in the image/build context).
    path.join(process.cwd(), "CHANGELOG.md"),
    // Dev fallback when running from repo root.
    path.join(process.cwd(), "..", "CHANGELOG.md"),
  ];
  let lastErr = null;
  for (const fp of candidates) {
    try {
      const text = await fs.readFile(fp, "utf8");
      return { fp, text };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error("CHANGELOG.md not found");
  err.cause = lastErr;
  throw err;
}

const DOCS = {
  readme: {
    title: "README",
    candidates: [path.join(process.cwd(), "docs", "README.md"), path.join(process.cwd(), "..", "README.md")],
  },
  security: {
    title: "SECURITY",
    candidates: [path.join(process.cwd(), "docs", "SECURITY.md"), path.join(process.cwd(), "..", "SECURITY.md")],
  },
  panel_readme: {
    title: "Panel README",
    candidates: [path.join(process.cwd(), "README.md")],
  },
  changelog: {
    title: "CHANGELOG",
    candidates: [path.join(process.cwd(), "CHANGELOG.md"), path.join(process.cwd(), "..", "CHANGELOG.md")],
  },
};

async function readDocText(name) {
  const key = String(name || "").trim().toLowerCase();
  const cfg = DOCS[key];
  if (!cfg) throw new Error("unknown doc");
  let lastErr = null;
  for (const fp of cfg.candidates) {
    try {
      const text = await fs.readFile(fp, "utf8");
      return { name: key, title: cfg.title, fp, text };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(`${cfg.title} not found`);
  err.cause = lastErr;
  throw err;
}

const host = process.env.ELEGANTMC_PANEL_HOST || "0.0.0.0";
const port = Number(process.env.ELEGANTMC_PANEL_PORT || "3000");

const dev = process.env.NODE_ENV !== "production";
const secureCookie = String(process.env.ELEGANTMC_PANEL_SECURE_COOKIE || "").trim() === "1";
const enableAdvanced = truthy(process.env.ELEGANTMC_ENABLE_ADVANCED);
const enableHSTS = truthy(process.env.ELEGANTMC_PANEL_HSTS);

const updateCheckEnabled = truthy(process.env.ELEGANTMC_UPDATE_CHECK_ENABLED ?? "1");
const updateRepo = String(process.env.ELEGANTMC_UPDATE_REPO || process.env.ELEGANTMC_UPDATE_GITHUB_REPO || "").trim();
const updateCheckURL = String(
  process.env.ELEGANTMC_UPDATE_CHECK_URL ||
    (updateRepo ? `https://api.github.com/repos/${updateRepo}/releases/latest` : "")
).trim();
const UPDATE_CACHE_TTL_SEC = 10 * 60;
let updateCache = { atUnix: 0, result: null, error: "" };

function parseCmdList(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const advancedAllow = new Set(parseCmdList(process.env.ELEGANTMC_ADVANCED_CMD_ALLOWLIST || ""));
const advancedDeny = new Set([
  // Default deny: keep Advanced read-mostly.
  "fs_delete",
  "fs_write",
  "fs_move",
  "fs_copy",
  "fs_unzip",
  "fs_upload_begin",
  "fs_upload_chunk",
  "fs_upload_commit",
  "fs_upload_abort",
  "fs_download",
  "mc_delete",
  "frpc_install",
  "mc_java_cache_remove",
  ...parseCmdList(process.env.ELEGANTMC_ADVANCED_CMD_DENYLIST || ""),
]);

function isAllowedAdvancedCommand(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  if (advancedDeny.has(n)) return false;
  if (process.env.ELEGANTMC_ADVANCED_CMD_ALLOWLIST) return advancedAllow.has(n);
  return true;
}

const SESSION_COOKIE = "elegantmc_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const sessions = new Map(); // token -> { expiresAtUnix, createdAtUnix?, lastSeenAtUnix?, ip?, ua?, user_id?, username? }
let sessionsDirty = false;
const SESSIONS_PATH = path.join(PANEL_DATA_DIR, "sessions.json");
let sessionsWriteChain = Promise.resolve();

const PANEL_SECRET_PATH = path.join(PANEL_DATA_DIR, "panel_secret.json");
let panelSecretLoaded = false;
let panelSecretManagedByEnv = false;
let panelSecretB64 = "";
let panelSecret = Buffer.alloc(0);

const USERS_PATH = path.join(PANEL_DATA_DIR, "users.json");
let usersLoaded = false;
let users = []; // [{ id, username, pw_salt_b64, pw_hash_b64, created_at_unix, updated_at_unix, totp?: {...} }]
let usersWriteChain = Promise.resolve();

const API_TOKENS_PATH = path.join(PANEL_DATA_DIR, "api_tokens.json");
let apiTokensLoaded = false;
let apiTokens = []; // [{ id, user_id, name, token_hash_b64, created_at_unix, last_used_at_unix }]
let apiTokensWriteChain = Promise.resolve();
let apiTokenByHash = new Map(); // token_hash_b64 -> token record

const UI_PREFS_PATH = path.join(PANEL_DATA_DIR, "ui_prefs.json");
let uiPrefs = { theme_mode: "auto", density: "comfortable" };
let uiPrefsWriteChain = Promise.resolve();

const AUDIT_LOG_PATH = path.join(PANEL_DATA_DIR, "audit.log");

function normalizeThemeMode(v) {
  const m = String(v || "").trim().toLowerCase();
  if (m === "dark" || m === "light" || m === "contrast" || m === "auto") return m;
  return "auto";
}

function normalizeDensity(v) {
  const d = String(v || "").trim().toLowerCase();
  if (d === "compact" || d === "comfortable") return d;
  return "comfortable";
}

function serializeUiPrefs() {
  return {
    updated_at_unix: nowUnix(),
    theme_mode: normalizeThemeMode(uiPrefs?.theme_mode || "auto"),
    density: normalizeDensity(uiPrefs?.density || "comfortable"),
  };
}

function queueUiPrefsSave() {
  uiPrefsWriteChain = uiPrefsWriteChain
    .then(async () => {
      const payload = JSON.stringify(serializeUiPrefs(), null, 2);
      await writeFileAtomic(UI_PREFS_PATH, payload);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[panel] ui_prefs save failed:", e?.message || e);
    });
  return uiPrefsWriteChain;
}

async function loadUiPrefsFromDisk() {
  try {
    const raw = await fs.readFile(UI_PREFS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    uiPrefs = {
      theme_mode: normalizeThemeMode(parsed?.theme_mode || "auto"),
      density: normalizeDensity(parsed?.density || "comfortable"),
    };
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load ui_prefs:", e?.message || e);
    }
    uiPrefs = { theme_mode: "auto", density: "comfortable" };
  }
}

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
    const auth = getAuth(req);
    const entry = {
      ts_unix: nowUnix(),
      ip: getClientIP(req) || "",
      action: String(action || "").trim(),
      user: auth?.username ? String(auth.username) : "",
      auth: auth?.kind ? String(auth.kind) : "",
      session: auth?.kind === "session" && auth?.token ? maskToken(auth.token) : "",
      token_id: auth?.kind === "api_token" && auth?.token_id ? String(auth.token_id) : "",
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
    const createdAtUnix = Number(s?.createdAtUnix || 0);
    const lastSeenAtUnix = Number(s?.lastSeenAtUnix || 0);
    const user_id = String(s?.user_id || "").trim();
    const username = String(s?.username || "").trim();
    const ip = String(s?.ip || "").trim().slice(0, 64);
    const ua = String(s?.ua || "").trim().slice(0, 256);
    const csrf_token = String(s?.csrf_token || s?.csrf || "").trim();
    out[token] = {
      expiresAtUnix,
      ...(Number.isFinite(createdAtUnix) && createdAtUnix > 0 ? { createdAtUnix } : {}),
      ...(Number.isFinite(lastSeenAtUnix) && lastSeenAtUnix > 0 ? { lastSeenAtUnix } : {}),
      ...(user_id ? { user_id } : {}),
      ...(username ? { username } : {}),
      ...(ip ? { ip } : {}),
      ...(ua ? { ua } : {}),
      ...(csrf_token ? { csrf_token } : {}),
    };
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
  await loadUsersFromDisk();
  let admin = getUserByUsername("admin");
  if (!admin) {
    try {
      admin = ensureDefaultAdminUser(bootstrapAdminPassword);
    } catch {
      admin = null;
    }
  }

  try {
    const raw = await fs.readFile(SESSIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const obj = parsed?.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions) ? parsed.sessions : {};
    const now = nowUnix();
    for (const [token, s] of Object.entries(obj)) {
      const expiresAtUnix = Number(s?.expiresAtUnix || 0);
      const createdAtUnix = Number(s?.createdAtUnix || 0);
      const lastSeenAtUnixRaw = Number(s?.lastSeenAtUnix || 0);
      const user_id = String(s?.user_id || "").trim() || (admin?.id ? String(admin.id) : "");
      const username =
        String(s?.username || "").trim() ||
        (user_id && admin?.id && user_id === admin.id ? "admin" : getUserByID(user_id)?.username || "");
      const ip = String(s?.ip || "").trim().slice(0, 64);
      const ua = String(s?.ua || "").replace(/[\r\n]+/g, " ").trim().slice(0, 256);
      const csrf_token = String(s?.csrf_token || s?.csrf || "").trim();
      if (!token || typeof token !== "string") continue;
      if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= now) continue;
      const lastSeenAtUnix =
        Number.isFinite(lastSeenAtUnixRaw) && lastSeenAtUnixRaw > 0
          ? lastSeenAtUnixRaw
          : Number.isFinite(createdAtUnix) && createdAtUnix > 0
            ? createdAtUnix
            : 0;
      sessions.set(token, {
        expiresAtUnix,
        ...(Number.isFinite(createdAtUnix) && createdAtUnix > 0 ? { createdAtUnix } : {}),
        ...(Number.isFinite(lastSeenAtUnix) && lastSeenAtUnix > 0 ? { lastSeenAtUnix } : {}),
        ...(user_id ? { user_id } : {}),
        ...(username ? { username } : {}),
        ...(ip ? { ip } : {}),
        ...(ua ? { ua } : {}),
        ...(csrf_token ? { csrf_token } : {}),
      });
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load sessions:", e?.message || e);
    }
  }
}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseSemverLike(raw) {
  const v = String(raw || "").trim().replace(/^v/i, "");
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

function compareSemverLike(aRaw, bRaw) {
  const a = parseSemverLike(aRaw);
  const b = parseSemverLike(bRaw);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function normalizeUsername(raw) {
  const v = String(raw || "").trim();
  if (!v) throw new Error("username is required");
  if (!USERNAME_RE.test(v)) throw new Error("invalid username (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,31})");
  return v;
}

function normalizeTokenName(raw) {
  const v = String(raw || "").trim();
  if (!v) return "token";
  if (v.length > 64) return v.slice(0, 64);
  return v;
}

function hashPassword(password, saltB64 = "") {
  const pwd = String(password ?? "");
  if (!pwd) throw new Error("password is required");
  if (pwd.length > 256) throw new Error("password too long");
  const salt = saltB64 ? Buffer.from(String(saltB64 || ""), "base64") : randomBytes(16);
  const key = scryptSync(pwd, salt, 64);
  return { pw_salt_b64: salt.toString("base64"), pw_hash_b64: key.toString("base64") };
}

function verifyPassword(password, saltB64, hashB64) {
  try {
    const next = hashPassword(password, saltB64);
    const aa = Buffer.from(String(next.pw_hash_b64 || ""), "base64");
    const bb = Buffer.from(String(hashB64 || ""), "base64");
    if (!aa.length || !bb.length || aa.length !== bb.length) return false;
    return timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B32_LOOKUP = new Map(Array.from(B32_ALPHABET).map((c, i) => [c, i]));

function base32Encode(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(raw) {
  const clean = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const v = B32_LOOKUP.get(clean[i]);
    if (v == null) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function normalizeTotpCode(raw) {
  const v = String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^0-9]/g, "");
  return v;
}

function hotp(secretBytes, counter, digits = 6) {
  const c = BigInt(Math.max(0, Math.floor(Number(counter || 0))));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(c, 0);
  const h = createHmac("sha1", secretBytes).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  const mod = 10 ** Math.max(1, Math.min(10, Math.floor(digits)));
  return String(code % mod).padStart(digits, "0");
}

function totpVerify(secretB32, codeRaw, { window = 1, stepSec = 30, digits = 6 } = {}) {
  const secretBytes = base32Decode(secretB32);
  if (!secretBytes || !secretBytes.length) return false;
  const code = normalizeTotpCode(codeRaw);
  if (!code || code.length !== digits) return false;
  const now = nowUnix();
  const counter = Math.floor(now / Math.max(1, Math.floor(stepSec)));
  const w = Math.max(0, Math.min(4, Math.floor(window)));
  for (let i = -w; i <= w; i++) {
    const cur = hotp(secretBytes, counter + i, digits);
    if (safeEqual(cur, code)) return true;
  }
  return false;
}

function normalizeRecoveryCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(code) {
  const c = normalizeRecoveryCode(code);
  if (!c) return "";
  return createHash("sha256").update(c).digest("base64");
}

function generateRecoveryCodes(count = 10) {
  const n = Math.max(1, Math.min(20, Math.floor(count)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    const grouped = raw.match(/.{1,4}/g)?.join("-") || raw;
    out.push(grouped);
  }
  return out;
}

function makeOtpAuthURI({ username, issuer, secretB32 }) {
  const u = String(username || "").trim();
  const iss = String(issuer || "ElegantMC").trim() || "ElegantMC";
  const sec = String(secretB32 || "").trim().toUpperCase();
  const label = encodeURIComponent(`${iss}:${u}`);
  const params = new URLSearchParams({ secret: sec, issuer: iss, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function normalizeTotpForSave(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!t) return null;
  const enabled = typeof t.enabled === "boolean" ? !!t.enabled : false;
  const secret_b32 = String(t.secret_b32 || "").trim().toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!enabled) return null;
  if (!secret_b32 || secret_b32.length > 128) return null;
  const secretBytes = base32Decode(secret_b32);
  if (!secretBytes || !secretBytes.length) return null;
  const createdAt = Number(t.created_at_unix || 0);
  const updatedAt = Number(t.updated_at_unix || 0);
  const recoveryIn = Array.isArray(t.recovery) ? t.recovery : [];
  const recovery = recoveryIn
    .map((r) => {
      const hash_b64 = String(r?.hash_b64 || r?.hash || "").trim();
      const used_at_unix = Number(r?.used_at_unix || 0);
      if (!hash_b64) return null;
      return {
        hash_b64,
        used_at_unix: Number.isFinite(used_at_unix) && used_at_unix > 0 ? used_at_unix : 0,
      };
    })
    .filter(Boolean);
  return {
    enabled: true,
    secret_b32,
    created_at_unix: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
    updated_at_unix: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
    recovery,
  };
}

function serializeUsers() {
  const out = (Array.isArray(users) ? users : [])
    .map((u) => {
      const id = String(u?.id || "").trim();
      const username = String(u?.username || "").trim();
      const pw_salt_b64 = String(u?.pw_salt_b64 || "").trim();
      const pw_hash_b64 = String(u?.pw_hash_b64 || "").trim();
      const created_at_unix = Number(u?.created_at_unix || 0);
      const updated_at_unix = Number(u?.updated_at_unix || 0);
      const totp = normalizeTotpForSave(u?.totp);
      if (!id || !username || !pw_salt_b64 || !pw_hash_b64) return null;
      return {
        id,
        username,
        pw_salt_b64,
        pw_hash_b64,
        created_at_unix: Number.isFinite(created_at_unix) && created_at_unix > 0 ? created_at_unix : null,
        updated_at_unix: Number.isFinite(updated_at_unix) && updated_at_unix > 0 ? updated_at_unix : null,
        ...(totp ? { totp } : {}),
      };
    })
    .filter(Boolean);
  return { updated_at_unix: nowUnix(), users: out };
}

function queueUsersSave() {
  usersWriteChain = usersWriteChain
    .then(async () => {
      const payload = JSON.stringify(serializeUsers(), null, 2);
      await writeFileAtomic(USERS_PATH, payload);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[panel] users save failed:", e?.message || e);
    });
  return usersWriteChain;
}

async function loadUsersFromDisk() {
  if (usersLoaded) return;
  try {
    const raw = await fs.readFile(USERS_PATH, "utf8");
    const parsed = safeJsonParse(raw);
    const list = Array.isArray(parsed?.users) ? parsed.users : [];
    users = list
      .map((u) => {
        try {
          const id = String(u?.id || "").trim();
          const username = normalizeUsername(u?.username || "");
          const pw_salt_b64 = String(u?.pw_salt_b64 || "").trim();
          const pw_hash_b64 = String(u?.pw_hash_b64 || "").trim();
          if (!id || !pw_salt_b64 || !pw_hash_b64) return null;
          return {
            id,
            username,
            pw_salt_b64,
            pw_hash_b64,
            created_at_unix: Number(u?.created_at_unix || 0) || 0,
            updated_at_unix: Number(u?.updated_at_unix || 0) || 0,
            totp: normalizeTotpForSave(u?.totp) || undefined,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load users:", e?.message || e);
    }
    users = [];
  } finally {
    usersLoaded = true;
  }
}

function getUserByUsername(username) {
  const u = String(username || "").trim();
  return (Array.isArray(users) ? users : []).find((x) => String(x?.username || "").trim() === u) || null;
}

function getUserByID(id) {
  const uid = String(id || "").trim();
  return (Array.isArray(users) ? users : []).find((x) => String(x?.id || "").trim() === uid) || null;
}

function ensureDefaultAdminUser(bootstrapPassword) {
  const now = nowUnix();
  const existing = getUserByUsername("admin");
  if (existing) return existing;
  const pwd = String(bootstrapPassword || "").trim();
  if (!pwd) throw new Error("bootstrap admin password missing");
  const id = randomBytes(12).toString("base64url");
  const h = hashPassword(pwd);
  const u = { id, username: "admin", ...h, created_at_unix: now, updated_at_unix: now };
  users = [...(Array.isArray(users) ? users : []), u];
  queueUsersSave();
  return u;
}

function normalizeApiTokenValue(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.length > 256) return "";
  return v;
}

function hashApiTokenValue(tokenValue) {
  const v = normalizeApiTokenValue(tokenValue);
  if (!v) return "";
  return createHash("sha256").update(v).digest("base64");
}

function rebuildApiTokenIndex() {
  apiTokenByHash = new Map();
  for (const t of Array.isArray(apiTokens) ? apiTokens : []) {
    const h = String(t?.token_hash_b64 || "").trim();
    if (!h) continue;
    apiTokenByHash.set(h, t);
  }
}

function serializeApiTokens() {
  const list = (Array.isArray(apiTokens) ? apiTokens : [])
    .map((t) => {
      const id = String(t?.id || "").trim();
      const user_id = String(t?.user_id || "").trim();
      const name = String(t?.name || "").trim();
      const token_hash_b64 = String(t?.token_hash_b64 || "").trim();
      const created_at_unix = Number(t?.created_at_unix || 0);
      const last_used_at_unix = Number(t?.last_used_at_unix || 0);
      if (!id || !user_id || !token_hash_b64) return null;
      return {
        id,
        user_id,
        name,
        token_hash_b64,
        created_at_unix: Number.isFinite(created_at_unix) && created_at_unix > 0 ? created_at_unix : null,
        last_used_at_unix: Number.isFinite(last_used_at_unix) && last_used_at_unix > 0 ? last_used_at_unix : null,
      };
    })
    .filter(Boolean);
  return { updated_at_unix: nowUnix(), tokens: list };
}

function queueApiTokensSave() {
  apiTokensWriteChain = apiTokensWriteChain
    .then(async () => {
      const payload = JSON.stringify(serializeApiTokens(), null, 2);
      await writeFileAtomic(API_TOKENS_PATH, payload);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[panel] api_tokens save failed:", e?.message || e);
    });
  return apiTokensWriteChain;
}

async function loadApiTokensFromDisk() {
  if (apiTokensLoaded) return;
  try {
    const raw = await fs.readFile(API_TOKENS_PATH, "utf8");
    const parsed = safeJsonParse(raw);
    const list = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    apiTokens = list
      .map((t) => {
        const id = String(t?.id || "").trim();
        const user_id = String(t?.user_id || "").trim();
        const name = normalizeTokenName(t?.name || "");
        const token_hash_b64 = String(t?.token_hash_b64 || "").trim();
        if (!id || !user_id || !token_hash_b64) return null;
        return {
          id,
          user_id,
          name,
          token_hash_b64,
          created_at_unix: Number(t?.created_at_unix || 0) || 0,
          last_used_at_unix: Number(t?.last_used_at_unix || 0) || 0,
        };
      })
      .filter(Boolean);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load api tokens:", e?.message || e);
    }
    apiTokens = [];
  } finally {
    apiTokensLoaded = true;
    rebuildApiTokenIndex();
  }
}

const LOGIN_WINDOW_SEC = 5 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_USER_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> { count, resetAtUnix }
const loginAttemptsByUser = new Map(); // username -> { count, resetAtUnix }

let bootstrapAdminPassword = String(process.env.ELEGANTMC_PANEL_ADMIN_PASSWORD || "").trim();
if (!bootstrapAdminPassword) {
  bootstrapAdminPassword = randomBytes(9).toString("base64url");
  // eslint-disable-next-line no-console
  console.log(`[panel] generated admin password: ${bootstrapAdminPassword} (set ELEGANTMC_PANEL_ADMIN_PASSWORD to override)`);
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

function setPanelSecretFromB64(secretB64, { managedByEnv } = {}) {
  const b64 = String(secretB64 || "").trim();
  if (!b64) throw new Error("secret is empty");
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length || bytes.length < 16) throw new Error("secret too short");
  panelSecretB64 = b64;
  panelSecret = bytes;
  panelSecretLoaded = true;
  panelSecretManagedByEnv = !!managedByEnv;
}

async function ensurePanelSecret() {
  if (panelSecretLoaded && panelSecret.length) return;

  const envRaw = String(process.env.ELEGANTMC_PANEL_SECRET_B64 || process.env.ELEGANTMC_PANEL_SECRET || "").trim();
  if (envRaw) {
    setPanelSecretFromB64(envRaw, { managedByEnv: true });
    return;
  }

  try {
    const raw = await fs.readFile(PANEL_SECRET_PATH, "utf8");
    const parsed = safeJsonParse(raw);
    const b64 = String(parsed?.secret_b64 || parsed?.secret || "").trim();
    if (b64) {
      setPanelSecretFromB64(b64, { managedByEnv: false });
      return;
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load panel secret:", e?.message || e);
    }
  }

  const b64 = randomBytes(32).toString("base64");
  setPanelSecretFromB64(b64, { managedByEnv: false });
  const payload = JSON.stringify({ created_at_unix: nowUnix(), updated_at_unix: nowUnix(), secret_b64: b64 }, null, 2);
  await writeFileAtomic(PANEL_SECRET_PATH, payload);
}

function signSessionToken(token) {
  if (!panelSecret || !panelSecret.length) return "";
  const t = String(token || "").trim();
  if (!t) return "";
  return createHmac("sha256", panelSecret).update(t).digest("base64url");
}

function encodeSessionCookieValue(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  const sig = signSessionToken(t);
  if (!sig) return "";
  return `${t}.${sig}`;
}

function parseSessionCookieValue(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (!v.includes(".")) return { token: v, legacy: true };
  const idx = v.lastIndexOf(".");
  if (idx <= 0) return null;
  const token = v.slice(0, idx).trim();
  const sig = v.slice(idx + 1).trim();
  if (!token || !sig) return null;
  const expected = signSessionToken(token);
  if (!expected) return null;
  if (!safeEqual(expected, sig)) return null;
  return { token, legacy: false };
}

function getClientIP(req) {
  const ra = req.socket?.remoteAddress;
  const direct = typeof ra === "string" ? ra : "";

  const isLoopback =
    direct === "127.0.0.1" ||
    direct === "::1" ||
    direct === "::ffff:127.0.0.1" ||
    direct.startsWith("127.") ||
    direct.startsWith("::ffff:127.");

  const trustProxy = truthy(process.env.ELEGANTMC_TRUST_PROXY ?? "") || isLoopback;
  const xff = req.headers["x-forwarded-for"];
  if (trustProxy && typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return direct;
}

function normalizeRateLimitUserKey(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  return v.toLowerCase().slice(0, 64);
}

function checkLoginRateLimit(req, res, opts = {}) {
  const touchIP = opts?.touchIP !== false;
  const touchUser = opts?.touchUser !== false;
  const userKey = normalizeRateLimitUserKey(opts?.userKey ?? opts?.username ?? "");

  const ip = touchIP ? getClientIP(req) || "unknown" : "";
  const now = nowUnix();

  if (touchIP) {
    let st = loginAttempts.get(ip);
    if (!st || now >= (st.resetAtUnix || 0)) {
      st = { count: 0, resetAtUnix: now + LOGIN_WINDOW_SEC };
    }
    st.count += 1;
    loginAttempts.set(ip, st);
    if (st.count > LOGIN_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, (st.resetAtUnix || now) - now);
      res.setHeader("Retry-After", String(retryAfter));
      json(res, 429, {
        error: `too many login attempts (ip). try again in ${retryAfter}s`,
        retry_after_sec: retryAfter,
        scope: "ip",
      });
      return false;
    }
  }

  if (touchUser && userKey) {
    let st = loginAttemptsByUser.get(userKey);
    if (!st || now >= (st.resetAtUnix || 0)) {
      st = { count: 0, resetAtUnix: now + LOGIN_WINDOW_SEC };
    }
    st.count += 1;
    loginAttemptsByUser.set(userKey, st);
    if (st.count > LOGIN_USER_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, (st.resetAtUnix || now) - now);
      res.setHeader("Retry-After", String(retryAfter));
      json(res, 429, {
        error: `too many login attempts (user). try again in ${retryAfter}s`,
        retry_after_sec: retryAfter,
        scope: "user",
      });
      return false;
    }
  }
  return true;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const parsed = parseSessionCookieValue(cookies?.[SESSION_COOKIE] || "");
  if (!parsed?.token) return null;
  const token = parsed.token;
  let session = sessions.get(token);
  if (!session) return null;
  const now = nowUnix();
  if (session.expiresAtUnix && now > session.expiresAtUnix) {
    sessions.delete(token);
    queueSessionsSave();
    return null;
  }
  if (!String(session?.csrf_token || "").trim()) {
    const next = { ...session, csrf_token: randomBytes(18).toString("base64url") };
    sessions.set(token, next);
    sessionsDirty = true;
    session = next;
  }
  const ip = getClientIP(req) || "";
  const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : "";
  const uaNorm = String(ua || "").replace(/[\r\n]+/g, " ").trim().slice(0, 256);
  const ipNorm = String(ip || "").trim().slice(0, 64);

  const prevSeen = Number(session?.lastSeenAtUnix || 0);
  const shouldTouch = !Number.isFinite(prevSeen) || prevSeen <= 0 || now-prevSeen >= 15;
  const changed = shouldTouch || (ipNorm && ipNorm !== String(session?.ip || "")) || (uaNorm && uaNorm !== String(session?.ua || ""));
  if (changed) {
    const next = { ...session };
    if (shouldTouch) next.lastSeenAtUnix = now;
    if (ipNorm) next.ip = ipNorm;
    if (uaNorm) next.ua = uaNorm;
    if (!String(next?.csrf_token || "").trim()) next.csrf_token = randomBytes(18).toString("base64url");
    sessions.set(token, next);
    sessionsDirty = true;
    return { token, ...next };
  }

  return { token, ...session };
}

function getAuth(req) {
  const session = getSession(req);
  if (session) return { kind: "session", user_id: String(session?.user_id || ""), username: String(session?.username || ""), ...session };

  const tokenValue = normalizeApiTokenValue(getAuthToken(req));
  if (!tokenValue) return null;
  const hashB64 = hashApiTokenValue(tokenValue);
  if (!hashB64) return null;
  const rec = apiTokenByHash.get(hashB64) || null;
  if (!rec) return null;
  const u = getUserByID(String(rec?.user_id || "").trim());
  if (!u) return null;

  const now = nowUnix();
  const last = Number(rec?.last_used_at_unix || 0);
  if (!Number.isFinite(last) || now-last >= 15) {
    rec.last_used_at_unix = now;
    queueApiTokensSave();
  }
  return { kind: "api_token", token_id: String(rec?.id || ""), user_id: String(u.id || ""), username: String(u.username || "") };
}

function requireAdmin(req, res) {
  if (getAuth(req)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

function requireSessionAdmin(req, res) {
  if (getSession(req)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

function getCsrfHeader(req) {
  const raw = req.headers["x-csrf-token"];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && raw.length) return String(raw[0] || "").trim();
  return "";
}

function requireCSRF(req, res) {
  const m = String(req.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  const auth = getAuth(req);
  if (!auth) return true;
  if (auth.kind !== "session") return true;
  const expected = String(auth?.csrf_token || "").trim();
  const got = getCsrfHeader(req);
  if (expected && got && safeEqual(expected, got)) return true;
  json(res, 403, { error: "csrf token required" });
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
await ensurePanelSecret();
await loadUsersFromDisk();
try {
  if (!getUserByUsername("admin")) ensureDefaultAdminUser(bootstrapAdminPassword);
} catch {
  // ignore
}
await loadApiTokensFromDisk();
await loadSessionsFromDisk();
await loadUiPrefsFromDisk();

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
  for (const [k, st] of loginAttemptsByUser.entries()) {
    if (!st?.resetAtUnix || now >= st.resetAtUnix) loginAttemptsByUser.delete(k);
  }
  if (sessionsChanged || sessionsDirty) {
    sessionsDirty = false;
    queueSessionsSave();
  }
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
const PAPER_API_BASE_URL = String(process.env.ELEGANTMC_PAPER_API_BASE_URL || "https://api.papermc.io").replace(/\/+$/, "");
const PURPUR_API_BASE_URL = String(process.env.ELEGANTMC_PURPUR_API_BASE_URL || "https://api.purpurmc.org").replace(/\/+$/, "");

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

async function purpurResolveJar(minecraftVersion, buildRaw) {
  const mc = String(minecraftVersion || "").trim();
  let build = Math.max(0, Math.round(Number(buildRaw || 0) || 0));
  if (!mc) throw new Error("mc is required");
  if (mc.length > 64) throw new Error("mc too long");

  const metaUrl = `${PURPUR_API_BASE_URL}/v2/purpur/${encodeURIComponent(mc)}`;
  const { res, json } = await fetchJsonWithTimeout(metaUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 15_000);
  if (!res.ok) throw new Error(json?.error || `fetch failed: ${res.status}`);

  if (!build) {
    const latest = Number(json?.builds?.latest || 0);
    if (Number.isFinite(latest) && latest > 0) build = Math.round(latest);
    else if (Array.isArray(json?.builds) && json.builds.length) {
      const nums = json.builds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
      build = nums.length ? Math.max(...nums) : 0;
    }
  }
  if (!build) throw new Error("no purpur builds");

  const buildUrl = `${PURPUR_API_BASE_URL}/v2/purpur/${encodeURIComponent(mc)}/${encodeURIComponent(String(build))}`;
  const { res: res2, json: json2 } = await fetchJsonWithTimeout(buildUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 15_000);
  if (!res2.ok) throw new Error(json2?.error || `fetch failed: ${res2.status}`);

  const sha256 = String(json2?.sha256 || json2?.checksums?.sha256 || json2?.sha256_hash || "").trim().toLowerCase();
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("purpur sha256 missing");
  }
  const jarUrl = `${PURPUR_API_BASE_URL}/v2/purpur/${encodeURIComponent(mc)}/${encodeURIComponent(String(build))}/download`;
  return { mc, build, url: jarUrl, sha256 };
}

async function paperResolveJar(minecraftVersion, buildRaw) {
  const mc = String(minecraftVersion || "").trim();
  let build = Math.max(0, Math.round(Number(buildRaw || 0) || 0));
  if (!mc) throw new Error("mc is required");
  if (mc.length > 64) throw new Error("mc too long");

  const verUrl = `${PAPER_API_BASE_URL}/v2/projects/paper/versions/${encodeURIComponent(mc)}`;
  const { res, json } = await fetchJsonWithTimeout(verUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 15_000);
  if (!res.ok) throw new Error(json?.error || json?.message || `fetch failed: ${res.status}`);

  const builds = Array.isArray(json?.builds) ? json.builds : [];
  if (!build) {
    const nums = builds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    build = nums.length ? Math.max(...nums) : 0;
  }
  if (!build) throw new Error("no paper builds");

  const buildUrl = `${PAPER_API_BASE_URL}/v2/projects/paper/versions/${encodeURIComponent(mc)}/builds/${encodeURIComponent(String(build))}`;
  const { res: res2, json: json2 } = await fetchJsonWithTimeout(buildUrl, { headers: { "User-Agent": "ElegantMC Panel" } }, 15_000);
  if (!res2.ok) throw new Error(json2?.error || json2?.message || `fetch failed: ${res2.status}`);

  const name = String(json2?.downloads?.application?.name || "").trim();
  const sha256 = String(json2?.downloads?.application?.sha256 || "").trim().toLowerCase();
  if (!name) throw new Error("paper download name missing");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("paper sha256 missing");

  const jarUrl = `${PAPER_API_BASE_URL}/v2/projects/paper/versions/${encodeURIComponent(mc)}/builds/${encodeURIComponent(String(build))}/downloads/${encodeURIComponent(name)}`;
  return { mc, build, name, url: jarUrl, sha256 };
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

    if (url.pathname === "/api/updates/check" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      if (!updateCheckEnabled) return json(res, 400, { error: "update check disabled" });
      if (!updateCheckURL) return json(res, 400, { error: "update check not configured" });

      const force = String(url.searchParams.get("force") || "").trim() === "1";
      const now = nowUnix();
      if (!force && updateCache.result && now - (updateCache.atUnix || 0) < UPDATE_CACHE_TTL_SEC) {
        return json(res, 200, updateCache.result);
      }

      try {
        const { res: upRes, json: upJson } = await fetchJsonWithTimeout(
          updateCheckURL,
          { headers: { "User-Agent": "ElegantMC Panel", Accept: "application/vnd.github+json" } },
          12_000
        );
        if (!upRes.ok) throw new Error(upJson?.message || `fetch failed: ${upRes.status}`);
        const latest = String(upJson?.tag_name || upJson?.name || "").trim();
        const releaseUrl = String(upJson?.html_url || upJson?.url || "").trim();
        if (!latest) throw new Error("latest version missing");

        const assets = Array.isArray(upJson?.assets)
          ? upJson.assets
              .slice(0, 60)
              .map((a) => ({
                name: String(a?.name || ""),
                url: String(a?.browser_download_url || ""),
                size: Number(a?.size || 0) || null,
              }))
              .filter((a) => a.name && a.url)
          : [];

        const panelCurrent = String(process.env.ELEGANTMC_VERSION || "dev");
        const panelCmp = compareSemverLike(panelCurrent, latest);
        const panelUpdate = panelCmp === -1;

        const daemonNodes = Array.from(state.daemons.values()).map((d) => {
          const cur = String(d?.hello?.version || "").trim();
          const cmp = compareSemverLike(cur, latest);
          const outdated = cmp === -1;
          return {
            id: d.id,
            connected: !!d.connected,
            current: cur || null,
            outdated,
            comparable: cmp != null,
          };
        });
        daemonNodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const outdatedCount = daemonNodes.filter((x) => x.outdated).length;

        const result = {
          checked_at_unix: now,
          source: {
            repo: updateRepo || null,
            url: updateCheckURL,
          },
          latest: { version: latest, url: releaseUrl || null, assets },
          panel: {
            current: panelCurrent,
            update_available: panelUpdate,
            comparable: panelCmp != null,
          },
          daemons: {
            outdated_count: outdatedCount,
            nodes: daemonNodes,
          },
        };

        updateCache = { atUnix: now, result, error: "" };
        appendAudit(req, "updates.check", { latest, panel_current: panelCurrent, outdated_daemons: outdatedCount });
        return json(res, 200, result);
      } catch (e) {
        const msg = String(e?.message || e);
        updateCache = { atUnix: now, result: null, error: msg };
        return json(res, 502, { error: msg });
      }
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const auth = getAuth(req);
      if (!auth) return json(res, 401, { authed: false });
      await loadUsersFromDisk();
      const u = auth?.user_id ? getUserByID(String(auth.user_id || "").trim()) : null;
      return json(res, 200, {
        authed: true,
        via: auth.kind,
        user_id: String(auth.user_id || ""),
        username: String(auth.username || ""),
        totp_enabled: !!u?.totp?.enabled,
        csrf_token: auth.kind === "session" ? String(auth?.csrf_token || "") : "",
      });
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      try {
        await loadUsersFromDisk();
        let admin = getUserByUsername("admin");
        if (!admin) admin = ensureDefaultAdminUser(bootstrapAdminPassword);

        if (!checkLoginRateLimit(req, res, { touchUser: false })) return;
        const body = await readJsonBody(req);
        const usernameRaw = body?.username ?? body?.user ?? "";
        const userKey = usernameRaw ? String(usernameRaw).trim() : "admin";
        if (!checkLoginRateLimit(req, res, { touchIP: false, userKey })) return;
        const username = usernameRaw ? normalizeUsername(usernameRaw) : "admin";
        const password = String(body?.password || "");

        const u = getUserByUsername(username);
        if (!u) {
          appendAudit(req, "auth.login_failed", { reason: "invalid_credentials", username });
          return json(res, 401, { error: "invalid credentials" });
        }
        if (!verifyPassword(password, u.pw_salt_b64, u.pw_hash_b64)) {
          appendAudit(req, "auth.login_failed", { reason: "invalid_credentials", username });
          return json(res, 401, { error: "invalid credentials" });
        }

        let usedRecovery = false;
        let recoveryRemaining = 0;
        if (u?.totp?.enabled) {
          const totpCode = String(body?.totp_code ?? body?.totp ?? body?.code ?? body?.otp ?? "").trim();
          const recoveryCode = String(body?.recovery_code ?? body?.recovery ?? "").trim();

          if (!totpCode && !recoveryCode) {
            appendAudit(req, "auth.login_failed", { reason: "2fa_required", username });
            return json(res, 401, { error: "2fa required", needs_2fa: true });
          }

          let ok2fa = false;
          if (totpCode && totpVerify(u.totp.secret_b32, totpCode, { window: 1, stepSec: 30, digits: 6 })) {
            ok2fa = true;
          } else if (recoveryCode) {
            const h = hashRecoveryCode(recoveryCode);
            const recs = Array.isArray(u?.totp?.recovery) ? u.totp.recovery : [];
            const idx = recs.findIndex((r) => String(r?.hash_b64 || "").trim() === h && !(Number(r?.used_at_unix || 0) > 0));
            if (idx >= 0) {
              ok2fa = true;
              usedRecovery = true;
              const now = nowUnix();
              const nextRecs = recs.map((r, i) => (i === idx ? { ...r, used_at_unix: now } : r));
              users = (Array.isArray(users) ? users : []).map((x) => {
                if (String(x?.id || "") !== String(u.id || "")) return x;
                return { ...x, totp: { ...(x.totp || {}), recovery: nextRecs, updated_at_unix: now }, updated_at_unix: now };
              });
              await queueUsersSave();
              recoveryRemaining = nextRecs.filter((r) => !(Number(r?.used_at_unix || 0) > 0)).length;
            } else {
              recoveryRemaining = recs.filter((r) => !(Number(r?.used_at_unix || 0) > 0)).length;
            }
          }

          if (!ok2fa) {
            appendAudit(req, "auth.login_failed", { reason: "invalid_2fa", username });
            return json(res, 401, { error: "invalid 2fa code", needs_2fa: true });
          }
        }

        const token = randomBytes(24).toString("base64url");
        const csrf_token = randomBytes(18).toString("base64url");
        const now = nowUnix();
        const ip = String(getClientIP(req) || "").trim().slice(0, 64);
        const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : "";
        const uaNorm = String(ua || "").replace(/[\r\n]+/g, " ").trim().slice(0, 256);
        sessions.set(token, {
          expiresAtUnix: now + SESSION_TTL_SEC,
          createdAtUnix: now,
          lastSeenAtUnix: now,
          csrf_token,
          ...(ip ? { ip } : {}),
          ...(uaNorm ? { ua: uaNorm } : {}),
          user_id: u.id,
          username: u.username,
        });
        queueSessionsSave();
        appendAudit(req, "auth.login_ok", { token: maskToken(token), username: u.username });
        loginAttempts.delete(getClientIP(req) || "unknown");
        loginAttemptsByUser.delete(String(u.username || "").trim().toLowerCase());

        const cookieValue = encodeSessionCookieValue(token);
        if (!cookieValue) throw new Error("failed to encode session cookie");
        res.setHeader(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, cookieValue, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: "Lax",
            path: "/",
            maxAge: SESSION_TTL_SEC,
          })
        );
        return json(res, 200, {
          authed: true,
          via: "session",
          user_id: u.id,
          username: u.username,
          totp_enabled: !!u?.totp?.enabled,
          csrf_token,
          ...(usedRecovery ? { used_recovery: true, recovery_remaining: recoveryRemaining } : {}),
        });
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

    if (url.pathname === "/api/auth/sessions" && req.method === "GET") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      const now = nowUnix();
      const list = [];
      for (const [token, s] of sessions.entries()) {
        const expiresAtUnix = Number(s?.expiresAtUnix || 0);
        if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= now) continue;
        const createdAtUnix = Number(s?.createdAtUnix || 0);
        const lastSeenAtUnix = Number(s?.lastSeenAtUnix || 0);
        const user_id = String(s?.user_id || "").trim();
        const username = String(s?.username || "").trim();
        const ip = String(s?.ip || "").trim().slice(0, 64);
        const ua = String(s?.ua || "").trim().slice(0, 256);
        list.push({
          id: sessionID(token),
          token_masked: maskToken(token),
          user_id: user_id || null,
          username: username || null,
          created_at_unix: Number.isFinite(createdAtUnix) && createdAtUnix > 0 ? createdAtUnix : null,
          last_seen_at_unix:
            Number.isFinite(lastSeenAtUnix) && lastSeenAtUnix > 0
              ? lastSeenAtUnix
              : Number.isFinite(createdAtUnix) && createdAtUnix > 0
                ? createdAtUnix
                : null,
          ip: ip || null,
          user_agent: ua || null,
          expires_at_unix: expiresAtUnix,
          current: token === session.token,
        });
      }
      list.sort((a, b) => Number(b.expires_at_unix || 0) - Number(a.expires_at_unix || 0));
      return json(res, 200, { sessions: list });
    }

    if (url.pathname === "/api/auth/sessions/revoke" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        const body = await readJsonBody(req);
        const id = String(body?.id || body?.session_id || "").trim();
        if (!id) return json(res, 400, { error: "id is required" });
        let revoked = false;
        for (const [token] of sessions.entries()) {
          if (sessionID(token) !== id) continue;
          sessions.delete(token);
          revoked = true;
          appendAudit(req, "auth.sessions_revoke", { id, token: maskToken(token) });
          if (token === session.token) {
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
          }
          break;
        }
        if (revoked) queueSessionsSave();
        return json(res, 200, { revoked });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/sessions/revoke-all" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        const body = await readJsonBody(req);
        const keepCurrent = body?.keep_current === false ? false : true;
        let count = 0;
        for (const [token] of sessions.entries()) {
          if (keepCurrent && token === session.token) continue;
          sessions.delete(token);
          count++;
        }
        if (count) {
          queueSessionsSave();
          appendAudit(req, "auth.sessions_revoke_all", { keep_current: keepCurrent, revoked: count });
        }
        if (!keepCurrent) {
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
        }
        return json(res, 200, { revoked: count, keep_current: keepCurrent });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/audit" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      const limitRaw = Number(url.searchParams.get("limit") || 200);
      const limit = Math.max(1, Math.min(1000, Math.round(Number.isFinite(limitRaw) ? limitRaw : 200)));
      const maxBytesRaw = Number(url.searchParams.get("max_bytes") || 900_000);
      const maxBytes = Math.max(80_000, Math.min(2_000_000, Math.round(Number.isFinite(maxBytesRaw) ? maxBytesRaw : 900_000)));

      const sinceRaw = Number(url.searchParams.get("since_unix") || 0);
      const untilRaw = Number(url.searchParams.get("until_unix") || 0);
      const sinceUnix = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const untilUnix = Number.isFinite(untilRaw) && untilRaw > 0 ? Math.floor(untilRaw) : 0;
      const actionQ = String(url.searchParams.get("action") || "").trim().toLowerCase();
      const userQ = String(url.searchParams.get("user") || "").trim().toLowerCase();
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();

      let truncated = false;
      const entries = [];

      try {
        const st = await fs.stat(AUDIT_LOG_PATH);
        const start = Math.max(0, Number(st?.size || 0) - maxBytes);
        truncated = start > 0;

        let fh = null;
        try {
          fh = await fs.open(AUDIT_LOG_PATH, "r");
          const len = Math.max(0, Number(st?.size || 0) - start);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, start);
          const text = buf.toString("utf8");
          let lines = text.split(/\r?\n/);
          if (start > 0) lines = lines.slice(1); // drop partial line

          for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
            const line = String(lines[i] || "").trim();
            if (!line) continue;
            const entry = safeJsonParse(line);
            if (!entry || typeof entry !== "object") continue;

            const ts = Number(entry?.ts_unix || 0);
            if (sinceUnix > 0 && Number.isFinite(ts) && ts > 0 && ts < sinceUnix) break;
            if (untilUnix > 0 && Number.isFinite(ts) && ts > untilUnix) continue;

            const action = String(entry?.action || "");
            const user = String(entry?.user || "");
            if (actionQ && !action.toLowerCase().includes(actionQ)) continue;
            if (userQ && !user.toLowerCase().includes(userQ)) continue;

            if (q) {
              const ip = String(entry?.ip || "");
              const auth = String(entry?.auth || "");
              const session = String(entry?.session || "");
              const tokenID = String(entry?.token_id || "");
              const detailStr = JSON.stringify(entry?.detail || {});
              const hay = `${action} ${user} ${ip} ${auth} ${session} ${tokenID} ${detailStr}`.toLowerCase();
              if (!hay.includes(q)) continue;
            }

            entries.push(entry);
          }
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {
              // ignore
            }
          }
        }
      } catch (e) {
        if (e?.code !== "ENOENT") return json(res, 500, { error: String(e?.message || e) });
      }

      return json(res, 200, { entries, truncated });
    }

    if (url.pathname === "/api/auth/users" && req.method === "GET") {
      if (!requireSessionAdmin(req, res)) return;
      await loadUsersFromDisk();
      const list = (Array.isArray(users) ? users : []).map((u) => ({
        id: String(u?.id || ""),
        username: String(u?.username || ""),
        created_at_unix: Number(u?.created_at_unix || 0) || null,
        updated_at_unix: Number(u?.updated_at_unix || 0) || null,
        totp_enabled: !!u?.totp?.enabled,
      }));
      list.sort((a, b) => String(a.username).localeCompare(String(b.username)));
      return json(res, 200, { users: list });
    }

    if (url.pathname === "/api/auth/users/create" && req.method === "POST") {
      if (!requireSessionAdmin(req, res)) return;
      try {
        await loadUsersFromDisk();
        const body = await readJsonBody(req);
        const username = normalizeUsername(body?.username || body?.user || "");
        const password = String(body?.password || "");
        if (password.length < 8) return json(res, 400, { error: "password too short (min 8)" });
        if (getUserByUsername(username)) return json(res, 400, { error: "username already exists" });
        const now = nowUnix();
        const id = randomBytes(12).toString("base64url");
        const h = hashPassword(password);
        const u = { id, username, ...h, created_at_unix: now, updated_at_unix: now };
        users = [...(Array.isArray(users) ? users : []), u];
        await queueUsersSave();
        appendAudit(req, "auth.users_create", { username });
        return json(res, 200, { user: { id, username, created_at_unix: now, updated_at_unix: now } });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/users/delete" && req.method === "POST") {
      if (!requireSessionAdmin(req, res)) return;
      try {
        await loadUsersFromDisk();
        const body = await readJsonBody(req);
        const id = String(body?.id || body?.user_id || "").trim();
        if (!id) return json(res, 400, { error: "id is required" });
        if ((Array.isArray(users) ? users : []).length <= 1) return json(res, 400, { error: "refuse to delete last user" });
        const u = getUserByID(id);
        if (!u) return json(res, 404, { error: "user not found" });
        users = (Array.isArray(users) ? users : []).filter((x) => String(x?.id || "") !== id);
        await queueUsersSave();
        appendAudit(req, "auth.users_delete", { username: u.username });

        // Revoke sessions for that user.
        const cur = getSession(req);
        let revoked = 0;
        for (const [tok, s] of sessions.entries()) {
          if (String(s?.user_id || "") !== id) continue;
          sessions.delete(tok);
          revoked++;
        }
        if (revoked) queueSessionsSave();
        if (cur?.token && String(cur?.user_id || "") === id) {
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
        }

        return json(res, 200, { deleted: true, revoked_sessions: revoked });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/users/set-password" && req.method === "POST") {
      if (!requireSessionAdmin(req, res)) return;
      try {
        await loadUsersFromDisk();
        const body = await readJsonBody(req);
        const id = String(body?.id || body?.user_id || "").trim();
        const password = String(body?.password || "");
        if (!id) return json(res, 400, { error: "id is required" });
        if (password.length < 8) return json(res, 400, { error: "password too short (min 8)" });
        const u = getUserByID(id);
        if (!u) return json(res, 404, { error: "user not found" });
        const now = nowUnix();
        const h = hashPassword(password);
        users = (Array.isArray(users) ? users : []).map((x) => {
          if (String(x?.id || "") !== id) return x;
          return { ...x, ...h, updated_at_unix: now };
        });
        await queueUsersSave();
        appendAudit(req, "auth.users_set_password", { username: u.username });

        // Revoke sessions for that user.
        const cur = getSession(req);
        let revoked = 0;
        for (const [tok, s] of sessions.entries()) {
          if (String(s?.user_id || "") !== id) continue;
          sessions.delete(tok);
          revoked++;
        }
        if (revoked) queueSessionsSave();
        if (cur?.token && String(cur?.user_id || "") === id) {
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
        }

        return json(res, 200, { ok: true, revoked_sessions: revoked });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/totp/begin" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        await loadUsersFromDisk();
        const u = getUserByID(String(session?.user_id || "").trim());
        if (!u) return json(res, 404, { error: "user not found" });
        if (u?.totp?.enabled) return json(res, 400, { error: "2fa already enabled" });

        const secret_b32 = base32Encode(randomBytes(20));
        const otpauth_uri = makeOtpAuthURI({ username: u.username, issuer: "ElegantMC", secretB32: secret_b32 });
        appendAudit(req, "auth.totp_begin", { username: u.username });
        return json(res, 200, { secret_b32, otpauth_uri });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/totp/enable" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        await loadUsersFromDisk();
        const body = await readJsonBody(req);
        const secret_b32 = String(body?.secret_b32 || body?.secret || "").trim().toUpperCase().replace(/[^A-Z2-7]/g, "");
        const code = String(body?.totp_code ?? body?.code ?? body?.otp ?? "").trim();
        if (!secret_b32) return json(res, 400, { error: "secret_b32 is required" });
        if (!code) return json(res, 400, { error: "code is required" });

        const u = getUserByID(String(session?.user_id || "").trim());
        if (!u) return json(res, 404, { error: "user not found" });
        if (u?.totp?.enabled) return json(res, 400, { error: "2fa already enabled" });
        if (!totpVerify(secret_b32, code, { window: 1, stepSec: 30, digits: 6 })) return json(res, 400, { error: "invalid code" });

        const recovery_codes = generateRecoveryCodes(10);
        const now = nowUnix();
        const recovery = recovery_codes.map((c) => ({ hash_b64: hashRecoveryCode(c), used_at_unix: 0 }));
        users = (Array.isArray(users) ? users : []).map((x) => {
          if (String(x?.id || "") !== String(u.id || "")) return x;
          return {
            ...x,
            totp: { enabled: true, secret_b32, created_at_unix: now, updated_at_unix: now, recovery },
            updated_at_unix: now,
          };
        });
        await queueUsersSave();

        // Revoke other sessions for the user, rotate current session token.
        const curTok = String(session?.token || "").trim();
        let revoked = 0;
        for (const [tok, s] of sessions.entries()) {
          if (String(s?.user_id || "") !== String(u.id || "")) continue;
          if (tok === curTok) continue;
          sessions.delete(tok);
          revoked++;
        }
        if (curTok) sessions.delete(curTok);

        const newTok = randomBytes(24).toString("base64url");
        const ip = String(getClientIP(req) || "").trim().slice(0, 64);
        const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : "";
        const uaNorm = String(ua || "").replace(/[\r\n]+/g, " ").trim().slice(0, 256);
        sessions.set(newTok, {
          expiresAtUnix: now + SESSION_TTL_SEC,
          createdAtUnix: now,
          lastSeenAtUnix: now,
          ...(ip ? { ip } : {}),
          ...(uaNorm ? { ua: uaNorm } : {}),
          user_id: u.id,
          username: u.username,
        });
        queueSessionsSave();

        res.setHeader(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, encodeSessionCookieValue(newTok), {
            httpOnly: true,
            secure: secureCookie,
            sameSite: "Lax",
            path: "/",
            maxAge: SESSION_TTL_SEC,
          })
        );

        appendAudit(req, "auth.totp_enable", { username: u.username, revoked_sessions: revoked });
        return json(res, 200, { enabled: true, revoked_sessions: revoked, recovery_codes });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/totp/disable" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        await loadUsersFromDisk();
        const body = await readJsonBody(req);
        const targetID = String(body?.user_id || body?.id || session?.user_id || "").trim();
        if (!targetID) return json(res, 400, { error: "user_id is required" });
        const u = getUserByID(targetID);
        if (!u) return json(res, 404, { error: "user not found" });
        if (!u?.totp?.enabled) return json(res, 200, { disabled: true, revoked_sessions: 0 });

        const now = nowUnix();
        users = (Array.isArray(users) ? users : []).map((x) => {
          if (String(x?.id || "") !== String(u.id || "")) return x;
          const next = { ...x };
          delete next.totp;
          return { ...next, updated_at_unix: now };
        });
        await queueUsersSave();

        // Revoke sessions for that user (keep current if disabling self).
        const curTok = String(session?.token || "").trim();
        let revoked = 0;
        for (const [tok, s] of sessions.entries()) {
          if (String(s?.user_id || "") !== String(u.id || "")) continue;
          if (tok === curTok && String(session?.user_id || "") === String(u.id || "")) continue;
          sessions.delete(tok);
          revoked++;
        }
        if (revoked) queueSessionsSave();
        appendAudit(req, "auth.totp_disable", { username: u.username, revoked_sessions: revoked });
        return json(res, 200, { disabled: true, revoked_sessions: revoked });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/secret/rotate" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      if (panelSecretManagedByEnv) return json(res, 400, { error: "panel secret is managed by env; rotation disabled" });
      try {
        await ensurePanelSecret();
        const b64 = randomBytes(32).toString("base64");
        setPanelSecretFromB64(b64, { managedByEnv: false });
        const payload = JSON.stringify({ created_at_unix: nowUnix(), updated_at_unix: nowUnix(), secret_b64: b64 }, null, 2);
        await writeFileAtomic(PANEL_SECRET_PATH, payload);

        const count = sessions.size;
        sessions.clear();
        queueSessionsSave();

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

        appendAudit(req, "auth.secret_rotate", { invalidated_sessions: count });
        return json(res, 200, { rotated: true, invalidated_sessions: count });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/api-tokens" && req.method === "GET") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      await loadApiTokensFromDisk();
      const userID = String(session?.user_id || "").trim();
      const list = (Array.isArray(apiTokens) ? apiTokens : [])
        .filter((t) => String(t?.user_id || "").trim() === userID)
        .map((t) => ({
          id: String(t?.id || ""),
          name: String(t?.name || ""),
          created_at_unix: Number(t?.created_at_unix || 0) || null,
          last_used_at_unix: Number(t?.last_used_at_unix || 0) || null,
          fingerprint: String(t?.token_hash_b64 || "").trim().slice(0, 10),
        }));
      list.sort((a, b) => Number(b.created_at_unix || 0) - Number(a.created_at_unix || 0));
      return json(res, 200, { tokens: list });
    }

    if (url.pathname === "/api/auth/api-tokens/create" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        await loadApiTokensFromDisk();
        const body = await readJsonBody(req);
        const name = normalizeTokenName(body?.name || body?.label || body?.title || "");
        const tokenValue = `emc_${randomBytes(24).toString("base64url")}`;
        const token_hash_b64 = hashApiTokenValue(tokenValue);
        if (!token_hash_b64) throw new Error("failed to generate token");
        const now = nowUnix();
        const id = randomBytes(12).toString("base64url");
        const rec = {
          id,
          user_id: String(session?.user_id || ""),
          name,
          token_hash_b64,
          created_at_unix: now,
          last_used_at_unix: 0,
        };
        apiTokens = [...(Array.isArray(apiTokens) ? apiTokens : []), rec];
        rebuildApiTokenIndex();
        await queueApiTokensSave();
        appendAudit(req, "auth.api_tokens_create", { name });
        return json(res, 200, { token: tokenValue, id, name });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/auth/api-tokens/revoke" && req.method === "POST") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "unauthorized" });
      try {
        await loadApiTokensFromDisk();
        const body = await readJsonBody(req);
        const id = String(body?.id || "").trim();
        if (!id) return json(res, 400, { error: "id is required" });
        const userID = String(session?.user_id || "").trim();
        const before = (Array.isArray(apiTokens) ? apiTokens : []).length;
        apiTokens = (Array.isArray(apiTokens) ? apiTokens : []).filter((t) => {
          if (String(t?.id || "").trim() !== id) return true;
          return String(t?.user_id || "").trim() !== userID;
        });
        const deleted = before - apiTokens.length;
        rebuildApiTokenIndex();
        if (deleted) {
          await queueApiTokensSave();
          appendAudit(req, "auth.api_tokens_revoke", { id });
        }
        return json(res, 200, { revoked: deleted > 0 });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      const open =
        url.pathname === "/api/mc/versions" ||
        url.pathname === "/api/config" ||
        url.pathname === "/api/changelog" ||
        url.pathname === "/api/docs" ||
        url.pathname === "/api/auth/login" ||
        url.pathname === "/api/auth/me";
      if (open) {
        // ok
      } else if (url.pathname.startsWith("/api/auth/")) {
        if (!requireSessionAdmin(req, res)) return;
      } else {
        if (!requireAdmin(req, res)) return;
      }

      if (!open) {
        if (!requireCSRF(req, res)) return;
      }
    }

    if (url.pathname === "/api/ui/prefs" && req.method === "GET") {
      return json(res, 200, { prefs: serializeUiPrefs() });
    }
    if (url.pathname === "/api/ui/prefs" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const themeMode = normalizeThemeMode((body?.theme_mode ?? body?.theme ?? uiPrefs?.theme_mode) || "auto");
        const density = normalizeDensity((body?.density ?? body?.ui_density ?? uiPrefs?.density) || "comfortable");
        uiPrefs = { ...uiPrefs, theme_mode: themeMode, density };
        queueUiPrefsSave();
        appendAudit(req, "ui_prefs.save", { theme_mode: themeMode, density });
        return json(res, 200, { prefs: serializeUiPrefs() });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/changelog" && req.method === "GET") {
      try {
        const out = await readChangelogText();
        const latest = extractLatestChangelogSection(out.text);
        return json(res, 200, {
          path: path.relative(process.cwd(), out.fp),
          latest,
          full: String(out.text || "").trim(),
        });
      } catch (e) {
        return json(res, 404, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/docs" && req.method === "GET") {
      const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
      try {
        const out = await readDocText(name);
        return json(res, 200, {
          name: out.name,
          title: out.title,
          path: path.relative(process.cwd(), out.fp),
          text: String(out.text || "").trim(),
        });
      } catch (e) {
        return json(res, 404, { error: String(e?.message || e) });
      }
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

    if (url.pathname === "/api/mc/paper/jar" && req.method === "GET") {
      const mc = String(url.searchParams.get("mc") || "").trim();
      const build = Number(url.searchParams.get("build") || "0");
      try {
        const resolved = await paperResolveJar(mc, build);
        return json(res, 200, resolved);
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/api/mc/purpur/jar" && req.method === "GET") {
      const mc = String(url.searchParams.get("mc") || "").trim();
      const build = Number(url.searchParams.get("build") || "0");
      try {
        const resolved = await purpurResolveJar(mc, build);
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

    const mInstHist = url.pathname.match(/^\/api\/daemons\/([^/]+)\/instances\/([^/]+)\/history$/);
    if (mInstHist && req.method === "GET") {
      const daemonId = decodeURIComponent(mInstHist[1]);
      const instanceId = decodeURIComponent(mInstHist[2]);
      const d = state.daemons.get(daemonId);
      if (!d) return json(res, 404, { error: "not found" });
      const rangeSec = Math.max(0, Math.min(24 * 60 * 60, Number(url.searchParams.get("range_sec") || "0")));
      const list = Array.isArray(d?.instanceHistory?.[instanceId]) ? d.instanceHistory[instanceId] : [];
      if (!rangeSec) return json(res, 200, { daemon_id: daemonId, instance_id: instanceId, history: list });
      const now = nowUnix();
      const filtered = list.filter((p) => typeof p?.ts_unix === "number" && p.ts_unix >= now - rangeSec);
      return json(res, 200, { daemon_id: daemonId, instance_id: instanceId, history: filtered });
    }

    const mDaemon = url.pathname.match(/^\/api\/daemons\/([^/]+)(?:\/(logs|command|advanced-command))?$/);
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

      if (suffix === "advanced-command" && req.method === "POST") {
        if (!enableAdvanced) return json(res, 404, { error: "not found" });
        const body = await readJsonBody(req);
        const name = body?.name;
        const args = body?.args ?? {};
        if (!name || typeof name !== "string") {
          return json(res, 400, { error: "name is required" });
        }
        if (!isAllowedAdvancedCommand(name)) {
          return json(res, 403, { error: "command not allowed by server policy" });
        }
        const timeoutMs = Number(body?.timeoutMs || 30_000);
        try {
          const result = await sendCommand(daemonId, { name, args }, { timeoutMs });
          appendAudit(req, "daemon.advanced_command", {
            daemon_id: daemonId,
            name,
            args,
            timeout_ms: timeoutMs,
            ok: !!result?.ok,
            error: String(result?.error || ""),
          });
          return json(res, 200, { result });
        } catch (e) {
          appendAudit(req, "daemon.advanced_command_failed", {
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
