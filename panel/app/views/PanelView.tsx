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
  const [backupPresetScheduleKind, setBackupPresetScheduleKind] = useState<"interval" | "daily" | "weekly">("daily");
  const [backupPresetEveryHours, setBackupPresetEveryHours] = useState<number>(24);
  const [backupPresetAtHour, setBackupPresetAtHour] = useState<number>(3);
  const [backupPresetAtMinute, setBackupPresetAtMinute] = useState<number>(0);
  const [backupPresetWeekday, setBackupPresetWeekday] = useState<number>(1); // Mon
  const [backupPresetKeepLast, setBackupPresetKeepLast] = useState<number>(7);
  const [backupPresetStopServer, setBackupPresetStopServer] = useState<boolean>(true);
  const [templateKind, setTemplateKind] = useState<"backup" | "restart" | "stop" | "prune_logs" | "announce">("backup");
  const [pruneLogsKeepLast, setPruneLogsKeepLast] = useState<number>(30);
  const [announceMessage, setAnnounceMessage] = useState<string>("");

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

  function clampInt(v: any, min: number, max: number, fallback: number) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function nextDailyAtUnix(hour: number, minute: number) {
    const h = clampInt(hour, 0, 23, 3);
    const m = clampInt(minute, 0, 59, 0);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return Math.floor(next.getTime() / 1000);
  }

  function nextWeeklyAtUnix(weekday: number, hour: number, minute: number) {
    const dow = clampInt(weekday, 0, 6, 1);
    const h = clampInt(hour, 0, 23, 3);
    const m = clampInt(minute, 0, 59, 0);
    const now = new Date();
    const nowDow = now.getDay();
    let addDays = (dow - nowDow + 7) % 7;
    const next = new Date(now);
    next.setDate(next.getDate() + addDays);
    next.setHours(h, m, 0, 0);
    if (addDays === 0 && next.getTime() <= now.getTime()) {
      addDays = 7;
      next.setDate(next.getDate() + 7);
    }
    return Math.floor(next.getTime() / 1000);
  }

  function buildCronLikeSchedule() {
    const kind = backupPresetScheduleKind;
    if (kind === "interval") {
      const hours = Math.max(1, clampInt(backupPresetEveryHours, 1, 24 * 365, 24));
      const everySec = Math.max(60, Math.round(hours * 3600));
      const nowUnix = Math.floor(Date.now() / 1000);
      return { every_sec: everySec, last_run_unix: nowUnix, next_run_unix: nowUnix + everySec, cron: `@every ${hours}h` };
    }
    if (kind === "weekly") {
      const everySec = 7 * 86400;
      const nextAt = nextWeeklyAtUnix(backupPresetWeekday, backupPresetAtHour, backupPresetAtMinute);
      return {
        every_sec: everySec,
        last_run_unix: nextAt - everySec,
        next_run_unix: nextAt,
        cron: `${clampInt(backupPresetAtMinute, 0, 59, 0)} ${clampInt(backupPresetAtHour, 0, 23, 3)} * * ${clampInt(backupPresetWeekday, 0, 6, 1)}`,
      };
    }
    // daily
    const everySec = 86400;
    const nextAt = nextDailyAtUnix(backupPresetAtHour, backupPresetAtMinute);
    return {
      every_sec: everySec,
      last_run_unix: nextAt - everySec,
      next_run_unix: nextAt,
      cron: `${clampInt(backupPresetAtMinute, 0, 59, 0)} ${clampInt(backupPresetAtHour, 0, 23, 3)} * * *`,
    };
  }

  function addTemplateTask() {
    if (!parsedSchedule.ok) return;
    if (scheduleBusy) return;

    const inst = String(backupPresetInstanceId || "").trim();
    if (!inst) {
      setScheduleStatus(t.tr("instance_id is required", "instance_id 不能为空"));
      return;
    }

    const scheduleSpec = buildCronLikeSchedule();

    const prev = (parsedSchedule as any).schedule;
    const next: any = typeof prev === "object" && prev ? { ...prev } : { tasks: [] };
    const tasks = Array.isArray(next.tasks) ? [...next.tasks] : [];
    const kind = templateKind;
    let task: any = null;

    if (kind === "backup") {
      const keepRaw = Math.round(Number(backupPresetKeepLast));
      const keepLast = Number.isFinite(keepRaw) && keepRaw >= 0 ? Math.min(keepRaw, 1000) : 0;
      const id = uniqueTaskId(tasks, `backup-${inst}`);
      task = {
        id,
        type: "backup",
        instance_id: inst,
        every_sec: scheduleSpec.every_sec,
        last_run_unix: scheduleSpec.last_run_unix,
        ...(keepLast > 0 ? { keep_last: keepLast } : {}),
        ...(backupPresetStopServer ? {} : { stop: false }),
      };
    } else if (kind === "restart") {
      const id = uniqueTaskId(tasks, `restart-${inst}`);
      task = { id, type: "restart", instance_id: inst, every_sec: scheduleSpec.every_sec, last_run_unix: scheduleSpec.last_run_unix };
    } else if (kind === "stop") {
      const id = uniqueTaskId(tasks, `stop-${inst}`);
      task = { id, type: "stop", instance_id: inst, every_sec: scheduleSpec.every_sec, last_run_unix: scheduleSpec.last_run_unix };
    } else if (kind === "prune_logs") {
      const keepRaw = Math.round(Number(pruneLogsKeepLast));
      const keepLast = Number.isFinite(keepRaw) ? Math.max(1, Math.min(keepRaw, 1000)) : 30;
      const id = uniqueTaskId(tasks, `prune-logs-${inst}`);
      task = { id, type: "prune_logs", instance_id: inst, every_sec: scheduleSpec.every_sec, last_run_unix: scheduleSpec.last_run_unix, keep_last: keepLast };
    } else if (kind === "announce") {
      const msg = String(announceMessage || "").trim();
      if (!msg) {
        setScheduleStatus(t.tr("message is required", "message 不能为空"));
        return;
      }
      if (msg.includes("\n") || msg.includes("\r")) {
        setScheduleStatus(t.tr("message must be single-line", "message 不能换行"));
        return;
      }
      if (msg.length > 400) {
        setScheduleStatus(t.tr("message too long (max 400)", "message 太长（最多 400）"));
        return;
      }
      const id = uniqueTaskId(tasks, `announce-${inst}`);
      task = { id, type: "announce", instance_id: inst, every_sec: scheduleSpec.every_sec, last_run_unix: scheduleSpec.last_run_unix, message: msg };
    }

    if (!task) return;
    tasks.push(task);
    next.tasks = tasks;
    applyScheduleUpdate(next);
    setScheduleStatus(t.tr("Added task. Remember to Save.", "已添加任务。记得保存。"));
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

  const nowUnix = Math.floor(Date.now() / 1000);
  const backupSchedulePreview = buildCronLikeSchedule();

  function nextRunLabel(task: any) {
    if (task?.enabled === false) return "-";
    const everyRaw = Number(task?.every_sec || 0);
    const atRaw = Number(task?.at_unix || 0);
    const last = Number(task?.last_run_unix || 0);
    if (Number.isFinite(everyRaw) && everyRaw > 0) {
      const every = Math.max(60, Math.round(everyRaw));
      const dueAt = last + every;
      if (nowUnix >= dueAt) return t.tr("Due", "已到期");
      return fmtUnix(dueAt);
    }
    if (Number.isFinite(atRaw) && atRaw > 0) {
      if (last < atRaw && nowUnix >= atRaw) return t.tr("Due", "已到期");
      if (last < atRaw) return fmtUnix(atRaw);
    }
    return "-";
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
                <div className="hint">{t.tr("Edit daemon schedule.json (scheduler tasks)", "编辑 daemon schedule.json（定时任务）")}</div>
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
            <div>
              <div style={{ fontWeight: 700 }}>{t.tr("Task Templates", "任务模板")}</div>
              <div className="hint">{t.tr("Add common tasks without hand-editing JSON.", "无需手改 JSON，快速添加常用任务。")}</div>
            </div>
            <button type="button" onClick={addTemplateTask} disabled={!selectedDaemon?.connected || scheduleBusy || !parsedSchedule.ok}>
              {t.tr("Add task", "添加任务")}
            </button>
          </div>
          <div className="grid2" style={{ marginTop: 10, alignItems: "end" }}>
            <div className="field">
              <label>{t.tr("Template", "模板")}</label>
              <Select
                value={templateKind}
                onChange={(v) => setTemplateKind((v as any) || "backup")}
                options={[
                  { value: "backup", label: t.tr("Backup", "备份") },
                  { value: "restart", label: t.tr("Restart", "重启") },
                  { value: "stop", label: t.tr("Stop", "停止") },
                  { value: "prune_logs", label: t.tr("Prune logs", "清理日志") },
                  { value: "announce", label: t.tr("Announce", "公告") },
                ]}
              />
            </div>
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
              <label>{t.tr("Schedule", "时间")}</label>
              <Select
                value={backupPresetScheduleKind}
                onChange={(v) => setBackupPresetScheduleKind((v as any) || "daily")}
                options={[
                  { value: "daily", label: t.tr("Daily at…", "每天在…") },
                  { value: "weekly", label: t.tr("Weekly at…", "每周在…") },
                  { value: "interval", label: t.tr("Interval", "固定间隔") },
                ]}
              />
              {backupPresetScheduleKind === "interval" ? (
                <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={1}
                    max={24 * 365}
                    step={1}
                    value={backupPresetEveryHours}
                    onChange={(e) => setBackupPresetEveryHours(Math.max(1, Math.round(Number(e.target.value))))}
                  />
                  <span className="muted">{t.tr("hours", "小时")}</span>
                </div>
              ) : backupPresetScheduleKind === "weekly" ? (
                <div style={{ marginTop: 8 }}>
                  <div className="row" style={{ alignItems: "center" }}>
                    <Select
                      value={String(backupPresetWeekday)}
                      onChange={(v) => setBackupPresetWeekday(Math.max(0, Math.min(6, Math.round(Number(v)))))}
                      options={[
                        { value: "1", label: t.tr("Mon", "周一") },
                        { value: "2", label: t.tr("Tue", "周二") },
                        { value: "3", label: t.tr("Wed", "周三") },
                        { value: "4", label: t.tr("Thu", "周四") },
                        { value: "5", label: t.tr("Fri", "周五") },
                        { value: "6", label: t.tr("Sat", "周六") },
                        { value: "0", label: t.tr("Sun", "周日") },
                      ]}
                    />
                    <input
                      type="number"
                      min={0}
                      max={23}
                      step={1}
                      value={backupPresetAtHour}
                      onChange={(e) => setBackupPresetAtHour(Math.max(0, Math.min(23, Math.round(Number(e.target.value)))))}
                      style={{ width: 86 }}
                    />
                    <span className="muted">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      step={1}
                      value={backupPresetAtMinute}
                      onChange={(e) => setBackupPresetAtMinute(Math.max(0, Math.min(59, Math.round(Number(e.target.value)))))}
                      style={{ width: 86 }}
                    />
                  </div>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    step={1}
                    value={backupPresetAtHour}
                    onChange={(e) => setBackupPresetAtHour(Math.max(0, Math.min(23, Math.round(Number(e.target.value)))))}
                  />
                  <span className="muted">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    step={1}
                    value={backupPresetAtMinute}
                    onChange={(e) => setBackupPresetAtMinute(Math.max(0, Math.min(59, Math.round(Number(e.target.value)))))}
                  />
                </div>
              )}
              <div className="hint">
                {t.tr("Next run", "下次运行")}: <code>{fmtUnix(Number(backupSchedulePreview.next_run_unix || nowUnix))}</code> ·{" "}
                <span className="muted">
                  {t.tr("cron (ref)", "cron（参考）")}: <code>{String(backupSchedulePreview.cron || "-")}</code>
                </span>
              </div>
            </div>

            {templateKind === "backup" ? (
              <>
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
                </div>
              </>
            ) : null}

            {templateKind === "prune_logs" ? (
              <div className="field">
                <label>{t.tr("Keep last logs", "保留日志数量")}</label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={pruneLogsKeepLast}
                  onChange={(e) => setPruneLogsKeepLast(Math.max(1, Math.round(Number(e.target.value))))}
                />
                <div className="hint">{t.tr("Keeps newest files in logs/ and deletes older ones.", "保留 logs/ 下最新的文件，删除更旧的。")}</div>
              </div>
            ) : null}

            {templateKind === "announce" ? (
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Message", "消息")}</label>
                <input
                  value={announceMessage}
                  onChange={(e) => setAnnounceMessage(e.target.value)}
                  maxLength={400}
                  placeholder={t.tr("e.g. Server will restart in 5 minutes", "例如：服务器将在 5 分钟后重启")}
                />
                <div className="hint">{t.tr("Sends: say <message>", "将执行：say <消息>")}</div>
              </div>
            ) : null}

            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <div className="hint">{t.tr("Tip: Save updates schedule.json on the daemon.", "提示：点击 Save 才会写入 daemon 的 schedule.json。")}</div>
            </div>
          </div>
        </div>

        <textarea
          value={scheduleText}
          onChange={(e) => setScheduleText(e.target.value)}
          rows={14}
          placeholder='{"tasks":[{"id":"daily-backup","type":"backup","instance_id":"server1","every_sec":86400,"keep_last":7},{"id":"daily-restart","type":"restart","instance_id":"server1","every_sec":86400}]}'
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
	                  <th>{t.tr("Next run", "下次运行")}</th>
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
	                    <td>{nextRunLabel(t)}</td>
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
                            danger: ["restart", "stop", "prune_logs"].includes(String(t.type || "").toLowerCase()),
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
