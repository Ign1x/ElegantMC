"use client";

import { useEffect, useState } from "react";
import { useAppCtx } from "../appCtx";

export default function PanelView() {
  const { panelSettings, panelSettingsStatus, refreshPanelSettings, savePanelSettings } = useAppCtx();

  const [draft, setDraft] = useState<any>(panelSettings || null);

  useEffect(() => {
    setDraft(panelSettings || null);
  }, [panelSettings]);

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>Panel</h2>
              {panelSettingsStatus ? <div className="hint">{panelSettingsStatus}</div> : null}
            </div>
          </div>
          <div className="toolbarRight">
            <button type="button" className="iconBtn" onClick={refreshPanelSettings}>
              Reload
            </button>
          </div>
        </div>

        {!draft ? (
          <div className="emptyState">No settings loaded.</div>
        ) : (
          <>
            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="field">
                <label>Brand Name</label>
                <input value={String(draft.brand_name || "")} onChange={(e) => setDraft((d: any) => ({ ...d, brand_name: e.target.value }))} />
                <div className="hint">显示在侧边栏与浏览器标题</div>
              </div>
              <div className="field">
                <label>Brand Tagline</label>
                <input
                  value={String(draft.brand_tagline || "")}
                  onChange={(e) => setDraft((d: any) => ({ ...d, brand_tagline: e.target.value }))}
                />
                <div className="hint">可留空</div>
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Logo URL</label>
                <input value={String(draft.logo_url || "")} onChange={(e) => setDraft((d: any) => ({ ...d, logo_url: e.target.value }))} />
                <div className="hint">默认：/logo.svg（可填自定义 URL）</div>
              </div>

              <div className="field">
                <label>Default Version</label>
                <input
                  value={String(draft.defaults?.version || "")}
                  onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), version: e.target.value } }))}
                  placeholder="1.20.1"
                />
              </div>
              <div className="field">
                <label>Default Game Port</label>
                <input
                  type="number"
                  value={Number.isFinite(Number(draft.defaults?.game_port)) ? Number(draft.defaults.game_port) : 25565}
                  onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), game_port: Number(e.target.value) } }))}
                  min={1}
                  max={65535}
                />
              </div>
              <div className="field">
                <label>Default Memory</label>
                <div className="row">
                  <input
                    value={String(draft.defaults?.xms || "")}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), xms: e.target.value } }))}
                    placeholder="Xms (e.g. 1G)"
                  />
                  <input
                    value={String(draft.defaults?.xmx || "")}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), xmx: e.target.value } }))}
                    placeholder="Xmx (e.g. 2G)"
                  />
                </div>
              </div>
              <div className="field">
                <label>Default EULA</label>
                <label className="checkRow">
                  <input
                    type="checkbox"
                    checked={draft.defaults?.accept_eula == null ? true : !!draft.defaults.accept_eula}
                    onChange={(e) =>
                      setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), accept_eula: e.target.checked } }))
                    }
                  />
                  auto write eula.txt
                </label>
              </div>
              <div className="field">
                <label>Default FRP</label>
                <label className="checkRow">
                  <input
                    type="checkbox"
                    checked={draft.defaults?.enable_frp == null ? true : !!draft.defaults.enable_frp}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), enable_frp: e.target.checked } }))}
                  />
                  enable by default
                </label>
              </div>
              <div className="field">
                <label>Default FRP Remote Port</label>
                <input
                  type="number"
                  value={Number.isFinite(Number(draft.defaults?.frp_remote_port)) ? Number(draft.defaults.frp_remote_port) : 25566}
                  onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), frp_remote_port: Number(e.target.value) } }))}
                  min={0}
                  max={65535}
                />
                <div className="hint">0 表示由服务端分配</div>
              </div>
            </div>

            <div className="btnGroup" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button type="button" className="primary" onClick={() => savePanelSettings(draft)}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

