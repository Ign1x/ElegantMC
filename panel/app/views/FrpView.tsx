"use client";

import { useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";

export default function FrpView() {
  const {
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
  } = useAppCtx();

  const [testingId, setTestingId] = useState<string>("");

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>Saved FRP Servers</h2>
              {profilesStatus ? <div className="hint">{profilesStatus}</div> : <div className="hint">保存后可在 Games 里一键复用</div>}
            </div>
          </div>
          <div className="toolbarRight">
            <button type="button" className="primary iconBtn" onClick={openAddFrpModal}>
              <Icon name="plus" />
              Add
            </button>
            <button type="button" className="iconBtn" onClick={refreshProfiles}>
              <Icon name="refresh" />
              Refresh
            </button>
            <button type="button" className="iconBtn" onClick={() => refreshProfiles({ force: true })}>
              <Icon name="refresh" />
              Probe
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
                      <span className="badge ok">online {latency}ms</span>
                    ) : online === false ? (
                      <span className="badge">offline</span>
                    ) : (
                      <span className="badge">unknown</span>
                    )}
                  </div>

                  <div className="hint">checked: {fmtUnix(checkedAt)}</div>
                  {p.status?.error && online === false ? <div className="hint">{p.status.error}</div> : null}

                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="muted">token</span>
                    <code>{String(p.token_masked || "(none)")}</code>
                    <button
                      type="button"
                      className="iconBtn"
                      onClick={async () => {
                        const ok = await confirmDialog(`Reveal and copy token for FRP profile "${p.name}"?`, {
                          title: "Reveal Token",
                          confirmLabel: "Reveal",
                          cancelLabel: "Cancel",
                        });
                        if (!ok) return;
                        try {
                          const res = await apiFetch(`/api/frp/profiles/${encodeURIComponent(p.id)}/token`, { cache: "no-store" });
                          const json = await res.json();
                          if (!res.ok) throw new Error(json?.error || "failed");
                          await copyText(String(json?.token || ""));
                          setProfilesStatus("Copied");
                          setTimeout(() => setProfilesStatus(""), 800);
                        } catch (e: any) {
                          setProfilesStatus(String(e?.message || e));
                        }
                      }}
                      disabled={!p.has_token}
                    >
                      <Icon name="copy" />
                      Copy
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
                        Use
                      </button>
                      <button
                        type="button"
                        className="iconBtn"
                        onClick={async () => {
                          try {
                            setTestingId(p.id);
                            setProfilesStatus(`Testing ${p.name} ...`);
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
                        title="Test reachability from Panel to FRP server"
                      >
                        <Icon name="refresh" />
                        Test
                      </button>
                    </div>
                    <button type="button" className="dangerBtn iconBtn" onClick={() => removeFrpProfile(p.id)}>
                      <Icon name="trash" />
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : profilesStatus === "Loading..." ? (
          <div className="cardGrid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <div className="emptyState">暂无配置。点击右上角 Add 保存一个 FRP Server profile。</div>
        )}
      </div>
    </div>
  );
}
