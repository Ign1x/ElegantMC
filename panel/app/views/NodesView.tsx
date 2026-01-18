"use client";

import { useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

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
    openAddNodeAndDeploy,
    openDeployDaemonModal,
    makeDeployComposeYml,
    confirmDialog,
  } = useAppCtx();

  const [query, setQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline">("all");
  const [sortBy, setSortBy] = useState<"online" | "last" | "cpu" | "mem" | "id">("online");

  const viewNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(nodes) ? nodes.slice() : [];
    list.sort((a: any, b: any) => {
      const ac = a?.connected ? 1 : 0;
      const bc = b?.connected ? 1 : 0;

      const aLast = Number(a?.lastSeenUnix || 0);
      const bLast = Number(b?.lastSeenUnix || 0);
      const aCpu = typeof a?.heartbeat?.cpu?.usage_percent === "number" ? a.heartbeat.cpu.usage_percent : -1;
      const bCpu = typeof b?.heartbeat?.cpu?.usage_percent === "number" ? b.heartbeat.cpu.usage_percent : -1;
      const aMem = a?.heartbeat?.mem?.total_bytes ? pct(a.heartbeat.mem.used_bytes, a.heartbeat.mem.total_bytes) : -1;
      const bMem = b?.heartbeat?.mem?.total_bytes ? pct(b.heartbeat.mem.used_bytes, b.heartbeat.mem.total_bytes) : -1;

      if (sortBy === "online") {
        if (ac !== bc) return bc - ac;
        return String(a?.id || "").localeCompare(String(b?.id || ""));
      }
      if (sortBy === "last") return bLast - aLast;
      if (sortBy === "cpu") return bCpu - aCpu;
      if (sortBy === "mem") return bMem - aMem;
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });

    const filtered =
      statusFilter === "online" ? list.filter((n: any) => !!n?.connected) : statusFilter === "offline" ? list.filter((n: any) => !n?.connected) : list;

    if (!q) return filtered;
    return filtered.filter((n: any) => String(n?.id || "").toLowerCase().includes(q));
  }, [nodes, query, pct, sortBy, statusFilter]);

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>Nodes</h2>
              {nodesStatus ? <div className="hint">{nodesStatus}</div> : null}
            </div>
          </div>
          <div className="toolbarRight">
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as any)}
              options={[
                { value: "all", label: "All" },
                { value: "online", label: "Online" },
                { value: "offline", label: "Offline" },
              ]}
              style={{ width: 140 }}
            />
            <Select
              value={sortBy}
              onChange={(v) => setSortBy(v as any)}
              options={[
                { value: "online", label: "Online first" },
                { value: "last", label: "Last seen" },
                { value: "cpu", label: "CPU%" },
                { value: "mem", label: "MEM%" },
                { value: "id", label: "ID" },
              ]}
              style={{ width: 160 }}
            />
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
                        className="iconBtn iconOnly"
                        title="Copy token"
                        aria-label="Copy token"
                        onClick={async () => {
                          const ok = await confirmDialog(`Reveal and copy token for node ${n.id}?`, {
                            title: "Reveal Token",
                            confirmLabel: "Reveal",
                            cancelLabel: "Cancel",
                          });
                          if (!ok) return;
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
                        className="iconBtn"
                        onClick={async () => {
                          const ok = await confirmDialog(`Copy docker-compose snippet for node ${n.id}? (includes token)`, {
                            title: "Copy Deploy Snippet",
                            confirmLabel: "Copy",
                            cancelLabel: "Cancel",
                          });
                          if (!ok) return;
                          setNodesStatus("");
                          try {
                            const res = await apiFetch(`/api/nodes/${encodeURIComponent(n.id)}/token`, { cache: "no-store" });
                            const json = await res.json();
                            if (!res.ok) throw new Error(json?.error || "failed");
                            const token = String(json?.token || "");
                            const yml = makeDeployComposeYml(n.id, token);
                            await copyText(yml);
                            setNodesStatus("Copied");
                            setTimeout(() => setNodesStatus(""), 800);
                          } catch (e: any) {
                            setNodesStatus(String(e?.message || e));
                          }
                        }}
                      >
                        <Icon name="copy" />
                        Copy Compose
                      </button>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          const ok = await confirmDialog(`Reveal token and generate compose for node ${n.id}?`, {
                            title: "Deploy Node",
                            confirmLabel: "Generate",
                            cancelLabel: "Cancel",
                          });
                          if (!ok) return;
                          setNodesStatus("");
                          try {
                            const res = await apiFetch(`/api/nodes/${encodeURIComponent(n.id)}/token`, { cache: "no-store" });
                            const json = await res.json();
                            if (!res.ok) throw new Error(json?.error || "failed");
                            openDeployDaemonModal(n.id, String(json?.token || ""));
                          } catch (e: any) {
                            setNodesStatus(String(e?.message || e));
                          }
                        }}
                      >
                        <Icon name="download" />
                        Deploy
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
        ) : nodesStatus === "Loading..." ? (
          <div className="cardGrid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <div className="emptyState">
            {nodes.length ? (
              "No results."
            ) : (
              <>
                <div style={{ fontWeight: 800 }}>暂无节点</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  点击 Add 创建一个节点（生成 token），然后点 Deploy 生成 docker compose 一键部署。
                </div>
                <div className="btnGroup" style={{ justifyContent: "center", marginTop: 10 }}>
                  <button type="button" className="primary iconBtn" onClick={openAddNodeModal}>
                    <Icon name="plus" />
                    Add
                  </button>
                  <button type="button" className="iconBtn" onClick={openAddNodeAndDeploy}>
                    <Icon name="download" />
                    Deploy
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
