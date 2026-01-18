"use client";

import type { ReactNode } from "react";
import React from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  details: string;
};

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, details: "" };

  static getDerivedStateFromError(error: Error): State {
    return { error, details: "" };
  }

  componentDidCatch(error: Error, info: any) {
    const stack = String(error?.stack || error?.message || error);
    const componentStack = String(info?.componentStack || "");
    const details = [stack, componentStack ? `\nComponent stack:\n${componentStack}` : ""].join("");
    this.setState({ error, details });
  }

  reset = () => {
    this.setState({ error: null, details: "" });
  };

  copy = async () => {
    const text = this.state.details || String(this.state.error?.stack || this.state.error?.message || this.state.error || "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = String(this.state.error?.message || this.state.error || "Unknown error");
    const details = this.state.details || String(this.state.error?.stack || msg);

    return (
      <div className="modalOverlay">
        <div className="modal" style={{ width: "min(860px, 100%)" }}>
          <div className="modalHeader">
            <div>
              <div style={{ fontWeight: 800 }}>Something went wrong</div>
              <div className="hint">The UI crashed. You can reload, or copy details for debugging.</div>
            </div>
            <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
              <button type="button" onClick={() => location.reload()}>
                Reload
              </button>
              <button type="button" onClick={this.reset}>
                Reset
              </button>
            </div>
          </div>

          <div className="card danger" style={{ marginTop: 12 }}>
            <b>Error:</b> {msg}
          </div>

          <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center" }}>
            <div className="hint">Details</div>
            <button type="button" onClick={this.copy}>
              Copy
            </button>
          </div>
          <pre style={{ marginTop: 8, padding: 12, borderRadius: 12, border: "1px solid var(--border)", overflow: "auto", maxHeight: 420 }}>
            {details}
          </pre>
        </div>
      </div>
    );
  }
}

