import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, { timeoutMs = 20_000 } = {}) {
  const startedAt = Date.now();
  let lastErr = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return;
      lastErr = `status=${res.status}`;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr}`);
}

function cookieFromSetCookie(setCookie) {
  const raw = String(setCookie || "");
  const first = raw.split(";")[0] || "";
  return first.trim();
}

async function expectStatus(res, want, label) {
  if (res.status !== want) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label}: expected ${want}, got ${res.status}. body=${text.slice(0, 400)}`);
  }
}

async function main() {
  const host = "127.0.0.1";
  const port = Number(process.env.ELEGANTMC_SMOKE_PORT || "3137");
  const base = `http://${host}:${port}`;
  const adminPassword = "test-pass";

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "elegantmc-panel-smoke-"));

  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      ELEGANTMC_PANEL_HOST: host,
      ELEGANTMC_PANEL_PORT: String(port),
      ELEGANTMC_PANEL_ADMIN_PASSWORD: adminPassword,
      ELEGANTMC_PANEL_DATA_DIR: dataDir,
      ELEGANTMC_PANEL_HSTS: "0",
      ELEGANTMC_ENABLE_ADVANCED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString("utf8")));
  child.stderr.on("data", (d) => (logs += d.toString("utf8")));

  try {
    await waitFor(`${base}/healthz`, { timeoutMs: 25_000 });

    const htmlRes = await fetch(`${base}/`, { cache: "no-store" });
    await expectStatus(htmlRes, 200, "GET /");
    const html = await htmlRes.text();
    if (!html.includes("elegantmc_theme_mode")) {
      throw new Error("GET /: expected theme init script to be present");
    }

    const me0 = await fetch(`${base}/api/auth/me`, { cache: "no-store" });
    await expectStatus(me0, 401, "GET /api/auth/me (before login)");

    const badLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    await expectStatus(badLogin, 401, "POST /api/auth/login (wrong password)");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    });
    await expectStatus(login, 200, "POST /api/auth/login");
    const setCookie = login.headers.get("set-cookie");
    const cookie = cookieFromSetCookie(setCookie);
    if (!cookie.startsWith("elegantmc_session=")) {
      throw new Error(`POST /api/auth/login: missing session cookie. set-cookie=${setCookie || ""}`);
    }

    const me1 = await fetch(`${base}/api/auth/me`, { cache: "no-store", headers: { cookie } });
    await expectStatus(me1, 200, "GET /api/auth/me (after login)");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(String(e?.message || e));
    // eslint-disable-next-line no-console
    console.error("---- panel logs ----");
    // eslint-disable-next-line no-console
    console.error(logs.trim().slice(-4000));
    process.exitCode = 1;
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000)]);
    try {
      await fs.rm(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

await main();

