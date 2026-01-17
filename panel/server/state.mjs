import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_LOG_LINES = 2000;
const MAX_HB_POINTS = 600;
const FRP_MAX_PROFILES = 50;
const DAEMON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const PANEL_DATA_DIR = process.env.ELEGANTMC_PANEL_DATA_DIR
  ? path.resolve(process.env.ELEGANTMC_PANEL_DATA_DIR)
  : path.resolve(process.cwd(), ".elegantmc-panel");
const FRP_PROFILES_PATH = path.join(PANEL_DATA_DIR, "frp_profiles.json");
const DAEMON_TOKENS_PATH = path.join(PANEL_DATA_DIR, "daemon_tokens.json");

let frpLoaded = false;
let frpWriteChain = Promise.resolve();

let tokensLoaded = false;
let tokensWriteChain = Promise.resolve();

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const state = {
  daemons: new Map(),
  connections: new Map(),
  pending: new Map(), // commandId -> { resolve, reject, timeout }
  frpProfiles: [],
  daemonTokens: {},
};

async function ensureTokensLoaded() {
  if (tokensLoaded) return;
  await fs.mkdir(PANEL_DATA_DIR, { recursive: true });

  // Prefer file; fallback to env (for first boot).
  try {
    const raw = await fs.readFile(DAEMON_TOKENS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      state.daemonTokens = parsed;
    } else {
      state.daemonTokens = {};
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load daemon tokens:", e?.message || e);
    }
    state.daemonTokens = {};
  }

  if (!Object.keys(state.daemonTokens).length) {
    const rawEnv = process.env.ELEGANTMC_DAEMON_TOKENS_JSON;
    if (rawEnv) {
      try {
        const parsed = JSON.parse(rawEnv);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          state.daemonTokens = parsed;
          await writeFileAtomic(DAEMON_TOKENS_PATH, JSON.stringify(state.daemonTokens, null, 2));
        }
      } catch {
        // ignore
      }
    }
  }

  tokensLoaded = true;
}

function queueTokensSave() {
  tokensWriteChain = tokensWriteChain.then(async () => {
    await ensureTokensLoaded();
    const payload = JSON.stringify(state.daemonTokens, null, 2);
    await writeFileAtomic(DAEMON_TOKENS_PATH, payload);
  });
  return tokensWriteChain;
}

function normalizeDaemonId(id) {
  const v = String(id || "").trim();
  if (!v) throw new Error("id is required");
  if (!DAEMON_ID_RE.test(v)) throw new Error("invalid id (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,63})");
  return v;
}

function normalizeToken(token) {
  const v = String(token || "").trim();
  if (!v) throw new Error("token is required");
  if (v.length > 256) throw new Error("token too long");
  return v;
}

export async function ensureReady() {
  await ensureTokensLoaded();
  await ensureFrpLoaded();
}

export function getDaemonTokenSync(id) {
  return state.daemonTokens?.[id] || "";
}

export async function listNodes() {
  await ensureTokensLoaded();
  return Object.keys(state.daemonTokens).sort().map((id) => ({ id }));
}

export async function createNode(input) {
  await ensureTokensLoaded();
  const id = normalizeDaemonId(input?.id);
  if (state.daemonTokens[id]) {
    throw new Error("node already exists (delete it first to rotate token)");
  }
  let token = String(input?.token ?? "").trim();
  if (!token) {
    token = randomUUID().replace(/-/g, "");
  }
  token = normalizeToken(token);
  state.daemonTokens[id] = token;
  await queueTokensSave();
  return { id, token };
}

export async function deleteNode(id) {
  await ensureTokensLoaded();
  id = normalizeDaemonId(id);
  if (!state.daemonTokens[id]) return false;
  delete state.daemonTokens[id];
  await queueTokensSave();
  return true;
}

async function ensureFrpLoaded() {
  if (frpLoaded) return;
  await fs.mkdir(PANEL_DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(FRP_PROFILES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.frpProfiles = parsed;
    } else {
      state.frpProfiles = [];
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[panel] failed to load frp profiles:", e?.message || e);
    }
    state.frpProfiles = [];
  }
  frpLoaded = true;
}

async function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

function queueFrpSave() {
  frpWriteChain = frpWriteChain.then(async () => {
    await ensureFrpLoaded();
    const payload = JSON.stringify(state.frpProfiles, null, 2);
    await writeFileAtomic(FRP_PROFILES_PATH, payload);
  });
  return frpWriteChain;
}

