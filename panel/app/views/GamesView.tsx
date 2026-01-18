"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

export default function GamesView() {
  const {
    serverDirs,
    serverDirsStatus,
    refreshServerDirs,
    instanceId,
    setInstanceId,
    selectedDaemon,
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
    copyText,
    enableFrp,
    selectedProfile,
    frpRemotePort,
    setTab,
    fmtUnix,
    logView,
    setLogView,
    logs,
    consoleLine,
    setConsoleLine,
    sendConsoleLine,
    setFsPath,
  } = useAppCtx();

  const running = !!instanceStatus?.running;
  const canControl = !!selectedDaemon?.connected && !!instanceId.trim();

  const [logQuery, setLogQuery] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const preRef = useRef<HTMLPreElement | null>(null);

  const socketText = useMemo(() => {
    if (frpStatus?.running && frpStatus.remote_port) {
      return `${frpStatus.remote_addr}:${frpStatus.remote_port}`;
    }
    const ip = localHost || "127.0.0.1";
    return `${ip}:${Math.round(Number(gamePort || 25565))}`;
  }, [frpStatus, localHost, gamePort]);

  const filteredLogs = useMemo(() => {
    const inst = instanceId.trim();
    const q = logQuery.trim().toLowerCase();
    const list = (logs || []).filter((l: any) => {
      if (logView === "frp") return l.source === "frp" && (!l.instance || l.instance === inst);
      if (logView === "mc") return l.source === "mc" && l.instance === inst;
      if (logView === "install") return l.source === "install" && l.instance === inst;
      // all
      return (l.instance && l.instance === inst) || (l.source === "frp" && !l.instance);
    });
    if (!q) return list;
    return list.filter((l: any) => String(l?.line || "").toLowerCase().includes(q));
  }, [logs, logView, instanceId, logQuery]);

  const logText = useMemo(() => {
    return filteredLogs.length
      ? filteredLogs
          .slice(-400)
          .map((l: any) => {
            const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
            const src = l.source || "daemon";
            const stream = l.stream || "";
            const inst = l.instance ? `(${l.instance})` : "";
            return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
          })
          .join("\n")
      : "<no logs>";
  }, [filteredLogs]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logText, autoScroll]);

  return (
    <div className="stack">
      <div className="card">
        <h2>Game</h2>

        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>Game</label>
              <Select
                value={instanceId}
                onChange={(v) => setInstanceId(v)}
                disabled={!serverDirs.length}
                placeholder="No games installed"
                options={serverDirs.map((id: string) => ({ value: id, label: id }))}
              />
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div className="hint">
                  installed: {serverDirs.length}
                  {serverDirsStatus ? ` · ${serverDirsStatus}` : ""}
                </div>
                <button
                  type="button"
                  className="iconBtn iconOnly"
                  title="Refresh games list"
                  onClick={refreshServerDirs}
                  disabled={!selectedDaemon?.connected}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </div>
          </div>

          <div className="toolbarRight">
            <div className="btnGroup">
              <button type="button" className="iconBtn" onClick={openInstallModal} disabled={!selectedDaemon?.connected}>
                <Icon name="plus" />
                Install
              </button>
            </div>

            <div className="btnGroup">
              <button
                className={running ? "" : "primary"}
                onClick={() => (running ? stopServer() : startServer())}
                disabled={!canControl}
              >
                {running ? "Stop" : "Start"}
              </button>
              <Select
                value=""
                onChange={(v) => {
                  if (v === "restart") restartServer();
                  else if (v === "settings") openSettingsModal();
                  else if (v === "files") {
                    setFsPath(instanceId.trim());
                    setTab("files");
                  } else if (v === "delete") deleteServer();
                }}
                disabled={!selectedDaemon?.connected}
                placeholder="More"
                options={[
                  { value: "restart", label: "Restart", disabled: !canControl },
                  { value: "settings", label: "Settings", disabled: !canControl },
                  { value: "files", label: "Files", disabled: !canControl },
                  { value: "delete", label: "Delete", disabled: !canControl },
                ]}
                style={{ width: 150 }}
              />
            </div>
          </div>
        </div>

        {frpOpStatus || serverOpStatus ? (
          <div className="hint" style={{ marginTop: 8 }}>
            {frpOpStatus ? <span style={{ marginRight: 10 }}>FRP: {frpOpStatus}</span> : null}
            {serverOpStatus ? <span>MC: {serverOpStatus}</span> : null}
          </div>
        ) : null}

        <div className="grid2">
          <div className="kv">
            <div className="k">Status</div>
            <div className="v">
              {instanceStatus?.running ? (
                <span className="badge ok">running (pid {instanceStatus.pid || "-"})</span>
              ) : (
                <span className="badge">stopped</span>
              )}
            </div>
            <div className="hint">node: {selectedDaemon?.id || "-"}</div>
          </div>

          <div className="kv">
            <div className="k">FRP process</div>
            <div className="v">
              {frpStatus?.running ? <span className="badge ok">running</span> : <span className="badge">stopped</span>}
            </div>
          </div>

          <div className="kv">
            <div className="k">Last heartbeat</div>
            <div className="v">{fmtUnix(selectedDaemon?.heartbeat?.server_time_unix)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Connect</h2>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <code
            className="clickCopy"
            role="button"
            tabIndex={0}
            title="Click to copy"
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
            Copy
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          {frpStatus?.running && frpStatus.remote_port ? (
            <span>FRP：公网连接地址（可直接复制给朋友）。</span>
          ) : enableFrp ? (
            !selectedProfile ? (
              <span>
                FRP 已开启但未选择服务器（去{" "}
                <button className="linkBtn" onClick={() => setTab("frp")}>
                  FRP
                </button>{" "}
                保存一个 profile）。
              </span>
            ) : frpRemotePort <= 0 ? (
              <span>FRP 已开启但 Remote Port=0（由服务端分配端口；建议手动指定一个固定端口）。</span>
            ) : (
              <span>FRP：启动后会显示公网地址。</span>
            )
          ) : (
            <span>未开启 FRP：显示本机/LAN 连接地址（Docker 默认映射 25565-25600）。</span>
          )}
        </div>
        <div className="hint">
          Minecraft：多人游戏 → 添加服务器 → 地址填 <code>{instanceId.trim() ? socketText : "IP:Port"}</code>
        </div>
      </div>

      <div className="card">
        <h2>Logs</h2>
        <div className="toolbar">
          <div className="toolbarLeft">
            <div className="field" style={{ minWidth: 180 }}>
              <label>View</label>
              <Select
                value={logView}
                onChange={(v) => setLogView(v as any)}
                options={[
                  { value: "all", label: "All" },
                  { value: "mc", label: "MC" },
                  { value: "install", label: "Install" },
                  { value: "frp", label: "FRP" },
                ]}
              />
            </div>
          </div>
          <div className="toolbarRight">
            <input
              value={logQuery}
              onChange={(e: any) => setLogQuery(e.target.value)}
              placeholder="Search logs…"
              style={{ width: 220 }}
            />
            <label className="checkRow" style={{ userSelect: "none" }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> autoscroll
            </label>
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const text =
                  filteredLogs
                    .slice(-300)
                    .map((l: any) => {
                      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
                      const src = l.source || "daemon";
                      const stream = l.stream || "";
                      const inst = l.instance ? `(${l.instance})` : "";
                      return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
                    })
                    .join("\n") || "";
                copyText(text || "<empty>");
              }}
            >
              <Icon name="copy" />
              Copy
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => {
                const text =
                  filteredLogs
                    .slice(-2000)
                    .map((l: any) => {
                      const ts = l.ts_unix ? new Date(l.ts_unix * 1000).toLocaleTimeString() : "--:--:--";
                      const src = l.source || "daemon";
                      const stream = l.stream || "";
                      const inst = l.instance ? `(${l.instance})` : "";
                      return `[${ts}] ${src}${inst} ${stream}: ${l.line || ""}`;
                    })
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
              Download
            </button>
          </div>
        </div>
        <pre ref={preRef} style={{ maxHeight: 640, overflow: "auto" }}>{logText}</pre>
        <div className="hint">提示：All 会显示当前游戏 + FRP 的日志。</div>

        <div className="row" style={{ marginTop: 12 }}>
          <input
            value={consoleLine}
            onChange={(e) => setConsoleLine(e.target.value)}
            placeholder="Console command (e.g. say hi)"
            style={{ flex: 1, minWidth: 240 }}
            disabled={!selectedDaemon?.connected || !instanceId.trim()}
          />
          <button onClick={sendConsoleLine} disabled={!consoleLine.trim() || !selectedDaemon?.connected || !instanceId.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
