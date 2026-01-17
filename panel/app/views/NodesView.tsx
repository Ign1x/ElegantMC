"use client";

import { useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";

export default function NodesView() {
  const {
    nodes,
    nodesStatus,
    setNodesStatus,
    apiFetch,
    setNodes,
    openNodeDetails,
    copyText,
    pct,
    fmtUnix,
    fmtBytes,
    setSelected,
    setTab,
    openAddNodeModal,
    confirmDialog,
  } = useAppCtx();

  const [query, setQuery] = useState<string>("");

  const viewNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(nodes) ? nodes.slice() : [];
    list.sort((a: any, b: any) => {
      const ac = a?.connected ? 1 : 0;
      const bc = b?.connected ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });
    if (!q) return list;
    return list.filter((n: any) => String(n?.id || "").toLowerCase().includes(q));
  }, [nodes, query]);

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>Nodes</h2>
              <div className="hint">这里的 Node 列表用于 Daemon 鉴权（daemon_id → token），保存在 Panel 数据目录。</div>
              {nodesStatus ? <div className="hint">{nodesStatus}</div> : null}
            </div>
          </div>
          <div className="toolbarRight">
            <input
              value={query}
              onChange={(e: any) => setQuery(e.target.value)}
              placeholder="Search nodes…"
              style={{ width: 220 }}
            />
            <button type="button" className="primary iconBtn" onClick={openAddNodeModal}>
              <Icon name="plus" />
              Add
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={async () => {
                setNodesStatus("Loading...");
                try {
                  const res = await apiFetch("/api/nodes", { cache: "no-store" });
                  const json = await res.json();
                  if (!res.ok) throw new Error(json?.error || "failed");
                  setNodes(json.nodes || []);
                  setNodesStatus("");
                } catch (e: any) {
                  setNodes([]);
                  setNodesStatus(String(e?.message || e));
                }
              }}
            >
              <Icon name="refresh" />
              Refresh
            </button>
            <span className="badge">
              {viewNodes.length}/{nodes.length}
            </span>
          </div>
        </div>

        {viewNodes.length ? (
          <div className="cardGrid">
            {viewNodes.map((n: any) => {
              const hb = n.heartbeat || {};
              const cpu = typeof hb?.cpu?.usage_percent === "number" ? hb.cpu.usage_percent : null;
              const mem = hb?.mem || {};
              const instances = Array.isArray(hb?.instances) ? hb.instances : [];
              const memPct = mem?.total_bytes ? pct(mem.used_bytes, mem.total_bytes) : null;
              return (
                <div key={n.id} className="itemCard" style={{ opacity: n.connected ? 1 : 0.78 }}>
                  <div className="itemCardHeader">
                    <div style={{ minWidth: 0 }}>
                      <div className="itemTitle">{n.id}</div>
                      <div className="itemMeta">
                        last: {fmtUnix(n.lastSeenUnix)} · instances: {instances.length}
                      </div>
                    </div>
                    <span className={`badge ${n.connected ? "ok" : ""}`}>{n.connected ? "online" : "offline"}</span>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    <span className="badge">{cpu == null ? "CPU -" : `CPU ${cpu.toFixed(1)}%`}</span>
                    <span className="badge">{memPct == null ? "MEM -" : `MEM ${memPct.toFixed(0)}%`}</span>
                  </div>
                  {mem?.total_bytes ? (
                    <div className="hint">
                      {fmtBytes(mem.used_bytes)}/{fmtBytes(mem.total_bytes)}
                    </div>
                  ) : (
                    <div className="hint">memory: -</div>
                  )}

                  <div className="row" style={{ justifyContent: "space-between", gap: 10, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <span className="muted">token</span>
                      <code>{String(n.token_masked || "(hidden)")}</code>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          try {
                            const res = await apiFetch(`/api/nodes/${encodeURIComponent(n.id)}/token`, { cache: "no-store" });
                            const json = await res.json();
                            if (!res.ok) throw new Error(json?.error || "failed");
                            await copyText(String(json?.token || ""));
                            setNodesStatus("Copied");
                            setTimeout(() => setNodesStatus(""), 800);
                          } catch (e: any) {
                            setNodesStatus(String(e?.message || e));
                          }
                        }}
                      >
                        <Icon name="copy" />
                        Copy
                      </button>
                    </div>
                  </div>

                  <div className="itemFooter">
                    <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                      <button type="button" onClick={() => openNodeDetails(n.id)}>
                        Details
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(n.id);
                          setTab("games");
                        }}
                      >
                        Manage
                      </button>
                    </div>
                    <button
                      type="button"
                      className="dangerBtn"
                      onClick={async () => {
                        const ok = await confirmDialog(`Delete node ${n.id}?`, { title: "Delete Node", confirmLabel: "Delete", danger: true });
                        if (!ok) return;
                        setNodesStatus("");
                        try {
                          const res = await apiFetch(`/api/nodes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
                          const json = await res.json();
                          if (!res.ok) throw new Error(json?.error || "failed");
                          const res2 = await apiFetch("/api/nodes", { cache: "no-store" });
                          const json2 = await res2.json();
                          if (res2.ok) setNodes(json2.nodes || []);
                        } catch (e: any) {
                          setNodesStatus(String(e?.message || e));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="emptyState">
            {nodes.length ? "No results." : "暂无节点。点击右上角 Add 创建一个，然后在 Daemon 端使用对应 token 连接。"}
          </div>
        )}
      </div>
    </div>
  );
}
