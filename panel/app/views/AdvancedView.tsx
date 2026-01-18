"use client";

import { useAppCtx } from "../appCtx";
import Select from "../ui/Select";

export default function AdvancedView() {
  const { t, cmdName, setCmdName, cmdArgs, setCmdArgs, cmdResult, runAdvancedCommand, selectedDaemon, selected, setSelected, daemons } = useAppCtx();

  return (
    <div className="card">
      <h2>{t.tr("Advanced Command", "高级命令")}</h2>
      <div className="grid2">
        <div className="field">
          <label>{t.tr("Name", "名称")}</label>
          <input
            value={cmdName}
            onChange={(e: any) => setCmdName(e.target.value)}
            placeholder={t.tr("ping / frp_start / mc_start ...", "ping / frp_start / mc_start ...")}
          />
        </div>
        <div className="field">
          <label>{t.tr("Daemon", "Daemon")}</label>
          <Select
            value={selected}
            onChange={(v) => setSelected(v)}
            options={daemons.map((d: any) => ({ value: d.id, label: `${d.id} ${d.connected ? "(online)" : "(offline)"}` }))}
          />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>{t.tr("Args (JSON)", "参数 (JSON)")}</label>
          <textarea value={cmdArgs} onChange={(e: any) => setCmdArgs(e.target.value)} rows={8} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={runAdvancedCommand}>
          {t.tr("Run", "执行")}
        </button>
        <span className="muted">
          {t.tr("selected", "当前")}: <b>{selectedDaemon?.id || "-"}</b>
        </span>
      </div>
      {cmdResult ? (
        <div style={{ marginTop: 12 }}>
          <h3>{t.tr("Result", "结果")}</h3>
          <pre>{JSON.stringify(cmdResult, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}
