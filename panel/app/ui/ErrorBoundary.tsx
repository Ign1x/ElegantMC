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

  tr(en: string, zh: string) {
    try {
      const locale = String(localStorage.getItem("elegantmc_locale") || "en").toLowerCase();
      return locale.startsWith("zh") ? zh : en;
    } catch {
      return en;
    }
  }

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

  resetUiState = () => {
    try {
      const keys = Object.keys(localStorage || {});
      for (const k of keys) {
        if (String(k || "").startsWith("elegantmc_")) localStorage.removeItem(k);
      }
    } catch {
      // ignore
    }
    try {
      location.reload();
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
              <div style={{ fontWeight: 800 }}>{this.tr("Something went wrong", "出错了")}</div>
              <div className="hint">{this.tr("The UI crashed. Reload the page, or copy debug info.", "UI 崩溃了。你可以刷新页面，或复制调试信息。")}</div>
            </div>
            <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
              <button type="button" onClick={() => location.reload()}>
                {this.tr("Reload", "刷新")}
              </button>
              <button type="button" className="iconBtn" onClick={this.copy}>
                {this.tr("Copy debug info", "复制调试信息")}
              </button>
              <button type="button" className="dangerBtn iconBtn" onClick={this.resetUiState} title={this.tr("Clears local UI cache", "清理本地 UI 缓存")}>
                {this.tr("Reset UI state", "重置 UI 状态")}
              </button>
              <button type="button" onClick={this.reset} title={this.tr("Try to recover without reload", "尝试不刷新恢复")}>
                {this.tr("Try again", "重试")}
              </button>
            </div>
          </div>

          <div className="card danger" style={{ marginTop: 12 }}>
            <b>{this.tr("Error:", "错误：")}</b> {msg}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary className="hint" style={{ cursor: "pointer" }}>
              {this.tr("Details", "详情")}
            </summary>
            <pre style={{ marginTop: 8, padding: 12, borderRadius: 12, border: "1px solid var(--border)", overflow: "auto", maxHeight: 420 }}>
              {details}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
