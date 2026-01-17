"use client";

import { useAppCtx } from "../appCtx";

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
  } = useAppCtx();

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
            <button type="button" className="primary" onClick={openAddFrpModal}>
              Add
            </button>
            <button type="button" onClick={refreshProfiles}>
              Refresh
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
                      onClick={async () => {
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
                    </div>
                    <button type="button" className="dangerBtn" onClick={() => removeFrpProfile(p.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="emptyState">暂无配置。点击右上角 Add 保存一个 FRP Server profile。</div>
        )}
      </div>
    </div>
  );
}
