"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppCtx } from "../appCtx";
import CopyButton from "../ui/CopyButton";
import Icon from "../ui/Icon";
import Select from "../ui/Select";
import Tooltip from "../ui/Tooltip";

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

function isImageFileName(name: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(name || "").trim());
}

export default function FilesView() {
  const {
    t,
    daemons,
    selected,
    setSelected,
    setTab,
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

  const openEntryRef = useRef(openEntry);
  useEffect(() => {
    openEntryRef.current = openEntry;
  }, [openEntry]);

  const [queryRaw, setQueryRaw] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [dragOver, setDragOver] = useState<boolean>(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [listScrollTop, setListScrollTop] = useState<number>(0);
  const [listViewportH, setListViewportH] = useState<number>(520);
  const listScrollSaveTimerRef = useRef<number | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: any } | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [jsonCheck, setJsonCheck] = useState<{ ok: boolean; message: string; line?: number; col?: number; pos?: number } | null>(null);
  const [yamlCheck, setYamlCheck] = useState<{ ok: boolean; message: string; line?: number; col?: number; pos?: number } | null>(null);
  const [showHighlight, setShowHighlight] = useState<boolean>(true);
  const [editorWrap, setEditorWrap] = useState<boolean>(true);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(true);
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findQuery, setFindQuery] = useState<string>("");
  const [replaceText, setReplaceText] = useState<string>("");
  const [lightboxOpen, setLightboxOpen] = useState<boolean>(false);
  const [lightboxZoom, setLightboxZoom] = useState<number>(1);
  const [lightboxPan, setLightboxPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [lightboxDragging, setLightboxDragging] = useState<boolean>(false);
  const lightboxDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
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
    if (!ctxMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctxMenu]);

  useEffect(() => {
    if (ctxMenu) setCtxMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsPath]);

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
    setFindOpen(false);
  }, [fsSelectedFile]);

  useEffect(() => {
    if (!findOpen) return;
    window.setTimeout(() => findInputRef.current?.focus(), 0);
  }, [findOpen]);

  useEffect(() => {
    if (fsSelectedFileMode !== "image") {
      if (lightboxOpen) setLightboxOpen(false);
      return;
    }
  }, [fsSelectedFileMode, lightboxOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
    setLightboxDragging(false);
    lightboxDragRef.current = null;
  }, [lightboxOpen, fsSelectedFile]);

  const imageEntries = useMemo(() => {
    const list = (Array.isArray(fsEntries) ? fsEntries : []).filter((e: any) => e && !e.isDir && isImageFileName(String(e?.name || "")));
    return list.sort((a: any, b: any) => String(a?.name || "").localeCompare(String(b?.name || "")));
  }, [fsEntries]);

  const currentImageIdx = useMemo(() => {
    if (!fsSelectedFile || fsSelectedFileMode !== "image") return -1;
    const curName = fsSelectedFile.split("/").pop() || fsSelectedFile;
    return imageEntries.findIndex((e: any) => String(e?.name || "") === curName);
  }, [fsSelectedFile, fsSelectedFileMode, imageEntries]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setLightboxOpen(false);
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setLightboxZoom((z) => Math.min(6, Math.max(0.2, Number((z * 1.2).toFixed(3)))));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setLightboxZoom((z) => Math.min(6, Math.max(0.2, Number((z / 1.2).toFixed(3)))));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setLightboxZoom(1);
        setLightboxPan({ x: 0, y: 0 });
        return;
      }
      if (e.key === "ArrowLeft" && currentImageIdx > 0) {
        e.preventDefault();
        openEntryRef.current(imageEntries[currentImageIdx - 1]);
        return;
      }
      if (e.key === "ArrowRight" && currentImageIdx >= 0 && currentImageIdx < imageEntries.length - 1) {
        e.preventDefault();
        openEntryRef.current(imageEntries[currentImageIdx + 1]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, currentImageIdx, imageEntries]);

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
  const textEditable = !!fsSelectedFile && fsSelectedFileMode === "text";
  const canSetJar =
    !!fsSelectedFile &&
    fsSelectedFile.toLowerCase().endsWith(".jar") &&
    inst &&
    (fsSelectedFile === inst || fsSelectedFile.startsWith(`${inst}/`));
  const entriesLoading = fsStatus === "Loading..." && !fsEntries.length;

  const breadcrumbsView = useMemo(() => {
    const list = Array.isArray(fsBreadcrumbs) ? fsBreadcrumbs : [];
    if (list.length <= 6) return { collapsed: false, head: list, overflow: [] as any[], tail: [] as any[] };
    const head = list.slice(0, 1);
    const tail = list.slice(-3);
    const overflow = list.slice(1, -3);
    return { collapsed: true, head, overflow, tail };
  }, [fsBreadcrumbs]);

  const ctxMenuPos = useMemo(() => {
    if (!ctxMenu) return { left: 0, top: 0 };
    const pad = 12;
    const w = 260;
    const h = 320;
    const vw = typeof window === "undefined" ? 0 : window.innerWidth;
    const vh = typeof window === "undefined" ? 0 : window.innerHeight;
    const maxLeft = Math.max(pad, vw - w - pad);
    const maxTop = Math.max(pad, vh - h - pad);
    const left = Math.max(pad, Math.min(ctxMenu.x, maxLeft));
    const top = Math.max(pad, Math.min(ctxMenu.y, maxTop));
    return { left, top };
  }, [ctxMenu]);

  async function navigateToPath(path: string) {
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
    setFsPath(path);
  }

  const listScrollKey = useMemo(() => {
    const daemonId = String(selected || "").trim();
    const p = String(fsPath || "").trim();
    const q = String(query || "").trim();
    if (!daemonId) return "";
    return `elegantmc_fs_list_scroll_v1:${daemonId}:${p}:${q}`;
  }, [selected, fsPath, query]);

  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    if (entriesLoading) return;
    if (!listScrollKey) return;
    try {
      const raw = localStorage.getItem(listScrollKey);
      const n = Math.max(0, Math.round(Number(raw || 0)));
      if (!Number.isFinite(n) || n <= 0) return;
      el.scrollTop = n;
      setListScrollTop(n);
    } catch {
      // ignore
    }
  }, [entriesLoading, listScrollKey]);

  useEffect(() => {
    if (!listScrollKey) return;
    if (listScrollSaveTimerRef.current != null) window.clearTimeout(listScrollSaveTimerRef.current);
    listScrollSaveTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(listScrollKey, String(Math.max(0, Math.round(listScrollTop))));
      } catch {
        // ignore
      }
    }, 200);
    return () => {
      if (listScrollSaveTimerRef.current != null) window.clearTimeout(listScrollSaveTimerRef.current);
    };
  }, [listScrollKey, listScrollTop]);

  const fileListRangeLabel = useMemo(() => {
    const total = Array.isArray(viewEntries) ? viewEntries.length : 0;
    const start = Math.max(0, fileListVirtual.start);
    const count = Array.isArray(fileListVirtual.visible) ? fileListVirtual.visible.length : 0;
    if (!fileListVirtual.enabled || total <= 0) return "";
    return `${Math.min(total, start + 1)}-${Math.min(total, start + count)} / ${total}`;
  }, [fileListVirtual, viewEntries]);

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

  const lineNumbers = useMemo(() => {
    if (!showLineNumbers || !fsSelectedFile || fsSelectedFileMode !== "text") return "";
    const src = String(fsFileText || "");
    const maxLines = 5000;
    const maxCount = maxLines + 1;
    let lines = 1;
    for (let i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) {
        lines += 1;
        if (lines > maxCount) break;
      }
    }
    const truncated = lines > maxLines;
    const n = truncated ? maxLines : lines;
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(String(i));
    if (truncated) out.push("…");
    return out.join("\n");
  }, [fsFileText, fsSelectedFile, fsSelectedFileMode, showLineNumbers]);

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

  function findNext(backward: boolean) {
    const el = editorRef.current;
    if (!el) return;
    const q = String(findQuery || "");
    if (!q) return;
    const text = String(el.value || "");
    if (!text) return;

    const from = backward ? Math.max(0, (el.selectionStart ?? 0) - 1) : el.selectionEnd ?? 0;
    const hit = backward ? text.lastIndexOf(q, from) : text.indexOf(q, from);
    const at = hit >= 0 ? hit : backward ? text.lastIndexOf(q) : text.indexOf(q);
    if (at < 0) return;
    try {
      el.focus();
      el.setSelectionRange(at, at + q.length);
    } catch {
      // ignore
    }
  }

  function replaceSelection() {
    const el = editorRef.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(Number(el.selectionStart ?? 0)));
    const end = Math.max(start, Math.floor(Number(el.selectionEnd ?? 0)));
    if (start === end) return;
    const text = String(el.value || "");
    const next = text.slice(0, start) + replaceText + text.slice(end);
    setFsFileText(next);
    window.setTimeout(() => {
      const el2 = editorRef.current;
      if (!el2) return;
      try {
        const pos = start + String(replaceText || "").length;
        el2.focus();
        el2.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    }, 0);
  }

  function replaceAllNow() {
    const q = String(findQuery || "");
    if (!q) return;
    const src = String(fsFileText || "");
    const next = src.split(q).join(String(replaceText || ""));
    if (next === src) return;
    setFsFileText(next);
  }

  function openDiffModalNow() {
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
    const daemonOptions = daemons.map((d: any) => ({
      value: String(d?.id || ""),
      label: (
        <span className="row" style={{ justifyContent: "space-between", gap: 10, width: "100%" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{String(d?.id || "")}</span>
          {d?.connected ? <span className="badge ok">{t.tr("online", "在线")}</span> : <span className="badge">{t.tr("offline", "离线")}</span>}
        </span>
      ),
      disabled: !d?.connected,
    }));
    const hasOnlineDaemon = daemonOptions.some((o: any) => !o.disabled);
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
        <div className="emptyState">
          <div style={{ fontWeight: 800 }}>{t.tr("No daemon selected", "未选择 Daemon")}</div>
          <div className="hint" style={{ marginTop: 6 }}>
            {hasOnlineDaemon
              ? t.tr("Pick an online daemon to browse files under servers/.", "选择一个在线的 Daemon 以浏览 servers/ 目录。")
              : daemonOptions.length
                ? t.tr("No daemons are online. Go to Nodes to deploy or troubleshoot.", "当前没有在线的 Daemon。前往 Nodes 部署或排查连接。")
              : t.tr("Create/deploy a daemon first, then come back here to browse files.", "请先创建/部署一个 Daemon，然后回来浏览文件。")}
          </div>
          <div className="btnGroup" style={{ justifyContent: "center", marginTop: 10 }}>
            {hasOnlineDaemon ? (
              <Select
                value=""
                onChange={(id) => setSelected(id)}
                options={daemonOptions}
                placeholder={t.tr("Select a daemon…", "选择一个 Daemon…")}
                style={{ width: "min(420px, 100%)" }}
              />
            ) : (
              <button type="button" className="primary" onClick={() => setTab("nodes")}>
                {t.tr("Go to Nodes", "前往 Nodes")}
              </button>
            )}
          </div>
        </div>
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
              {breadcrumbsView.collapsed ? (
                <>
                  {(breadcrumbsView.head || []).map((c: any, idx: number) => (
                    <span key={`${c.path}-${idx}`}>
                      {idx ? <span className="muted"> / </span> : null}
                      <button type="button" className="linkBtn" onClick={() => navigateToPath(c.path)}>
                        {c.label}
                      </button>
                    </span>
                  ))}
                  <span className="muted"> / </span>
                  <span style={{ display: "inline-flex", minWidth: 76 }}>
                    <Select
                      value=""
                      onChange={(v) => (v ? navigateToPath(v) : null)}
                      placeholder="…"
                      options={(breadcrumbsView.overflow || []).map((c: any) => ({ value: c.path, label: c.label }))}
                      style={{ width: 76 }}
                    />
                  </span>
                  {(breadcrumbsView.tail || []).map((c: any, idx: number) => (
                    <span key={`${c.path}-tail-${idx}`}>
                      <span className="muted"> / </span>
                      <button type="button" className="linkBtn" onClick={() => navigateToPath(c.path)}>
                        {c.label}
                      </button>
                    </span>
                  ))}
                </>
              ) : (
                (breadcrumbsView.head || []).map((c: any, idx: number) => (
                  <span key={`${c.path}-${idx}`}>
                    {idx ? <span className="muted"> / </span> : null}
                    <button type="button" className="linkBtn" onClick={() => navigateToPath(c.path)}>
                      {c.label}
                    </button>
                  </span>
                ))
              )}
              <CopyButton
                iconOnly
                text={fsPath ? `servers/${fsPath}` : "servers/"}
                tooltip={t.tr("Copy path", "复制路径")}
                ariaLabel={t.tr("Copy path", "复制路径")}
                style={{ marginLeft: 8 }}
              />
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
          {fileListRangeLabel ? (
            <div className="row" style={{ justifyContent: "space-between", gap: 10, marginTop: -6, marginBottom: 8 }}>
              <span className="muted">
                {t.tr("Range", "范围")}: <code>{fileListRangeLabel}</code>
              </span>
              {listScrollTop > 240 ? (
                <button
                  type="button"
                  className="iconBtn"
                  onClick={() => {
                    const el = listScrollRef.current;
                    if (!el) return;
                    el.scrollTop = 0;
                    setListScrollTop(0);
                  }}
                >
                  {t.tr("Back to top", "回到顶部")}
                </button>
              ) : null}
            </div>
          ) : null}
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
            onScroll={(e) => {
              setListScrollTop(e.currentTarget.scrollTop);
              if (ctxMenu) setCtxMenu(null);
            }}
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
                      <tr
                        key={`${fileListVirtual.start + idx}-${e.name}-${e.isDir ? "d" : "f"}`}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          setCtxMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                        }}
                      >
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
            {listScrollTop > 480 ? (
              <button
                type="button"
                className="logNewPill"
                onClick={() => {
                  const el = listScrollRef.current;
                  if (!el) return;
                  el.scrollTop = 0;
                  setListScrollTop(0);
                }}
                title={t.tr("Back to top", "回到顶部")}
              >
                {t.tr("Top", "顶部")}
              </button>
            ) : null}
          </div>

          {ctxMenu ? (
            <div
              className="ctxMenuOverlay"
              onMouseDown={() => setCtxMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu(null);
              }}
            >
              <div
                className="ctxMenu"
                role="menu"
                style={{ left: ctxMenuPos.left, top: ctxMenuPos.top }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="ctxMenuItem"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    setCtxMenu(null);
                    openEntry(entry);
                  }}
                >
                  {t.tr("Open", "打开")}
                </button>
                <button
                  type="button"
                  className="ctxMenuItem"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    setCtxMenu(null);
                    renameFsEntry(entry);
                  }}
                >
                  {t.tr("Rename", "重命名")}
                </button>
                <button
                  type="button"
                  className="ctxMenuItem"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    setCtxMenu(null);
                    moveFsEntry(entry);
                  }}
                >
                  {t.tr("Move", "移动")}
                </button>
                <button
                  type="button"
                  className="ctxMenuItem"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    const name = String(entry?.name || "").trim();
                    const rel = name ? joinRelPath(fsPath, name) : String(fsPath || "");
                    setCtxMenu(null);
                    copyText(rel ? `servers/${rel}` : "servers/");
                  }}
                >
                  {t.tr("Copy path", "复制路径")}
                </button>
                <div className="ctxMenuSep" />
                <button
                  type="button"
                  className="ctxMenuItem"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    setCtxMenu(null);
                    if (entry?.isDir) downloadFsFolderAsZip(entry);
                    else downloadFsEntry(entry);
                  }}
                >
                  {t.tr("Download", "下载")}
                </button>
                <button
                  type="button"
                  className="ctxMenuItem danger"
                  onClick={() => {
                    const entry = ctxMenu.entry;
                    setCtxMenu(null);
                    deleteFsEntry(entry);
                  }}
                >
                  {t.tr("Delete", "删除")}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ minWidth: 0 }}>
          <h3>{t.tr("Editor", "编辑器")}</h3>
          <div className="editorToolbar">
            <div className="editorToolbarLeft">
              <div className="editorFileLine">
                <span className="muted">{t.tr("file", "文件")}:</span> <code>{fsSelectedFile || "-"}</code>
              </div>
              <div className="editorBadges">
                {fsDirty ? <span className="badge">{t.tr("unsaved", "未保存")}</span> : null}
                {fsSelectedFile && fsSelectedFileMode === "binary" ? <span className="badge">{t.tr("download-only", "仅下载")}</span> : null}
                {fsSelectedFile && fsSelectedFileMode === "image" ? <span className="badge">{t.tr("preview", "预览")}</span> : null}
              </div>
            </div>

            <div className="editorToolbarRight">
              <button type="button" className="iconBtn" onClick={saveFile} disabled={!textEditable}>
                {t.tr("Save", "保存")}
              </button>
              <CopyButton text={String(fsFileText || "<empty>")} disabled={!textEditable} />
              <button type="button" className="iconBtn" onClick={() => setFindOpen((v) => !v)} disabled={!textEditable}>
                <Icon name="search" />
                {t.tr("Find", "查找")}
              </button>
              <label className="checkRow" style={{ userSelect: "none" }}>
                <input type="checkbox" checked={editorWrap} onChange={(e) => setEditorWrap(e.target.checked)} disabled={!textEditable} />{" "}
                {t.tr("Wrap", "换行")}
              </label>
              <label className="checkRow" style={{ userSelect: "none" }}>
                <input type="checkbox" checked={showLineNumbers} onChange={(e) => setShowLineNumbers(e.target.checked)} disabled={!textEditable} />{" "}
                {t.tr("Line #", "行号")}
              </label>
              {highlightKind ? (
                <label className="checkRow" style={{ userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={showHighlight}
                    onChange={(e) => setShowHighlight(e.target.checked)}
                    disabled={!highlightEligible || !textEditable}
                  />{" "}
                  {t.tr("Highlight", "高亮")}
                </label>
              ) : null}
              <div style={{ width: 180 }}>
                <Select
                  value=""
                  onChange={(v) => {
                    if (v === "diff") openDiffModalNow();
                    else if (v === "format_json") formatJsonNow();
                    else if (v === "validate_json") validateJsonNow();
                    else if (v === "validate_yaml") validateYamlNow();
                    else if (v === "set_jar" && canSetJar) setServerJarFromFile(fsSelectedFile);
                  }}
                  placeholder={t.tr("Tools", "工具")}
                  options={[
                    { value: "diff", label: t.tr("Diff…", "对比…"), disabled: !textEditable },
                    ...(isJson
                      ? [
                          { value: "format_json", label: t.tr("Format JSON", "格式化 JSON"), disabled: !textEditable },
                          { value: "validate_json", label: t.tr("Validate JSON", "校验 JSON"), disabled: !textEditable },
                        ]
                      : []),
                    ...(isYaml ? [{ value: "validate_yaml", label: t.tr("Validate YAML", "校验 YAML"), disabled: !textEditable }] : []),
                    ...(canSetJar ? [{ value: "set_jar", label: t.tr("Set as server jar", "设为 server jar") }] : []),
                  ]}
                  disabled={!fsSelectedFile}
                />
              </div>
            </div>
          </div>

          {findOpen && textEditable ? (
            <div className="editorFindBar">
              <input
                ref={findInputRef}
                value={findQuery}
                onChange={(e: any) => setFindQuery(String(e.target.value || ""))}
                placeholder={t.tr("Find…", "查找…")}
                style={{ width: 200 }}
                onKeyDown={(e: any) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    findNext(!!e.shiftKey);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setFindOpen(false);
                  }
                }}
              />
              <button type="button" onClick={() => findNext(true)} disabled={!findQuery.trim()}>
                {t.tr("Prev", "上一个")}
              </button>
              <button type="button" onClick={() => findNext(false)} disabled={!findQuery.trim()}>
                {t.tr("Next", "下一个")}
              </button>
              <input
                value={replaceText}
                onChange={(e: any) => setReplaceText(String(e.target.value || ""))}
                placeholder={t.tr("Replace…", "替换…")}
                style={{ width: 200 }}
              />
              <button type="button" onClick={replaceSelection} disabled={!replaceText}>
                {t.tr("Replace", "替换")}
              </button>
              <button type="button" onClick={replaceAllNow} disabled={!findQuery.trim()}>
                {t.tr("All", "全部")}
              </button>
              <button type="button" className="iconBtn iconOnly" onClick={() => setFindOpen(false)} aria-label={t.tr("Close", "关闭")}>
                ×
              </button>
            </div>
          ) : null}
          {fsSelectedFileMode === "image" && fsPreviewUrl ? (
            <div style={{ marginTop: 8 }}>
              <img
                src={fsPreviewUrl}
                alt={fsSelectedFile.split("/").pop() || "image"}
                style={{ maxWidth: "100%", maxHeight: 520, borderRadius: 12, border: "1px solid var(--border)", cursor: "zoom-in" }}
                onClick={() => setLightboxOpen(true)}
              />
            </div>
          ) : (
            <div className={`editorFrame ${showLineNumbers && textEditable ? "withGutter" : ""}`} style={{ marginTop: 8 }}>
              {showLineNumbers && textEditable ? (
                <div ref={gutterRef} className="editorGutter" aria-hidden="true">
                  <pre>{lineNumbers || "1"}</pre>
                </div>
              ) : null}
              <textarea
                ref={editorRef}
                className="editorTextarea"
                value={fsFileText}
                onChange={(e) => {
                  setFsFileText(e.target.value);
                  if (jsonCheck && !jsonCheck.ok) setJsonCheck(null);
                }}
                onScroll={(e) => {
                  const g = gutterRef.current;
                  if (g) g.scrollTop = e.currentTarget.scrollTop;
                }}
                onKeyDown={(e: any) => {
                  const k = String(e.key || "");
                  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "f") {
                    e.preventDefault();
                    setFindOpen(true);
                  }
                  if (k === "Escape" && findOpen) {
                    e.preventDefault();
                    setFindOpen(false);
                  }
                }}
                rows={16}
                wrap={editorWrap ? "soft" : "off"}
                spellCheck={false}
                placeholder={
                  fsSelectedFile && fsSelectedFileMode !== "text"
                    ? t.tr("Binary file (editing disabled). Use Download.", "二进制文件（禁止编辑）。请使用 Download 下载。")
                    : t.tr("Select a text file to edit (e.g. server.properties)", "选择一个文本文件进行编辑（例如 server.properties）")
                }
                style={{ whiteSpace: editorWrap ? "pre-wrap" : "pre" }}
                disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}
              />
            </div>
          )}

          {lightboxOpen && fsSelectedFileMode === "image" && fsPreviewUrl ? (
            <div className="lightboxOverlay" onClick={() => setLightboxOpen(false)}>
              <div className="lightbox" onClick={(e) => e.stopPropagation()}>
                <div className="lightboxToolbar">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800 }}>{t.tr("Preview", "预览")}</div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      <code>{fsSelectedFile || "-"}</code>
                    </div>
                  </div>
                  <div className="btnGroup">
                    <button
                      type="button"
                      className="iconBtn iconOnly"
                      title={t.tr("Prev", "上一个")}
                      aria-label={t.tr("Prev", "上一个")}
                      onClick={() => currentImageIdx > 0 && openEntry(imageEntries[currentImageIdx - 1])}
                      disabled={currentImageIdx <= 0}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="iconBtn iconOnly"
                      title={t.tr("Next", "下一个")}
                      aria-label={t.tr("Next", "下一个")}
                      onClick={() => currentImageIdx >= 0 && currentImageIdx < imageEntries.length - 1 && openEntry(imageEntries[currentImageIdx + 1])}
                      disabled={currentImageIdx < 0 || currentImageIdx >= imageEntries.length - 1}
                    >
                      →
                    </button>
                    <span className="badge">{Math.round(lightboxZoom * 100)}%</span>
                    <button
                      type="button"
                      className="iconBtn iconOnly"
                      title={t.tr("Zoom out", "缩小")}
                      aria-label={t.tr("Zoom out", "缩小")}
                      onClick={() => setLightboxZoom((z) => Math.min(6, Math.max(0.2, Number((z / 1.2).toFixed(3)))))}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="iconBtn iconOnly"
                      title={t.tr("Zoom in", "放大")}
                      aria-label={t.tr("Zoom in", "放大")}
                      onClick={() => setLightboxZoom((z) => Math.min(6, Math.max(0.2, Number((z * 1.2).toFixed(3)))))}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLightboxZoom(1);
                        setLightboxPan({ x: 0, y: 0 });
                      }}
                    >
                      {t.tr("Reset", "重置")}
                    </button>
                    <button type="button" onClick={() => setLightboxOpen(false)}>
                      {t.tr("Close", "关闭")}
                    </button>
                  </div>
                </div>
                <div
                  className={`lightboxViewport ${lightboxDragging ? "dragging" : ""}`}
                  onPointerDown={(e: any) => {
                    if (e.button != null && e.button !== 0) return;
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // ignore
                    }
                    lightboxDragRef.current = {
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      panX: lightboxPan.x,
                      panY: lightboxPan.y,
                    };
                    setLightboxDragging(true);
                  }}
                  onPointerMove={(e: any) => {
                    const st = lightboxDragRef.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    const dx = e.clientX - st.startX;
                    const dy = e.clientY - st.startY;
                    setLightboxPan({ x: st.panX + dx, y: st.panY + dy });
                  }}
                  onPointerUp={(e: any) => {
                    const st = lightboxDragRef.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    lightboxDragRef.current = null;
                    setLightboxDragging(false);
                  }}
                  onPointerCancel={(e: any) => {
                    const st = lightboxDragRef.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    lightboxDragRef.current = null;
                    setLightboxDragging(false);
                  }}
                  onWheel={(e: any) => {
                    if (!(e.ctrlKey || e.metaKey)) return;
                    e.preventDefault();
                    const dir = Math.sign(Number(e.deltaY || 0));
                    if (!dir) return;
                    setLightboxZoom((z) => {
                      const next = dir > 0 ? z / 1.12 : z * 1.12;
                      return Math.min(6, Math.max(0.2, Number(next.toFixed(3))));
                    });
                  }}
                >
                  <img
                    src={fsPreviewUrl}
                    alt={fsSelectedFile.split("/").pop() || "image"}
                    className="lightboxImg"
                    draggable={false}
                    style={{
                      transform: `translate(${Math.round(lightboxPan.x)}px, ${Math.round(lightboxPan.y)}px) scale(${lightboxZoom})`,
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}

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
