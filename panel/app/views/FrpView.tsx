"use client";

import { useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import DangerZone from "../ui/DangerZone";

export default function FrpView() {
  const {
    t,
    profiles,
    profilesStatus,
    refreshProfiles,
    openAddFrpModal,
    setEnableFrp,
    setFrpProfileId,
    setTab,
    removeFrpProfile,
    copyText,
    fmtUnix,
    setProfilesStatus,
    apiFetch,
    confirmDialog,
    promptDialog,
  } = useAppCtx();

  const [testingId, setTestingId] = useState<string>("");

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Saved FRP Servers", "已保存的 FRP Server")}</h2>
              {profilesStatus ? (
                <div className="hint">{profilesStatus}</div>
              ) : (
                <div className="hint">{t.tr("After saving, you can reuse it from Games.", "保存后可在 Games 里一键复用")}</div>
              )}
            </div>
          </div>
          <div className="toolbarRight">
            <button type="button" className="primary iconBtn" onClick={openAddFrpModal}>
              <Icon name="plus" />
              {t.tr("Add", "添加")}
            </button>
            <button type="button" className="iconBtn" onClick={refreshProfiles}>
              <Icon name="refresh" />
              {t.tr("Refresh", "刷新")}
            </button>
            <button type="button" className="iconBtn" onClick={() => refreshProfiles({ force: true })}>
              <Icon name="refresh" />
              {t.tr("Test All", "全部测试")}
            </button>
          </div>
        </div>

        {profiles.length ? (
          <div className="cardGrid">
            {profiles.map((p: any) => {
              const online = p.status?.online;
              const latency = Number(p.status?.latencyMs || 0);
              const checkedAt = p.status?.checkedAtUnix || null;
              return (
                <div key={p.id} className="itemCard">
                  <div className="itemCardHeader">
                    <div style={{ minWidth: 0 }}>
                      <div className="itemTitle">{p.name}</div>
                      <div className="itemMeta">
                        <code>
                          {p.server_addr}:{p.server_port}
                        </code>
                      </div>
                    </div>
                    {online === true ? (
                      <span className="badge ok">
                        {t.tr("online", "在线")} {latency}ms
                      </span>
                    ) : online === false ? (
                      <span className="badge">{t.tr("offline", "离线")}</span>
                    ) : (
                      <span className="badge">{t.tr("unknown", "未知")}</span>
                    )}
                  </div>

                  <div className="hint">
                    {t.tr("checked", "检测")}: {fmtUnix(checkedAt)}
                  </div>
                  {p.status?.error && online === false ? <div className="hint">{p.status.error}</div> : null}

                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="muted">{t.tr("token", "token")}</span>
                    <code>{String(p.token_masked || t.tr("(none)", "(无)"))}</code>
                    <button
                      type="button"
                      className="iconBtn"
                      onClick={async () => {
                        const ok = await confirmDialog(t.tr(`Reveal and copy token for FRP profile "${p.name}"?`, `显示并复制 FRP 配置「${p.name}」的 token？`), {
                          title: t.tr("Reveal Token", "显示 Token"),
                          confirmLabel: t.tr("Reveal", "显示"),
                          cancelLabel: t.tr("Cancel", "取消"),
                        });
                        if (!ok) return;
                        try {
                          const res = await apiFetch(`/api/frp/profiles/${encodeURIComponent(p.id)}/token`, { cache: "no-store" });
                          const json = await res.json();
                          if (!res.ok) throw new Error(json?.error || "failed");
                          await copyText(String(json?.token || ""));
                          setProfilesStatus(t.tr("Copied", "已复制"));
                          setTimeout(() => setProfilesStatus(""), 800);
                        } catch (e: any) {
                          setProfilesStatus(String(e?.message || e));
                        }
                      }}
                      disabled={!p.has_token}
                      >
                        <Icon name="copy" />
                      {t.tr("Copy", "复制")}
                    </button>
                  </div>

                  <div className="itemFooter">
                    <div className="btnGroup" style={{ justifyContent: "flex-start" }}>
                      <button
                        type="button"
                        onClick={() => {
                          setEnableFrp(true);
                          setFrpProfileId(p.id);
                          setTab("games");
                        }}
                      >
                        {t.tr("Use", "使用")}
                      </button>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          try {
                            setTestingId(p.id);
                            setProfilesStatus(t.tr(`Testing ${p.name} ...`, `正在测试 ${p.name} ...`));
                            const res = await apiFetch(`/api/frp/profiles/${encodeURIComponent(p.id)}/probe`, {
                              method: "POST",
                              cache: "no-store",
                            });
                            const json = await res.json().catch(() => null);
                            if (!res.ok) throw new Error(json?.error || "failed");
                            await refreshProfiles();
                          } catch (e: any) {
                            setProfilesStatus(String(e?.message || e));
                          } finally {
                            setTestingId("");
                          }
                        }}
                        disabled={testingId === p.id}
                        title={t.tr("Test reachability from Panel to FRP server", "测试 Panel 到 FRP Server 的连通性")}
                      >
                        <Icon name="refresh" />
                        {t.tr("Test", "测试")}
                      </button>
                    </div>
                  </div>

                  <DangerZone
                    title={t.tr("Danger Zone", "危险区")}
                    hint={t.tr("Deleting a profile cannot be undone (you can recreate it later).", "删除后不可撤销（可稍后重新创建）。")}
                  >
                    <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="dangerBtn iconBtn"
                        onClick={async () => {
                          const name = String(p?.name || "").trim() || "-";
                          const ok = await confirmDialog(t.tr(`Delete FRP profile "${name}"?`, `删除 FRP 配置「${name}」？`), {
                            title: t.tr("Delete", "删除"),
                            confirmLabel: t.tr("Delete", "删除"),
                            cancelLabel: t.tr("Cancel", "取消"),
                            danger: true,
                          });
                          if (!ok) return;
                          const typed = await promptDialog({
                            title: t.tr("Confirm Delete", "确认删除"),
                            message: t.tr(`Type "${name}" to confirm deleting this profile.`, `输入「${name}」以确认删除该配置。`),
                            placeholder: name,
                            okLabel: t.tr("Delete", "删除"),
                            cancelLabel: t.tr("Cancel", "取消"),
                          });
                          if (typed !== name) return;
                          await removeFrpProfile(p.id);
                        }}
                      >
                        <Icon name="trash" />
                        {t.tr("Delete", "删除")}
                      </button>
                    </div>
                  </DangerZone>
                </div>
              );
            })}
          </div>
        ) : profilesStatus === "Loading..." || profilesStatus === "加载中..." ? (
          <div className="cardGrid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <div className="emptyState">{t.tr("No profiles yet. Click Add to save an FRP server profile.", "暂无配置。点击右上角 Add 保存一个 FRP Server profile。")}</div>
        )}
      </div>
    </div>
  );
}
