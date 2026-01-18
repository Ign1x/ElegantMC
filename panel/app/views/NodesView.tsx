"use client";

import { useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

export default function NodesView() {
  const {
    t,
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
              <h2>{t.tr("Nodes", "节点")}</h2>
              {nodesStatus ? <div className="hint">{nodesStatus}</div> : null}
            </div>
          </div>
          <div className="toolbarRight">
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as any)}
              options={[
                { value: "all", label: t.tr("All", "全部") },
                { value: "online", label: t.tr("Online", "在线") },
                { value: "offline", label: t.tr("Offline", "离线") },
              ]}
              style={{ width: 140 }}
            />
            <Select
              value={sortBy}
              onChange={(v) => setSortBy(v as any)}
              options={[
                { value: "online", label: t.tr("Online first", "在线优先") },
                { value: "last", label: t.tr("Last seen", "最近在线") },
                { value: "cpu", label: "CPU%" },
                { value: "mem", label: "MEM%" },
                { value: "id", label: "ID" },
              ]}
              style={{ width: 160 }}
            />
            <input
              value={query}
              onChange={(e: any) => setQuery(e.target.value)}
              placeholder={t.tr("Search nodes…", "搜索节点…")}
              style={{ width: 220 }}
            />
            <button type="button" className="primary iconBtn" onClick={openAddNodeModal}>
              <Icon name="plus" />
              {t.tr("Add", "添加")}
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={async () => {
                setNodesStatus(t.tr("Loading...", "加载中..."));
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
              {t.tr("Refresh", "刷新")}
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
                        {t.tr("last", "最近")}: {fmtUnix(n.lastSeenUnix)} · {t.tr("instances", "实例")}: {instances.length}
                      </div>
                    </div>
                    <span className={`badge ${n.connected ? "ok" : ""}`}>{n.connected ? t.tr("online", "在线") : t.tr("offline", "离线")}</span>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    <span className="badge">{cpu == null ? t.tr("CPU -", "CPU -") : `CPU ${cpu.toFixed(1)}%`}</span>
                    <span className="badge">{memPct == null ? t.tr("MEM -", "MEM -") : `MEM ${memPct.toFixed(0)}%`}</span>
                  </div>
                  {mem?.total_bytes ? (
                    <div className="hint">
                      {fmtBytes(mem.used_bytes)}/{fmtBytes(mem.total_bytes)}
                    </div>
                  ) : (
                    <div className="hint">{t.tr("memory: -", "内存：-")}</div>
                  )}

                  <div className="row" style={{ justifyContent: "space-between", gap: 10, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <span className="muted">{t.tr("token", "token")}</span>
                      <code>{String(n.token_masked || t.tr("(hidden)", "(隐藏)"))}</code>
                      <button
                        type="button"
                        className="iconBtn iconOnly"
                        title={t.tr("Copy token", "复制 token")}
                        aria-label={t.tr("Copy token", "复制 token")}
                        onClick={async () => {
                          const ok = await confirmDialog(t.tr(`Reveal and copy token for node ${n.id}?`, `显示并复制节点 ${n.id} 的 token？`), {
                            title: t.tr("Reveal Token", "显示 Token"),
                            confirmLabel: t.tr("Reveal", "显示"),
                            cancelLabel: t.tr("Cancel", "取消"),
                          });
                          if (!ok) return;
                          try {
                            const res = await apiFetch(`/api/nodes/${encodeURIComponent(n.id)}/token`, { cache: "no-store" });
                            const json = await res.json();
                            if (!res.ok) throw new Error(json?.error || "failed");
                            await copyText(String(json?.token || ""));
                            setNodesStatus(t.tr("Copied", "已复制"));
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
                        {t.tr("Details", "详情")}
                      </button>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          const ok = await confirmDialog(t.tr(`Copy docker-compose snippet for node ${n.id}? (includes token)`, `复制节点 ${n.id} 的 docker-compose 片段？（包含 token）`), {
                            title: t.tr("Copy Deploy Snippet", "复制部署片段"),
                            confirmLabel: t.tr("Copy", "复制"),
                            cancelLabel: t.tr("Cancel", "取消"),
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
                            setNodesStatus(t.tr("Copied", "已复制"));
                            setTimeout(() => setNodesStatus(""), 800);
                          } catch (e: any) {
                            setNodesStatus(String(e?.message || e));
                          }
                        }}
                      >
                        <Icon name="copy" />
                        {t.tr("Copy Compose", "复制 Compose")}
                      </button>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          const ok = await confirmDialog(t.tr(`Reveal token and generate compose for node ${n.id}?`, `显示 token 并为节点 ${n.id} 生成 compose？`), {
                            title: t.tr("Deploy Node", "部署节点"),
                            confirmLabel: t.tr("Generate", "生成"),
                            cancelLabel: t.tr("Cancel", "取消"),
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
                        {t.tr("Deploy", "部署")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(n.id);
                          setTab("games");
                        }}
                      >
                        {t.tr("Manage", "管理")}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="dangerBtn"
                      onClick={async () => {
                        const ok = await confirmDialog(t.tr(`Delete node ${n.id}?`, `删除节点 ${n.id}？`), { title: t.tr("Delete Node", "删除节点"), confirmLabel: t.tr("Delete", "删除"), danger: true });
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
                      {t.tr("Delete", "删除")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : nodesStatus === "Loading..." || nodesStatus === "加载中..." ? (
          <div className="cardGrid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <div className="emptyState">
            {nodes.length ? (
              t.tr("No results.", "没有匹配结果。")
            ) : (
              <>
                <div style={{ fontWeight: 800 }}>{t.tr("No nodes yet", "暂无节点")}</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  {t.tr(
                    "Click Add to create a node (token), then Deploy to generate a docker compose snippet.",
                    "点击 Add 创建一个节点（生成 token），然后点 Deploy 生成 docker compose 一键部署。"
                  )}
                </div>
                <div className="btnGroup" style={{ justifyContent: "center", marginTop: 10 }}>
                  <button type="button" className="primary iconBtn" onClick={openAddNodeModal}>
                    <Icon name="plus" />
                    {t.tr("Add", "添加")}
                  </button>
                  <button type="button" className="iconBtn" onClick={openAddNodeAndDeploy}>
                    <Icon name="download" />
                    {t.tr("Deploy", "部署")}
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