function normalizeFrpProfileInput(input) {
  const name = String(input?.name ?? "").trim();
  const serverAddr = String(input?.server_addr ?? "").trim();
  const serverPort = Number(input?.server_port ?? 0);
  const token = String(input?.token ?? "").trim();

  if (!name) throw new Error("name is required");
  if (name.length > 64) throw new Error("name too long");
  if (!serverAddr) throw new Error("server_addr is required");
  if (serverAddr.length > 255) throw new Error("server_addr too long");
  if (!Number.isFinite(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error("server_port invalid");
  if (token.length > 256) throw new Error("token too long");

  return { name, server_addr: serverAddr, server_port: serverPort, token };
}

export async function listFrpProfiles() {
  await ensureFrpLoaded();
  return state.frpProfiles;
}

export async function createFrpProfile(input) {
  await ensureFrpLoaded();
  if (state.frpProfiles.length >= FRP_MAX_PROFILES) {
    throw new Error("too many profiles");
  }

  const clean = normalizeFrpProfileInput(input);
  const profile = { id: randomUUID(), created_at_unix: nowUnix(), ...clean };
  state.frpProfiles.push(profile);
  await queueFrpSave();
  return profile;
}

export async function deleteFrpProfile(id) {
  await ensureFrpLoaded();
  const idx = state.frpProfiles.findIndex((p) => p && p.id === id);
  if (idx < 0) return false;
  state.frpProfiles.splice(idx, 1);
  await queueFrpSave();
  return true;
}

export function getOrCreateDaemon(id) {
  let d = state.daemons.get(id);
  if (!d) {
    d = {
      id,
      connected: false,
      connectedAtUnix: null,
      lastSeenUnix: null,
      hello: null,
      heartbeat: null,
      history: [],
      logs: [],
    };
    state.daemons.set(id, d);
  }
  return d;
}

export function attachConnection(daemonId, ws) {
  const d = getOrCreateDaemon(daemonId);

  // Replace existing connection if any.
  const prev = state.connections.get(daemonId);
  if (prev && prev !== ws) {
    try {
      prev.close(1000, "replaced");
    } catch {
      // ignore
    }
  }

  state.connections.set(daemonId, ws);
  d.connected = true;
  d.connectedAtUnix = nowUnix();
  d.lastSeenUnix = nowUnix();

  ws.on("close", () => {
    const cur = state.connections.get(daemonId);
    if (cur === ws) {
      state.connections.delete(daemonId);
      d.connected = false;
      d.lastSeenUnix = nowUnix();
    }
  });
}

export function handleDaemonMessage(daemonId, raw) {
  const d = getOrCreateDaemon(daemonId);
  d.lastSeenUnix = nowUnix();

  const msg = typeof raw === "string" ? safeJsonParse(raw) : safeJsonParse(raw.toString("utf8"));
  if (!msg || typeof msg !== "object") return;

  const type = msg.type;
  if (type === "hello") {
    d.hello = msg.payload ?? null;
    return;
  }
  if (type === "heartbeat") {
    const hb = msg.payload ?? null;
    d.heartbeat = hb;

    const ts = Number(msg.ts_unix || nowUnix());
    const cpu = hb?.cpu?.usage_percent;
    const memTotal = hb?.mem?.total_bytes;
    const memUsed = hb?.mem?.used_bytes;
    const diskTotal = hb?.disk?.total_bytes;
    const diskUsed = hb?.disk?.used_bytes;

    d.history.push({
      ts_unix: ts,
      cpu_percent: typeof cpu === "number" ? cpu : null,
      mem_percent: memTotal ? (Number(memUsed || 0) * 100) / Number(memTotal) : null,
      disk_percent: diskTotal ? (Number(diskUsed || 0) * 100) / Number(diskTotal) : null,
    });
    if (d.history.length > MAX_HB_POINTS) {
      d.history.splice(0, d.history.length - MAX_HB_POINTS);
    }
    return;
  }
  if (type === "log") {
    const payload = msg.payload ?? {};
    d.logs.push({
      ts_unix: msg.ts_unix ?? nowUnix(),
      ...payload,
    });
    if (d.logs.length > MAX_LOG_LINES) {
      d.logs.splice(0, d.logs.length - MAX_LOG_LINES);
    }
    return;
  }
  if (type === "command_result") {
    const id = msg.id;
    if (id && state.pending.has(id)) {
      const p = state.pending.get(id);
      state.pending.delete(id);
      clearTimeout(p.timeout);
      p.resolve(msg.payload ?? null);
    }
    return;
  }
}

export function sendCommand(daemonId, command, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const ws = state.connections.get(daemonId);
  if (!ws) {
    return Promise.reject(new Error("daemon not connected"));
  }

  const cmdId = randomUUID();
  const envelope = {
    type: "command",
    id: cmdId,
    ts_unix: nowUnix(),
    payload: command,
  };

  const payloadText = JSON.stringify(envelope);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending.delete(cmdId);
      reject(new Error("command timeout"));
    }, timeoutMs);

    state.pending.set(cmdId, { resolve, reject, timeout });

    try {
      ws.send(payloadText, (err) => {
        if (err) {
          clearTimeout(timeout);
          state.pending.delete(cmdId);
          reject(err);
        }
      });
    } catch (e) {
      clearTimeout(timeout);
      state.pending.delete(cmdId);
      reject(e);
    }
  });
}
