"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Select from "../ui/Select";

export default function PanelView() {
  const {
    t,
    panelSettings,
    panelSettingsStatus,
    refreshPanelSettings,
    savePanelSettings,
    selectedDaemon,
    loadSchedule,
    saveScheduleJson,
    runScheduleTask,
    confirmDialog,
    fmtUnix,
    serverDirs,
  } = useAppCtx();

  const [draft, setDraft] = useState<any>(panelSettings || null);
  const [settingsQuery, setSettingsQuery] = useState<string>("");
  const [scheduleText, setScheduleText] = useState<string>("");
  const [scheduleStatus, setScheduleStatus] = useState<string>("");
  const [schedulePath, setSchedulePath] = useState<string>("");
  const [scheduleBusy, setScheduleBusy] = useState<boolean>(false);

  const [backupPresetInstanceId, setBackupPresetInstanceId] = useState<string>("");
  const [backupPresetEveryHours, setBackupPresetEveryHours] = useState<number>(24);
  const [backupPresetKeepLast, setBackupPresetKeepLast] = useState<number>(7);
  const [backupPresetStopServer, setBackupPresetStopServer] = useState<boolean>(true);

  useEffect(() => {
    setDraft(panelSettings || null);
  }, [panelSettings]);

  useEffect(() => {
    if (backupPresetInstanceId.trim()) return;
    if (Array.isArray(serverDirs) && serverDirs.length) setBackupPresetInstanceId(String(serverDirs[0] || ""));
  }, [backupPresetInstanceId, serverDirs]);

  const parsedSchedule = useMemo(() => {
    const raw = String(scheduleText || "").trim();
    if (!raw) return { ok: true, schedule: { tasks: [] as any[] } };
    try {
      const schedule = JSON.parse(raw);
      return { ok: true, schedule };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e), schedule: null };
    }
  }, [scheduleText]);

  const q = settingsQuery.trim().toLowerCase();
  const show = (...terms: string[]) => !q || terms.some((t) => String(t || "").toLowerCase().includes(q));

  function uniqueTaskId(existingTasks: any[], base: string) {
    const used = new Set((existingTasks || []).map((t) => String(t?.id || "").trim()).filter(Boolean));
    const root = String(base || "task").trim() || "task";
    if (!used.has(root)) return root;
    for (let i = 2; i <= 500; i++) {
      const id = `${root}-${i}`;
      if (!used.has(id)) return id;
    }
    return `${root}-${Math.floor(Date.now() / 1000)}`;
  }

  function applyScheduleUpdate(nextSchedule: any) {
    setScheduleText(JSON.stringify(nextSchedule ?? { tasks: [] }, null, 2) + "\n");
  }

  function addBackupPreset() {
    if (!parsedSchedule.ok) return;
    if (scheduleBusy) return;

    const inst = String(backupPresetInstanceId || "").trim();
    if (!inst) {
      setScheduleStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    const hoursRaw = Number(backupPresetEveryHours);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24;
    const everySec = Math.max(60, Math.round(hours * 3600));

    const keepRaw = Math.round(Number(backupPresetKeepLast));
    const keepLast = Number.isFinite(keepRaw) && keepRaw >= 0 ? Math.min(keepRaw, 1000) : 0;

    const prev = (parsedSchedule as any).schedule;
    const next: any = typeof prev === "object" && prev ? { ...prev } : { tasks: [] };
    const tasks = Array.isArray(next.tasks) ? [...next.tasks] : [];
    const id = uniqueTaskId(tasks, `backup-${inst}`);

    const task: any = {
      id,
      type: "backup",
      instance_id: inst,
      every_sec: everySec,
      ...(keepLast > 0 ? { keep_last: keepLast } : {}),
      ...(backupPresetStopServer ? {} : { stop: false }),
    };
    tasks.push(task);
    next.tasks = tasks;
    applyScheduleUpdate(next);
    setScheduleStatus(t.tr("Added backup task. Remember to Save.", "已添加备份任务。记得保存。"));
    window.setTimeout(() => setScheduleStatus(""), 1200);
  }

  async function fetchSchedule() {
    const out = await loadSchedule();
    const p = String(out?.path || "");
    setSchedulePath(p);
    const s = out?.schedule ?? { tasks: [] };
    setScheduleText(JSON.stringify(s, null, 2) + "\n");
  }

  async function reloadSchedule() {
    if (scheduleBusy) return;
    setScheduleBusy(true);
    setScheduleStatus(t.tr("Loading...", "加载中..."));
    try {
      await fetchSchedule();
      setScheduleStatus(t.tr("Loaded", "已加载"));
      window.setTimeout(() => setScheduleStatus(""), 900);
    } catch (e: any) {
      setScheduleStatus(String(e?.message || e));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function saveSchedule() {
    if (scheduleBusy) return;
    const ok = await confirmDialog(t.tr(`Save schedule.json to daemon ${selectedDaemon?.id || "-"}?`, `保存 schedule.json 到 Daemon ${selectedDaemon?.id || "-"}？`), {
      title: t.tr("Save Scheduler", "保存定时任务"),
      confirmLabel: t.tr("Save", "保存"),
      cancelLabel: t.tr("Cancel", "取消"),
      danger: true,
    });
    if (!ok) return;

    setScheduleBusy(true);
    setScheduleStatus(t.tr("Saving...", "保存中..."));
    try {
      const out = await saveScheduleJson(scheduleText);
      setSchedulePath(String(out?.path || schedulePath));
      setScheduleStatus(t.tr("Saved", "已保存"));
      window.setTimeout(() => setScheduleStatus(""), 900);
    } catch (e: any) {
      setScheduleStatus(String(e?.message || e));
    } finally {
      setScheduleBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Panel", "面板")}</h2>
              {panelSettingsStatus ? <div className="hint">{panelSettingsStatus}</div> : null}
            </div>
          </div>
          <div className="toolbarRight">
            <input
              value={settingsQuery}
              onChange={(e) => setSettingsQuery(e.target.value)}
              placeholder={t.tr("Search settings…", "搜索设置…")}
              style={{ width: 220 }}
            />
            <button type="button" className="iconBtn" onClick={refreshPanelSettings}>
              {t.tr("Reload", "刷新")}
            </button>
          </div>
        </div>

        {!draft ? (
          <div className="emptyState">{t.tr("No settings loaded.", "未加载设置。")}</div>
        ) : (
          <>
            <div className="grid2" style={{ alignItems: "start" }}>
              {show("brand name", "brand", "title", "sidebar") ? (
                <div className="field">
                  <label>{t.tr("Brand Name", "品牌名称")}</label>
                  <input value={String(draft.brand_name || "")} onChange={(e) => setDraft((d: any) => ({ ...d, brand_name: e.target.value }))} />
                  <div className="hint">{t.tr("Shown in sidebar and browser title.", "显示在侧边栏与浏览器标题")}</div>
                </div>
              ) : null}
              {show("brand tagline", "tagline") ? (
                <div className="field">
                  <label>{t.tr("Brand Tagline", "品牌标语")}</label>
                  <input
                    value={String(draft.brand_tagline || "")}
                    onChange={(e) => setDraft((d: any) => ({ ...d, brand_tagline: e.target.value }))}
                  />
                  <div className="hint">{t.tr("Optional.", "可留空")}</div>
                </div>
              ) : null}
              {show("logo", "logo url", "icon") ? (
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>{t.tr("Logo URL", "Logo URL")}</label>
                  <input value={String(draft.logo_url || "")} onChange={(e) => setDraft((d: any) => ({ ...d, logo_url: e.target.value }))} />
                  <div className="hint">{t.tr("Default: /logo.svg (or a custom URL).", "默认：/logo.svg（可填自定义 URL）")}</div>
                </div>
              ) : null}

              {show("curseforge", "api key", "cf_") ? (
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>{t.tr("CurseForge API Key (optional)", "CurseForge API Key（可选）")}</label>
                  <input
                    type="password"
                    value={String(draft.curseforge_api_key || "")}
                    onChange={(e) => setDraft((d: any) => ({ ...d, curseforge_api_key: e.target.value }))}
                    placeholder="cf_..."
                    autoComplete="off"
                  />
                  <div className="hint">
                    {t.tr(
                      "After setting this, CurseForge search/install works without environment variables.",
                      "配置后可直接使用 CurseForge 搜索/下载安装（不需要再改环境变量）"
                    )}
                  </div>
                </div>
              ) : null}

              {show("default version", "version") ? (
                <div className="field">
                  <label>{t.tr("Default Version", "默认版本")}</label>
                  <input
                    value={String(draft.defaults?.version || "")}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), version: e.target.value } }))}
                    placeholder="1.20.1"
                  />
                </div>
              ) : null}
              {show("default game port", "port", "25565") ? (
                <div className="field">
                  <label>{t.tr("Default Game Port", "默认端口")}</label>
                  <input
                    type="number"
                    value={Number.isFinite(Number(draft.defaults?.game_port)) ? Number(draft.defaults.game_port) : 25565}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), game_port: Number(e.target.value) } }))}
                    min={1}
                    max={65535}
                  />
                </div>
              ) : null}
              {show("default memory", "memory", "xms", "xmx") ? (
                <div className="field">
                  <label>{t.tr("Default Memory", "默认内存")}</label>
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
              ) : null}
              {show("eula", "accept eula") ? (
                <div className="field">
                  <label>{t.tr("Default EULA", "默认同意 EULA")}</label>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={draft.defaults?.accept_eula == null ? true : !!draft.defaults.accept_eula}
                      onChange={(e) =>
                        setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), accept_eula: e.target.checked } }))
                      }
                    />
                    {t.tr("auto write eula.txt", "自动写入 eula.txt")}
                  </label>
                </div>
              ) : null}
              {show("frp", "default frp") ? (
                <div className="field">
                  <label>{t.tr("Default FRP", "默认启用 FRP")}</label>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={draft.defaults?.enable_frp == null ? true : !!draft.defaults.enable_frp}
                      onChange={(e) =>
                        setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), enable_frp: e.target.checked } }))
                      }
                    />
                    {t.tr("enable by default", "默认启用")}
                  </label>
                </div>
              ) : null}
              {show("frp remote port", "remote port", "25566") ? (
                <div className="field">
                  <label>{t.tr("Default FRP Remote Port", "默认 FRP Remote Port")}</label>
                  <input
                    type="number"
                    value={Number.isFinite(Number(draft.defaults?.frp_remote_port)) ? Number(draft.defaults.frp_remote_port) : 25566}
                    onChange={(e) => setDraft((d: any) => ({ ...d, defaults: { ...(d.defaults || {}), frp_remote_port: Number(e.target.value) } }))}
                    min={0}
                    max={65535}
                  />
                  <div className="hint">{t.tr("0 means server-assigned.", "0 表示由服务端分配")}</div>
                </div>
              ) : null}
            </div>

            <div className="btnGroup" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button type="button" className="primary" onClick={() => savePanelSettings(draft)}>
                {t.tr("Save", "保存")}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Scheduler", "定时任务")}</h2>
              {scheduleStatus ? (
                <div className="hint">{scheduleStatus}</div>
              ) : (
                <div className="hint">{t.tr("Edit daemon schedule.json (restart/backup tasks)", "编辑 daemon schedule.json（重启/备份任务）")}</div>
              )}
              <div className="hint" style={{ marginTop: 6 }}>
                {t.tr("daemon", "daemon")}: <code>{selectedDaemon?.id || "-"}</code> · {t.tr("file", "文件")}:{" "}
                <code>{schedulePath || t.tr("(unknown)", "(未知)")}</code>
              </div>
            </div>
          </div>
          <div className="toolbarRight">
            <button type="button" className="iconBtn" onClick={reloadSchedule} disabled={!selectedDaemon?.connected || scheduleBusy}>
              {t.tr("Reload", "刷新")}
            </button>
            <button type="button" className="primary iconBtn" onClick={saveSchedule} disabled={!selectedDaemon?.connected || scheduleBusy || !parsedSchedule.ok}>
              {t.tr("Save", "保存")}
            </button>
          </div>
        </div>

        {!parsedSchedule.ok ? (
          <div className="hint" style={{ color: "var(--danger)" }}>
            {t.tr("JSON parse error", "JSON 解析错误")}: {parsedSchedule.error}
          </div>
        ) : null}

        <div className="cardSub" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 700 }}>{t.tr("Backup Preset", "备份预设")}</div>
            <button type="button" onClick={addBackupPreset} disabled={!selectedDaemon?.connected || scheduleBusy || !parsedSchedule.ok}>
              {t.tr("Add backup task", "添加备份任务")}
            </button>
          </div>
          <div className="grid2" style={{ marginTop: 10, alignItems: "end" }}>
            <div className="field">
              <label>{t.tr("Instance", "实例")}</label>
              {Array.isArray(serverDirs) && serverDirs.length ? (
                <Select
                  value={backupPresetInstanceId}
                  onChange={(v: string) => setBackupPresetInstanceId(v)}
                  options={serverDirs.map((s: any) => ({ value: String(s || ""), label: String(s || "") }))}
                  placeholder={t.tr("Select instance…", "选择实例…")}
                />
              ) : (
                <input
                  value={backupPresetInstanceId}
                  onChange={(e) => setBackupPresetInstanceId(e.target.value)}
                  placeholder={t.tr("instance_id (e.g. server1)", "instance_id（例如 server1）")}
                />
              )}
            </div>
            <div className="field">
              <label>{t.tr("Every (hours)", "间隔（小时）")}</label>
              <input
                type="number"
                min={1}
                max={24 * 365}
                step={1}
                value={backupPresetEveryHours}
                onChange={(e) => setBackupPresetEveryHours(Math.max(1, Math.round(Number(e.target.value))))}
              />
              <div className="hint">{t.tr("Uses every_sec internally.", "内部使用 every_sec。")}</div>
            </div>
            <div className="field">
              <label>{t.tr("Keep last (0 = no prune)", "保留数量（0 = 不清理）")}</label>
              <input
                type="number"
                min={0}
                max={1000}
                step={1}
                value={backupPresetKeepLast}
                onChange={(e) => setBackupPresetKeepLast(Math.max(0, Math.round(Number(e.target.value))))}
              />
            </div>
            <div className="field">
              <label>{t.tr("Options", "选项")}</label>
              <label className="checkRow">
                <input type="checkbox" checked={backupPresetStopServer} onChange={(e) => setBackupPresetStopServer(e.target.checked)} />
                {t.tr("Stop server before backup (recommended)", "备份前停止服务器（推荐）")}
              </label>
              <div className="hint">{t.tr("Tip: Save updates schedule.json on the daemon.", "提示：点击 Save 才会写入 daemon 的 schedule.json。")}</div>
            </div>
          </div>
        </div>

        <textarea
          value={scheduleText}
          onChange={(e) => setScheduleText(e.target.value)}
          rows={14}
          placeholder='{"tasks":[{"id":"daily-backup","type":"backup","instance_id":"server1","every_sec":86400,"keep_last":7}]}'
          style={{ width: "100%", marginTop: 10 }}
          disabled={!selectedDaemon?.connected}
        />

        {parsedSchedule.ok && Array.isArray((parsedSchedule as any).schedule?.tasks) ? (
          <div style={{ marginTop: 12 }}>
            <h3>{t.tr("Tasks", "任务")}</h3>
            <table>
              <thead>
                <tr>
                  <th>{t.tr("ID", "ID")}</th>
                  <th>{t.tr("Type", "类型")}</th>
                  <th>{t.tr("Instance", "实例")}</th>
                  <th>{t.tr("Every", "间隔")}</th>
                  <th>{t.tr("At", "时间")}</th>
                  <th>{t.tr("Last run", "上次运行")}</th>
                  <th>{t.tr("Error", "错误")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {((parsedSchedule as any).schedule?.tasks || []).map((t: any) => (
                  <tr key={String(t.id || t.instance_id || t.type || "")}>
                    <td>
                      <code>{String(t.id || "-")}</code>
                    </td>
                    <td>{String(t.type || "-")}</td>
                    <td>
                      <code>{String(t.instance_id || "-")}</code>
                    </td>
                    <td>{t.every_sec ? `${Number(t.every_sec)}s` : "-"}</td>
                    <td>{t.at_unix ? fmtUnix(Number(t.at_unix)) : "-"}</td>
                    <td>{t.last_run_unix ? fmtUnix(Number(t.last_run_unix)) : "-"}</td>
                    <td style={{ maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {String(t.last_error || "")}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={async () => {
                          const id = String(t.id || "").trim();
                          if (!id) return;
                          const ok = await confirmDialog(t.tr(`Run task "${id}" now?`, `立即运行任务「${id}」？`), {
                            title: t.tr("Run Task", "运行任务"),
                            confirmLabel: t.tr("Run", "运行"),
                            cancelLabel: t.tr("Cancel", "取消"),
                            danger: String(t.type || "").toLowerCase() === "restart",
                          });
                          if (!ok) return;
                          setScheduleBusy(true);
                          setScheduleStatus(t.tr(`Running ${id} ...`, `正在运行 ${id} ...`));
                          try {
                            await runScheduleTask(id);
                            await fetchSchedule();
                            setScheduleStatus(t.tr("Done", "完成"));
                            window.setTimeout(() => setScheduleStatus(""), 900);
                          } catch (e: any) {
                            setScheduleStatus(String(e?.message || e));
                          } finally {
                            setScheduleBusy(false);
                          }
                        }}
                        disabled={!selectedDaemon?.connected || scheduleBusy}
                      >
                        {t.tr("Run now", "立即运行")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 8 }}>
              {t.tr(
                "Note: Scheduler runs on the daemon (polls schedule.json). Save updates the file; Run now triggers a single task immediately.",
                "提示：Scheduler 运行在 Daemon 上（轮询 schedule.json）。Save 会更新文件；Run now 立即触发单个任务。"
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
