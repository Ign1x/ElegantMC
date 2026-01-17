"use client";

import { useAppCtx } from "../appCtx";

export default function AdvancedView() {
  const { cmdName, setCmdName, cmdArgs, setCmdArgs, cmdResult, runAdvancedCommand, selectedDaemon, selected, setSelected, daemons } = useAppCtx();

  return (
    <div className="card">
      <h2>Advanced Command</h2>
      <div className="grid2">
        <div className="field">
          <label>name</label>
          <input value={cmdName} onChange={(e: any) => setCmdName(e.target.value)} placeholder="ping / frp_start / mc_start ..." />
        </div>
        <div className="field">
          <label>daemon</label>
          <select value={selected} onChange={(e: any) => setSelected(e.target.value)}>
            {daemons.map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.id} {d.connected ? "(online)" : "(offline)"}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>args (JSON)</label>
          <textarea value={cmdArgs} onChange={(e: any) => setCmdArgs(e.target.value)} rows={8} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={runAdvancedCommand}>
          Run
        </button>
        <span className="muted">
          selected: <b>{selectedDaemon?.id || "-"}</b>
        </span>
      </div>
      {cmdResult ? (
        <div style={{ marginTop: 12 }}>
          <h3>Result</h3>
          <pre>{JSON.stringify(cmdResult, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

