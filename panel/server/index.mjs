import http from "node:http";
import net from "node:net";
import path from "node:path";
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
  handleDaemonMessage,
  listFrpProfiles,
  listNodes,
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

const host = process.env.ELEGANTMC_PANEL_HOST || "0.0.0.0";
const port = Number(process.env.ELEGANTMC_PANEL_PORT || "3000");

const dev = process.env.NODE_ENV !== "production";
const secureCookie = String(process.env.ELEGANTMC_PANEL_SECURE_COOKIE || "").trim() === "1";

const SESSION_COOKIE = "elegantmc_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const sessions = new Map(); // token -> { expiresAtUnix }

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

function getSession(req) {
  const cookies = parseCookies(req);
  const token = String(cookies?.[SESSION_COOKIE] || "").trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAtUnix && now > session.expiresAtUnix) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAdmin(req, res) {
  if (getSession(req)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(__dirname, "..");
const nextApp = next({ dev, dir: panelDir });
const nextHandle = nextApp.getRequestHandler();

await nextApp.prepare();
await ensureReady();

let mcVersionsCache = { atUnix: 0, versions: null, error: "" };
async function getMcVersions() {
  const now = Math.floor(Date.now() / 1000);
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

async function getFrpStatuses(profiles) {
  const now = Math.floor(Date.now() / 1000);
  const stale = [];

  for (const p of profiles) {
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

    if (url.pathname === "/healthz") {
      return text(res, 200, "ok");
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const ok = !!getSession(req);
      return ok ? json(res, 200, { authed: true }) : json(res, 401, { authed: false });
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const password = String(body?.password || "");
        if (!safeEqual(password, adminPassword)) {
          return json(res, 401, { error: "invalid password" });
        }
        const token = randomBytes(24).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        sessions.set(token, { expiresAtUnix: now + SESSION_TTL_SEC });
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
      if (session?.token) sessions.delete(session.token);
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
      const open = url.pathname === "/api/mc/versions" || url.pathname.startsWith("/api/auth/");
      if (!open && !requireAdmin(req, res)) return;
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

    if (url.pathname === "/api/frp/profiles" && req.method === "GET") {
      const profiles = await listFrpProfiles();
      const statuses = await getFrpStatuses(profiles);
      const out = profiles.map((p) => ({
        ...p,
        status: statuses.get(p.id) || { checkedAtUnix: 0, online: null, latencyMs: 0, error: "" },
      }));
      return json(res, 200, { profiles: out });
    }
    if (url.pathname === "/api/frp/profiles" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const profile = await createFrpProfile(body);
        return json(res, 200, { profile });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }
    const mFrp = url.pathname.match(/^\/api\/frp\/profiles\/([^/]+)$/);
    if (mFrp && req.method === "DELETE") {
      const id = decodeURIComponent(mFrp[1]);
      const ok = await deleteFrpProfile(id);
      if (!ok) return json(res, 404, { error: "not found" });
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
          token,
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
        return json(res, 200, { node });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e) });
      }
    }
    const mNode = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
    if (mNode && req.method === "DELETE") {
      const id = decodeURIComponent(mNode[1]);
      const ok = await deleteNode(id);
      if (!ok) return json(res, 404, { error: "not found" });
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
        const result = await sendCommand(
          daemonId,
          { name, args },
          { timeoutMs: Number(body?.timeoutMs || 30_000) }
        );
        return json(res, 200, { result });
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
