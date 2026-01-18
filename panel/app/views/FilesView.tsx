"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

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
    setFsSelectedFile,
    setFsPath,
    openEntry,
    openFileByPath,
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
    openTrashModal,
    copyText,
    confirmDialog,
  } = useAppCtx();

  const [queryRaw, setQueryRaw] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [dragOver, setDragOver] = useState<boolean>(false);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(queryRaw), 160);
    return () => window.clearTimeout(t);
  }, [queryRaw]);

  const viewEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(fsEntries) ? fsEntries : [];
    if (!q) return list;
    return list.filter((e: any) => String(e?.name || "").toLowerCase().includes(q));
  }, [fsEntries, query]);

  const inst = String(instanceId || "").trim();
  const entriesLoading = fsStatus === "Loading..." && !fsEntries.length;

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
          <table>
            <thead>
              <tr>
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
                      <td colSpan={5}>
                        <div className="skeleton" style={{ minHeight: 34, borderRadius: 12 }} />
                      </td>
                    </tr>
                  ))
                : viewEntries.map((e: any) => (
                    <tr key={`${e.name}-${e.isDir ? "d" : "f"}`}>
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
                  ))}
            </tbody>
          </table>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3>{t.tr("Editor", "编辑器")}</h3>
          <div className="row">
            <span className="muted">
              {t.tr("file", "文件")}: <code>{fsSelectedFile || "-"}</code>
            </span>
            {fsDirty ? <span className="badge">{t.tr("unsaved", "未保存")}</span> : null}
            {fsSelectedFile && fsSelectedFileMode !== "text" ? <span className="badge">{t.tr("download-only", "仅下载")}</span> : null}
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
          </div>
          <textarea
            value={fsFileText}
            onChange={(e) => setFsFileText(e.target.value)}
            rows={16}
            placeholder={
              fsSelectedFile && fsSelectedFileMode !== "text"
                ? t.tr("Binary file (editing disabled). Use Download.", "二进制文件（禁止编辑）。请使用 Download 下载。")
                : t.tr("Select a text file to edit (e.g. server.properties)", "选择一个文本文件进行编辑（例如 server.properties）")
            }
            style={{ width: "100%", marginTop: 8 }}
            disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}
          />
          <div className="hint">{t.tr("Tip: binary/large files are download-only.", "提示：二进制/大文件为 download-only（可用 Download 下载）。")}</div>
        </div>
      </div>
    </div>
  );
}
