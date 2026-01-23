"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

type DiffLine = {
  type: "equal" | "insert" | "delete";
  aNo: number | null;
  bNo: number | null;
  text: string;
};

function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeNewlines(text: string) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function myersDiff(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  if (max === 0) {
    trace.push(v);
    return { trace, offset };
  }

  for (let d = 0; d <= max; d++) {
    const vNext = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const kIndex = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[kIndex - 1] < v[kIndex + 1])) {
        x = v[kIndex + 1];
      } else {
        x = v[kIndex - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      vNext[kIndex] = x;
      if (x >= n && y >= m) {
        trace.push(vNext);
        return { trace, offset };
      }
    }
    trace.push(vNext);
    v = vNext;
  }
  return { trace, offset };
}

function buildDiffOps(trace: number[][], offset: number, a: string[], b: string[]) {
  let x = a.length;
  let y = b.length;
  const out: { type: "equal" | "insert" | "delete"; line: string }[] = [];

  for (let d = trace.length - 1; d > 0; d--) {
    const prevV = trace[d - 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prevV[offset + k - 1] < prevV[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prevV[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      out.push({ type: "equal", line: a[x - 1] ?? "" });
      x--;
      y--;
    }

    if (x === prevX) {
      out.push({ type: "insert", line: b[prevY] ?? "" });
      y = prevY;
    } else {
      out.push({ type: "delete", line: a[prevX] ?? "" });
      x = prevX;
    }
  }

  while (x > 0 && y > 0) {
    out.push({ type: "equal", line: a[x - 1] ?? "" });
    x--;
    y--;
  }

  return out.reverse();
}

function computeDiffLines(aText: string, bText: string) {
  const a = normalizeNewlines(aText).split("\n");
  const b = normalizeNewlines(bText).split("\n");
  const { trace, offset } = myersDiff(a, b);
  const ops = buildDiffOps(trace, offset, a, b);

  const lines: DiffLine[] = [];
  let aNo = 1;
  let bNo = 1;
  for (const op of ops) {
    if (op.type === "equal") {
      lines.push({ type: "equal", aNo, bNo, text: op.line });
      aNo++;
      bNo++;
      continue;
    }
    if (op.type === "delete") {
      lines.push({ type: "delete", aNo, bNo: null, text: op.line });
      aNo++;
      continue;
    }
    lines.push({ type: "insert", aNo: null, bNo, text: op.line });
    bNo++;
  }
  return lines;
}

function highlightJson(text: string) {
  const src = normalizeNewlines(text);
  const re = /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],:])/g;
  let out = "";
  let last = 0;
  for (const m of src.matchAll(re)) {
    const idx = m.index ?? 0;
    out += escapeHtml(src.slice(last, idx));
    const full = m[0] ?? "";
    if (m[1] != null) {
      const rest = src.slice(idx + full.length);
      const isKey = /^\s*:/.test(rest);
      out += `<span class="tok ${isKey ? "tokKey" : "tokString"}">${escapeHtml(full)}</span>`;
    } else if (m[2] != null) {
      out += `<span class="tok tokNumber">${escapeHtml(full)}</span>`;
    } else if (m[3] != null) {
      out += `<span class="tok tokKeyword">${escapeHtml(full)}</span>`;
    } else {
      out += `<span class="tok tokPunc">${escapeHtml(full)}</span>`;
    }
    last = idx + full.length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

function highlightYaml(text: string) {
  const lines = normalizeNewlines(text).split("\n");
  const outLines: string[] = [];

  const tokRe = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null|yes|no|on|off)\b|([{}\[\],])/gi;

  const highlightInline = (src: string) => {
    let out = "";
    let last = 0;
    for (const m of src.matchAll(tokRe)) {
      const idx = m.index ?? 0;
      out += escapeHtml(src.slice(last, idx));
      const full = m[0] ?? "";
      if (m[1] != null) out += `<span class="tok tokString">${escapeHtml(full)}</span>`;
      else if (m[2] != null) out += `<span class="tok tokNumber">${escapeHtml(full)}</span>`;
      else if (m[3] != null) out += `<span class="tok tokKeyword">${escapeHtml(full)}</span>`;
      else out += `<span class="tok tokPunc">${escapeHtml(full)}</span>`;
      last = idx + full.length;
    }
    out += escapeHtml(src.slice(last));
    return out;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      outLines.push("");
      continue;
    }
    if (trimmed.startsWith("#")) {
      outLines.push(`<span class="tok tokComment">${escapeHtml(line)}</span>`);
      continue;
    }

    const commentIdx = line.indexOf("#");
    const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";

    const m = code.match(/^(\s*-?\s*)([^:#\s][^:#]*?)(\s*:)(.*)$/);
    let html = "";
    if (m) {
      const [, ws, key, colon, rest] = m;
      html = `${escapeHtml(ws)}<span class="tok tokKey">${escapeHtml(key)}</span><span class="tok tokPunc">${escapeHtml(colon)}</span>${highlightInline(
        rest || ""
      )}`;
    } else {
      html = highlightInline(code);
    }

    const commentHtml = comment ? `<span class="tok tokComment">${escapeHtml(comment)}</span>` : "";
    outLines.push(html + commentHtml);
  }

  return outLines.join("\n");
}

function highlightProperties(text: string) {
  const lines = normalizeNewlines(text).split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) {
      out.push("");
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
      out.push(`<span class="tok tokComment">${escapeHtml(line)}</span>`);
      continue;
    }
    const m = line.match(/^(\s*)([^=:#\s][^=:#]*?)(\s*[=:])(\s*)(.*)$/);
    if (!m) {
      out.push(escapeHtml(line));
      continue;
    }
    const [, ws, key, sep, ws2, rest] = m;
    out.push(
      `${escapeHtml(ws)}<span class="tok tokKey">${escapeHtml(key)}</span><span class="tok tokPunc">${escapeHtml(sep)}</span>${escapeHtml(ws2)}<span class="tok tokString">${escapeHtml(rest)}</span>`
    );
  }
  return out.join("\n");
}

function highlightLog(text: string) {
  const lines = normalizeNewlines(text).split("\n");
  const out: string[] = [];
  const tsRe = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)/;
  const lvlRe = /\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b/g;
  for (const line of lines) {
    let html = escapeHtml(line);
    const m = line.match(tsRe);
    if (m?.[1]) {
      const ts = escapeHtml(m[1]);
      html = html.replace(ts, `<span class="tok tokNumber">${ts}</span>`);
    }
    html = html.replace(lvlRe, (mm) => `<span class="tok tokKeyword">${escapeHtml(mm)}</span>`);
    out.push(html);
  }
  return out.join("\n");
}

function highlightToHtml(text: string, kind: "json" | "yaml" | "properties" | "log") {
  const src = normalizeNewlines(text);
  const raw =
    kind === "json"
      ? highlightJson(src)
      : kind === "yaml"
        ? highlightYaml(src)
        : kind === "properties"
          ? highlightProperties(src)
          : highlightLog(src);

  const lines = raw.split("\n");
  return lines.map((l) => `<span class=\"codeLine\">${l || "&nbsp;"}</span>`).join("");
}

export default function FilesView() {
  const {
    t,
    selected,
    instanceId,
    fsPath,
    fsBreadcrumbs,
    fsStatus,
    fsEntries,
    fsSelectedFile,
    fsDirty,
    fsSelectedFileMode,
    fsFileText,
    setFsFileText,
    fsPreviewUrl,
    setFsSelectedFile,
    setFsPath,
    openEntry,
    openFileByPath,
    fsReadText,
    setServerJarFromFile,
    saveFile,
    uploadInputKey,
    uploadFile,
    setUploadFile,
    uploadSelectedFile,
    uploadFilesNow,
    uploadZipAndExtractHere,
    uploadStatus,
    joinRelPath,
    parentRelPath,
    fmtBytes,
    fmtUnix,
    refreshFsNow,
    mkdirFsHere,
    createFileHere,
    renameFsEntry,
    moveFsEntry,
    downloadFsEntry,
    downloadFsFolderAsZip,
    deleteFsEntry,
    bulkDeleteFsEntries,
    bulkMoveFsEntries,
    openTrashModal,
    copyText,
    confirmDialog,
  } = useAppCtx();

  const [queryRaw, setQueryRaw] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [dragOver, setDragOver] = useState<boolean>(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [listScrollTop, setListScrollTop] = useState<number>(0);
  const [listViewportH, setListViewportH] = useState<number>(520);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [jsonCheck, setJsonCheck] = useState<{ ok: boolean; message: string; line?: number; col?: number; pos?: number } | null>(null);
  const [yamlCheck, setYamlCheck] = useState<{ ok: boolean; message: string; line?: number; col?: number; pos?: number } | null>(null);
  const [showHighlight, setShowHighlight] = useState<boolean>(true);
  const [diffOpen, setDiffOpen] = useState<boolean>(false);
  const [diffBasePath, setDiffBasePath] = useState<string>("");
  const [diffOtherPath, setDiffOtherPath] = useState<string>("");
  const [diffUseBufferBase, setDiffUseBufferBase] = useState<boolean>(true);
  const [diffStatus, setDiffStatus] = useState<string>("");
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(queryRaw), 160);
    return () => window.clearTimeout(t);
  }, [queryRaw]);

  useEffect(() => {
    setSelectedNames([]);
  }, [fsPath, fsEntries]);

  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    setListViewportH(el.clientHeight || 520);

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setListViewportH(el.clientHeight || 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setListScrollTop(0);
  }, [fsPath, query]);

  useEffect(() => {
    setJsonCheck(null);
    setYamlCheck(null);
    setDiffStatus("");
    setDiffLines(null);
    setDiffOpen(false);
  }, [fsSelectedFile]);

  const viewEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(fsEntries) ? fsEntries : [];
    if (!q) return list;
    return list.filter((e: any) => String(e?.name || "").toLowerCase().includes(q));
  }, [fsEntries, query]);

  const fileListVirtual = useMemo(() => {
    const list = Array.isArray(viewEntries) ? viewEntries : [];
    const total = list.length;
    const enabled = total > 400;
    if (!enabled) return { enabled: false, visible: list, start: 0, topPad: 0, bottomPad: 0 };

    const rowH = 42;
    const overscan = 8;
    const start = Math.max(0, Math.floor(listScrollTop / rowH) - overscan);
    const visibleCount = Math.ceil(listViewportH / rowH) + overscan * 2;
    const end = Math.min(total, start + visibleCount);
    const topPad = start * rowH;
    const bottomPad = Math.max(0, (total - end) * rowH);
    return { enabled: true, visible: list.slice(start, end), start, topPad, bottomPad };
  }, [viewEntries, listScrollTop, listViewportH]);

  const selectedSet = useMemo(() => new Set(selectedNames), [selectedNames]);
  const visibleNames = useMemo(
    () => (Array.isArray(viewEntries) ? viewEntries : []).map((e: any) => String(e?.name || "").trim()).filter(Boolean),
    [viewEntries]
  );
  const allVisibleSelected = visibleNames.length > 0 && visibleNames.every((n) => selectedSet.has(n));
  const someVisibleSelected = visibleNames.some((n) => selectedSet.has(n));
  const selectedEntries = useMemo(() => {
    const byName = new Map<string, any>();
    for (const e of Array.isArray(fsEntries) ? fsEntries : []) {
      const n = String(e?.name || "").trim();
      if (n) byName.set(n, e);
    }
    return selectedNames.map((n) => byName.get(n)).filter(Boolean);
  }, [fsEntries, selectedNames]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  const inst = String(instanceId || "").trim();
  const entriesLoading = fsStatus === "Loading..." && !fsEntries.length;

  const fileLower = String(fsSelectedFile || "").toLowerCase();
  const isJson = !!fsSelectedFile && fsSelectedFileMode === "text" && fileLower.endsWith(".json");
  const isYaml = !!fsSelectedFile && fsSelectedFileMode === "text" && (fileLower.endsWith(".yaml") || fileLower.endsWith(".yml"));
  const isProperties = !!fsSelectedFile && fsSelectedFileMode === "text" && fileLower.endsWith(".properties");
  const isLog = !!fsSelectedFile && fsSelectedFileMode === "text" && fileLower.endsWith(".log");

  const highlightKind = (isJson ? "json" : isYaml ? "yaml" : isProperties ? "properties" : isLog ? "log" : "") as
    | ""
    | "json"
    | "yaml"
    | "properties"
    | "log";
  const highlightEligible = !!highlightKind && String(fsFileText || "").length <= 200_000;
  const highlightHtml = useMemo(() => {
    if (!showHighlight || !highlightEligible || !highlightKind) return "";
    return highlightToHtml(String(fsFileText || ""), highlightKind);
  }, [fsFileText, highlightEligible, highlightKind, showHighlight]);

  function jsonErrorLocation(text: string, err: any) {
    const msg = String(err?.message || err);
    const m = msg.match(/position\s+(\d+)/i);
    if (!m) return { message: msg } as { message: string; pos?: number; line?: number; col?: number };
    const pos = Math.max(0, Math.min(text.length, Math.floor(Number(m[1]))));
    const upto = text.slice(0, pos);
    const lines = upto.split("\n");
    const line = lines.length;
    const col = (lines[lines.length - 1]?.length ?? 0) + 1;
    return { message: msg, pos, line, col };
  }

  function focusEditorAt(pos: number) {
    const el = editorRef.current;
    if (!el) return;
    try {
      el.focus();
      el.setSelectionRange(pos, pos);
    } catch {
      // ignore
    }
  }

  function toggleSelectedName(nameRaw: string, checked: boolean) {
    const name = String(nameRaw || "").trim();
    if (!name) return;
    setSelectedNames((prev) => {
      const s = new Set(prev);
      if (checked) s.add(name);
      else s.delete(name);
      return Array.from(s);
    });
  }

  function toggleAllVisible() {
    setSelectedNames((prev) => {
      const s = new Set(prev);
      const all = visibleNames.length > 0 && visibleNames.every((n) => s.has(n));
      if (all) for (const n of visibleNames) s.delete(n);
      else for (const n of visibleNames) s.add(n);
      return Array.from(s);
    });
  }

  async function downloadSelectedNow() {
    for (const e of selectedEntries) {
      if (!e) continue;
      if (e.isDir) await downloadFsFolderAsZip(e);
      else await downloadFsEntry(e);
    }
  }

  async function bulkMoveSelectedNow() {
    const ok = await bulkMoveFsEntries(selectedEntries);
    if (ok) setSelectedNames([]);
  }

  async function bulkDeleteSelectedNow() {
    const ok = await bulkDeleteFsEntries(selectedEntries);
    if (ok) setSelectedNames([]);
  }

  function validateJsonNow() {
    const text = String(fsFileText || "");
    try {
      JSON.parse(text);
      setJsonCheck({ ok: true, message: t.tr("JSON valid", "JSON 有效") });
    } catch (e: any) {
      const loc = jsonErrorLocation(text, e);
      setJsonCheck({ ok: false, message: loc.message, line: loc.line, col: loc.col, pos: loc.pos });
      if (typeof loc.pos === "number") focusEditorAt(loc.pos);
    }
  }

  function formatJsonNow() {
    const text = String(fsFileText || "");
    try {
      const obj = JSON.parse(text);
      const pretty = JSON.stringify(obj, null, 2) + "\n";
      setFsFileText(pretty);
      setJsonCheck({ ok: true, message: t.tr("Formatted JSON", "已格式化 JSON") });
    } catch (e: any) {
      const loc = jsonErrorLocation(text, e);
      setJsonCheck({ ok: false, message: loc.message, line: loc.line, col: loc.col, pos: loc.pos });
      if (typeof loc.pos === "number") focusEditorAt(loc.pos);
    }
  }

  function validateYamlNow() {
    const text = normalizeNewlines(String(fsFileText || ""));
    const lines = text.split("\n");
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      const lead = (line.match(/^[ \t]*/) || [""])[0] || "";

      if (!trimmed || trimmed.startsWith("#")) {
        pos += line.length + 1;
        continue;
      }

      if (lead.includes("\t")) {
        setYamlCheck({
          ok: false,
          message: t.tr("YAML indentation cannot use tabs", "YAML 缩进不能使用 Tab"),
          line: i + 1,
          col: 1,
          pos,
        });
        focusEditorAt(pos);
        return;
      }

      if (lead.length % 2 !== 0) {
        setYamlCheck({
          ok: false,
          message: t.tr("Indentation must be a multiple of 2 spaces", "缩进必须是 2 的倍数（空格）"),
          line: i + 1,
          col: 1,
          pos,
        });
        focusEditorAt(pos);
        return;
      }

      const rest = line.slice(lead.length);
      if (rest.startsWith("-") && rest.length > 1 && rest[1] !== " " && rest[1] !== "\t") {
        setYamlCheck({
          ok: false,
          message: t.tr("List item must start with '- '", "列表项必须以 '- ' 开头"),
          line: i + 1,
          col: lead.length + 2,
          pos: pos + lead.length + 1,
        });
        focusEditorAt(pos + lead.length + 1);
        return;
      }

      pos += line.length + 1;
    }
    setYamlCheck({ ok: true, message: t.tr("YAML passed basic checks", "YAML 通过基础校验") });
  }

  async function runDiffNow() {
    const basePath = String(diffBasePath || "").trim();
    const otherPath = String(diffOtherPath || "").trim();
    if (!basePath || !otherPath) {
      setDiffStatus(t.tr("Pick two files", "请选择两个文件"));
      return;
    }
    if (basePath === otherPath) {
      setDiffStatus(t.tr("Files must be different", "两个文件必须不同"));
      return;
    }

    setDiffStatus(t.tr("Loading...", "加载中..."));
    setDiffLines(null);
    try {
      const baseText =
        diffUseBufferBase && basePath === fsSelectedFile && fsSelectedFileMode === "text" ? String(fsFileText || "") : await fsReadText(basePath);
      const otherText = await fsReadText(otherPath);
      const lines = computeDiffLines(baseText, otherText);
      if (lines.length > 20_000) {
        throw new Error(t.tr("Diff too large to render", "Diff 过大，无法渲染"));
      }
      setDiffLines(lines);
      setDiffStatus(
        t.tr(
          `Done: ${lines.filter((l) => l.type === "insert").length} +, ${lines.filter((l) => l.type === "delete").length} -`,
          `完成：新增 ${lines.filter((l) => l.type === "insert").length} 行，删除 ${lines.filter((l) => l.type === "delete").length} 行`
        )
      );
    } catch (e: any) {
      setDiffLines(null);
      setDiffStatus(String(e?.message || e));
    }
  }

  if (!selected) {
    return (
      <div className="card">
        <div className="toolbar">
          <div className="toolbarLeft" style={{ alignItems: "center" }}>
            <div>
              <h2>{t.tr("Files", "文件")}</h2>
              <div className="hint">{t.tr("Select a daemon first, then pick a game to quick-open common files.", "先选择一个 Daemon，再选择游戏以快速打开常用文件。")}</div>
            </div>
          </div>
        </div>
        <div className="emptyState">{t.tr("No daemon selected.", "未选择 Daemon。")}</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="toolbar">
        <div className="toolbarLeft" style={{ alignItems: "center" }}>
          <div>
            <h2>{t.tr("Files", "文件")}</h2>
            <div className="hint">
              {t.tr("sandbox", "沙箱")}: <code>servers/</code>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {fsBreadcrumbs.map((c: any, idx: number) => (
                <span key={`${c.path}-${idx}`}>
                  {idx ? <span className="muted"> / </span> : null}
                  <button
                    type="button"
                    className="linkBtn"
                    onClick={async () => {
                      if (fsDirty) {
                        const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
                          title: "Unsaved Changes",
                          confirmLabel: "Discard",
                          cancelLabel: "Cancel",
                          danger: true,
                        });
                        if (!ok) return;
                      }
                      setFsSelectedFile("");
                      setFsFileText("");
                      setFsPath(c.path);
                    }}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="iconBtn iconOnly"
                title={t.tr("Copy path", "复制路径")}
                aria-label={t.tr("Copy path", "复制路径")}
                style={{ marginLeft: 8 }}
                onClick={() => {
                  const p = fsPath ? `servers/${fsPath}` : "servers/";
                  copyText(p);
                }}
              >
                <Icon name="copy" />
              </button>
            </div>
            {fsStatus ? <div className="hint">{fsStatus}</div> : null}
          </div>
        </div>
        <div className="toolbarRight">
          <div style={{ width: 220 }}>
            <Select
              value=""
              onChange={(v) => (v ? openFileByPath(v) : null)}
              disabled={!selected || !inst}
              placeholder={inst ? t.tr("Quick open…", "快速打开…") : t.tr("Select a game first", "请先选择游戏")}
              options={[
                { value: joinRelPath(inst, "server.properties"), label: "server.properties" },
                { value: joinRelPath(inst, "eula.txt"), label: "eula.txt" },
                { value: joinRelPath(inst, "logs/latest.log"), label: "logs/latest.log" },
                { value: joinRelPath(inst, ".elegantmc.json"), label: ".elegantmc.json" },
              ]}
            />
          </div>
	          <input value={queryRaw} onChange={(e: any) => setQueryRaw(e.target.value)} placeholder={t.tr("Search entries…", "搜索条目…")} style={{ width: 220 }} />
          <button type="button" onClick={() => refreshFsNow()} disabled={!selected}>
            {t.tr("Refresh", "刷新")}
          </button>
          <button type="button" onClick={() => openTrashModal({ showAll: true })} disabled={!selected}>
            {t.tr("Trash", "回收站")}
          </button>
          <button type="button" className="iconBtn" onClick={mkdirFsHere} disabled={!selected}>
            <Icon name="plus" />
            {t.tr("New folder", "新建文件夹")}
          </button>
          <button type="button" className="iconBtn" onClick={createFileHere} disabled={!selected}>
            <Icon name="plus" />
            {t.tr("New file", "新建文件")}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (fsDirty) {
                const ok = await confirmDialog(`Discard unsaved changes in ${fsSelectedFile}?`, {
                  title: "Unsaved Changes",
                  confirmLabel: "Discard",
                  cancelLabel: "Cancel",
                  danger: true,
                });
                if (!ok) return;
              }
              setFsSelectedFile("");
              setFsFileText("");
              setFsPath(parentRelPath(fsPath));
            }}
            disabled={!fsPath}
          >
            {t.tr("Up", "上级")}
          </button>
          <span className="badge">
            {viewEntries.length}/{fsEntries.length}
          </span>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          border: dragOver ? "2px dashed var(--ok)" : "1px dashed var(--border)",
          borderRadius: 12,
          padding: 10,
          background: dragOver ? "rgba(46, 204, 113, 0.08)" : "transparent",
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = e.dataTransfer?.files;
          if (files && files.length) uploadFilesNow(files);
        }}
      >
        <div className="row">
          <input
            key={uploadInputKey}
            type="file"
            onChange={(e) => setUploadFile(e.target.files && e.target.files.length ? e.target.files[0] : null)}
          />
          <button type="button" onClick={uploadSelectedFile} disabled={!uploadFile}>
            {t.tr("Upload", "上传")}
          </button>
          <button
            type="button"
            onClick={uploadZipAndExtractHere}
            disabled={!uploadFile || !String(uploadFile?.name || "").toLowerCase().endsWith(".zip") || !fsPath}
            title={fsPath ? "" : t.tr("Cannot extract to servers/ root; select a folder first", "不能解压到 servers/ 根目录；请先选择文件夹")}
          >
            {t.tr("Upload & Extract (.zip)", "上传并解压 (.zip)")}
          </button>
          {uploadFile ? (
            <span className="muted">
              {t.tr("to", "到")}: <code>{joinRelPath(fsPath, uploadFile.name)}</code>
            </span>
          ) : null}
          {uploadStatus ? <span className="muted">{uploadStatus}</span> : null}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {t.tr("Drag & drop files here to upload into", "将文件拖拽到这里上传到")} <code>servers/{fsPath || ""}</code>.
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <h3>{t.tr("Entries", "条目")}</h3>
          {selectedNames.length ? (
            <div className="row" style={{ marginBottom: 8, justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span className="badge">
                {t.tr("selected", "已选择")}: {selectedNames.length}
              </span>
              <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setSelectedNames([])} disabled={!selectedNames.length}>
                  {t.tr("Clear", "清空")}
                </button>
                <button type="button" className="iconBtn" onClick={downloadSelectedNow} disabled={!selectedEntries.length}>
                  <Icon name="download" />
                  {t.tr("Download", "下载")}
                </button>
                <button type="button" onClick={bulkMoveSelectedNow} disabled={!selectedEntries.length}>
                  {t.tr("Move", "移动")}
                </button>
                <button type="button" className="dangerBtn" onClick={bulkDeleteSelectedNow} disabled={!selectedEntries.length}>
                  {t.tr("Delete", "删除")}
                </button>
              </div>
            </div>
          ) : null}
          <div
            className="tableScroll"
            ref={listScrollRef}
            onScroll={(e) => setListScrollTop(e.currentTarget.scrollTop)}
            style={{ maxHeight: 520, overflow: "auto" }}
          >
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={!visibleNames.length}
                      aria-label={t.tr("Select all", "全选")}
                    />
                  </th>
                  <th>{t.tr("Name", "名称")}</th>
                  <th>{t.tr("Type", "类型")}</th>
                  <th>{t.tr("Size", "大小")}</th>
                  <th>{t.tr("Modified", "修改时间")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entriesLoading
                  ? Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={6}>
                          <div className="skeleton" style={{ minHeight: 34, borderRadius: 12 }} />
                        </td>
                      </tr>
                    ))
                  : null}
                {!entriesLoading && fileListVirtual.enabled && fileListVirtual.topPad > 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 0, border: "none" }}>
                      <div style={{ height: fileListVirtual.topPad }} />
                    </td>
                  </tr>
                ) : null}
                {!entriesLoading
                  ? fileListVirtual.visible.map((e: any, idx: number) => (
                      <tr key={`${fileListVirtual.start + idx}-${e.name}-${e.isDir ? "d" : "f"}`}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedSet.has(String(e?.name || "").trim())}
                            onChange={(ev) => toggleSelectedName(String(e?.name || ""), ev.currentTarget.checked)}
                            aria-label={t.tr("Select", "选择")}
                          />
                        </td>
                        <td>
                          <button type="button" onClick={() => openEntry(e)} className="linkBtn">
                            {e.name}
                          </button>
                        </td>
                        <td>{e.isDir ? "dir" : "file"}</td>
                        <td>{e.isDir ? "-" : fmtBytes(Number(e.size || 0))}</td>
                        <td>{fmtUnix(Number(e.mtime_unix || 0))}</td>
                        <td style={{ textAlign: "right" }}>
                          <div className="btnGroup" style={{ justifyContent: "flex-end" }}>
                            <button type="button" onClick={() => renameFsEntry(e)}>
                              {t.tr("Rename", "重命名")}
                            </button>
                            <button type="button" onClick={() => moveFsEntry(e)}>
                              {t.tr("Move", "移动")}
                            </button>
                            {!e.isDir ? (
                              <button type="button" className="iconBtn" onClick={() => downloadFsEntry(e)}>
                                <Icon name="download" />
                                {t.tr("Download", "下载")}
                              </button>
                            ) : (
                              <button type="button" className="iconBtn" onClick={() => downloadFsFolderAsZip(e)}>
                                <Icon name="download" />
                                {t.tr("Zip", "打包")}
                              </button>
                            )}
                            <button type="button" className="dangerBtn" onClick={() => deleteFsEntry(e)}>
                              {t.tr("Delete", "删除")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  : null}
                {!entriesLoading && fileListVirtual.enabled && fileListVirtual.bottomPad > 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 0, border: "none" }}>
                      <div style={{ height: fileListVirtual.bottomPad }} />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3>{t.tr("Editor", "编辑器")}</h3>
          <div className="row">
            <span className="muted">
              {t.tr("file", "文件")}: <code>{fsSelectedFile || "-"}</code>
            </span>
            {fsDirty ? <span className="badge">{t.tr("unsaved", "未保存")}</span> : null}
            {fsSelectedFile && fsSelectedFileMode === "binary" ? <span className="badge">{t.tr("download-only", "仅下载")}</span> : null}
            {fsSelectedFile && fsSelectedFileMode === "image" ? <span className="badge">{t.tr("preview", "预览")}</span> : null}
            {fsSelectedFile &&
            fsSelectedFile.toLowerCase().endsWith(".jar") &&
            inst &&
            (fsSelectedFile === inst || fsSelectedFile.startsWith(`${inst}/`)) ? (
              <button type="button" onClick={() => setServerJarFromFile(fsSelectedFile)}>
                {t.tr("Set as server jar", "设为 server jar")}
              </button>
            ) : null}
            <button type="button" onClick={saveFile} disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}>
              {t.tr("Save", "保存")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!fsSelectedFile || fsSelectedFileMode !== "text") return;
                setDiffBasePath(fsSelectedFile);
                const candidates = (Array.isArray(fsEntries) ? fsEntries : [])
                  .filter((e: any) => e && !e.isDir)
                  .map((e: any) => joinRelPath(fsPath, String(e.name || "")))
                  .filter((p: string) => p && p !== fsSelectedFile);
                setDiffOtherPath(candidates[0] || "");
                setDiffUseBufferBase(true);
                setDiffStatus("");
                setDiffLines(null);
                setDiffOpen(true);
              }}
              disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}
            >
              {t.tr("Diff", "对比")}
            </button>
            {isJson ? (
              <>
                <button type="button" onClick={formatJsonNow} disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}>
                  {t.tr("Format JSON", "格式化 JSON")}
                </button>
                <button type="button" onClick={validateJsonNow} disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}>
                  {t.tr("Validate JSON", "校验 JSON")}
                </button>
              </>
            ) : null}
            {isYaml ? (
              <button type="button" onClick={validateYamlNow} disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}>
                {t.tr("Validate YAML", "校验 YAML")}
              </button>
            ) : null}
            {highlightKind ? (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={showHighlight}
                  onChange={(e) => setShowHighlight(e.target.checked)}
                  disabled={!highlightEligible || fsSelectedFileMode !== "text"}
                />{" "}
                {t.tr("Highlight", "高亮")}
              </label>
            ) : null}
          </div>
          {fsSelectedFileMode === "image" && fsPreviewUrl ? (
            <div style={{ marginTop: 8 }}>
              <img
                src={fsPreviewUrl}
                alt={fsSelectedFile.split("/").pop() || "image"}
                style={{ maxWidth: "100%", maxHeight: 520, borderRadius: 12, border: "1px solid var(--border)" }}
              />
            </div>
          ) : (
            <textarea
              ref={editorRef}
              value={fsFileText}
              onChange={(e) => {
                setFsFileText(e.target.value);
                if (jsonCheck && !jsonCheck.ok) setJsonCheck(null);
              }}
              rows={16}
              placeholder={
                fsSelectedFile && fsSelectedFileMode !== "text"
                  ? t.tr("Binary file (editing disabled). Use Download.", "二进制文件（禁止编辑）。请使用 Download 下载。")
                  : t.tr("Select a text file to edit (e.g. server.properties)", "选择一个文本文件进行编辑（例如 server.properties）")
              }
              style={{ width: "100%", marginTop: 8 }}
              disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}
            />
          )}
          {isJson && jsonCheck && !jsonCheck.ok ? (
            <div className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
              {t.tr("JSON error", "JSON 错误")}: {jsonCheck.message}
              {typeof jsonCheck.line === "number" && typeof jsonCheck.col === "number" ? (
                <>
                  {" "}
                  (<code>
                    {t.tr("line", "行")} {jsonCheck.line}, {t.tr("col", "列")} {jsonCheck.col}
                  </code>
                  )
                </>
              ) : null}
            </div>
          ) : isJson && jsonCheck && jsonCheck.ok ? (
            <div className="hint" style={{ color: "var(--ok)", marginTop: 6 }}>
              {jsonCheck.message}
            </div>
          ) : isYaml && yamlCheck && !yamlCheck.ok ? (
            <div className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
              {t.tr("YAML error", "YAML 错误")}: {yamlCheck.message}
              {typeof yamlCheck.line === "number" && typeof yamlCheck.col === "number" ? (
                <>
                  {" "}
                  (<code>
                    {t.tr("line", "行")} {yamlCheck.line}, {t.tr("col", "列")} {yamlCheck.col}
                  </code>
                  )
                </>
              ) : null}
            </div>
          ) : isYaml && yamlCheck && yamlCheck.ok ? (
            <div className="hint" style={{ color: "var(--ok)", marginTop: 6 }}>
              {yamlCheck.message}
            </div>
          ) : null}

          {showHighlight && highlightEligible && highlightHtml ? (
            <div style={{ marginTop: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">
                  {t.tr("Preview", "预览")}: <span className="badge">{highlightKind}</span>
                </span>
                {!highlightEligible ? <span className="hint">{t.tr("File too large to highlight", "文件过大，已禁用高亮")}</span> : null}
              </div>
              <div className="codeFrame" style={{ marginTop: 8 }}>
                <pre className="codePre">
                  <code dangerouslySetInnerHTML={{ __html: highlightHtml }} />
                </pre>
              </div>
            </div>
          ) : null}
          <div className="hint">{t.tr("Tip: binary/large files are download-only.", "提示：二进制/大文件为 download-only（可用 Download 下载）。")}</div>
        </div>
      </div>

      {diffOpen ? (
        <div className="modalOverlay" onClick={() => setDiffOpen(false)}>
          <div className="modal" style={{ width: "min(1100px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div style={{ fontWeight: 800 }}>{t.tr("Diff Viewer", "Diff 对比")}</div>
                <div className="hint">
                  {t.tr("base", "基准")}: <code>{diffBasePath || "-"}</code>
                  {" · "}
                  {t.tr("compare", "对比")}: <code>{diffOtherPath || "-"}</code>
                </div>
              </div>
              <button type="button" onClick={() => setDiffOpen(false)}>
                {t.tr("Close", "关闭")}
              </button>
            </div>

            <div className="grid2" style={{ marginTop: 12, alignItems: "end" }}>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{t.tr("Base file", "基准文件")}</label>
                <input value={diffBasePath} onChange={(e: any) => setDiffBasePath(String(e.target.value || ""))} placeholder="server1/server.properties" />
              </div>
              <div className="field">
                <label>{t.tr("Compare file", "对比文件")}</label>
                <input value={diffOtherPath} onChange={(e: any) => setDiffOtherPath(String(e.target.value || ""))} placeholder="server1/server.properties" />
              </div>
              <div className="field">
                <label>{t.tr("Pick from current folder", "从当前目录选择")}</label>
                <Select
                  value=""
                  onChange={(v) => (v ? setDiffOtherPath(v) : null)}
                  options={(viewEntries || [])
                    .filter((e: any) => e && !e.isDir)
                    .map((e: any) => ({ value: joinRelPath(fsPath, String(e.name || "")), label: String(e.name || "") }))}
                  placeholder={t.tr("Select a file…", "选择文件…")}
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={diffUseBufferBase} onChange={(e) => setDiffUseBufferBase(e.target.checked)} />{" "}
                {t.tr("Use current editor text for base (includes unsaved changes)", "基准使用当前编辑器内容（包含未保存更改）")}
              </label>
              <div className="btnGroup">
                <button
                  type="button"
                  onClick={() => {
                    const a = diffBasePath;
                    setDiffBasePath(diffOtherPath);
                    setDiffOtherPath(a);
                  }}
                >
                  {t.tr("Swap", "交换")}
                </button>
                <button type="button" className="primary" onClick={runDiffNow}>
                  {t.tr("Run", "开始")}
                </button>
              </div>
            </div>

            {diffStatus ? <div className="hint" style={{ marginTop: 8 }}>{diffStatus}</div> : null}

            {diffLines ? (
              <div className="diffFrame" style={{ marginTop: 10 }}>
                {diffLines.map((l, idx) => (
                  <div key={idx} className={`diffLine ${l.type}`}>
                    <span className="diffNo">{l.aNo ?? ""}</span>
                    <span className="diffNo">{l.bNo ?? ""}</span>
                    <span className="diffMark">{l.type === "insert" ? "+" : l.type === "delete" ? "-" : " "}</span>
                    <span className="diffText">{l.text}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
