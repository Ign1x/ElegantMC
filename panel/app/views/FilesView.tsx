"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppCtx } from "../appCtx";
import Icon from "../ui/Icon";
import Select from "../ui/Select";

export default function FilesView() {
  const {
    selected,
    instanceId,
    fsPath,
    fsBreadcrumbs,
    fsStatus,
    fsEntries,
    fsSelectedFile,
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

  return (
    <div className="card">
      <div className="toolbar">
        <div className="toolbarLeft" style={{ alignItems: "center" }}>
          <div>
            <h2>Files</h2>
            <div className="hint">
              sandbox: <code>servers/</code>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {fsBreadcrumbs.map((c: any, idx: number) => (
                <span key={`${c.path}-${idx}`}>
                  {idx ? <span className="muted"> / </span> : null}
                  <button
                    type="button"
                    className="linkBtn"
                    onClick={() => {
                      setFsSelectedFile("");
                      setFsFileText("");
                      setFsPath(c.path);
                    }}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
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
              placeholder={inst ? "Quick open…" : "Select a game first"}
              options={[
                { value: joinRelPath(inst, "server.properties"), label: "server.properties" },
                { value: joinRelPath(inst, "eula.txt"), label: "eula.txt" },
                { value: joinRelPath(inst, "logs/latest.log"), label: "logs/latest.log" },
                { value: joinRelPath(inst, ".elegantmc.json"), label: ".elegantmc.json" },
              ]}
            />
          </div>
	          <input value={queryRaw} onChange={(e: any) => setQueryRaw(e.target.value)} placeholder="Search entries…" style={{ width: 220 }} />
          <button type="button" onClick={() => refreshFsNow()} disabled={!selected}>
            Refresh
          </button>
          <button type="button" onClick={() => openTrashModal({ showAll: true })} disabled={!selected}>
            Trash
          </button>
          <button type="button" className="iconBtn" onClick={mkdirFsHere} disabled={!selected}>
            <Icon name="plus" />
            New folder
          </button>
          <button type="button" className="iconBtn" onClick={createFileHere} disabled={!selected}>
            <Icon name="plus" />
            New file
          </button>
          <button
            type="button"
            onClick={() => {
              setFsSelectedFile("");
              setFsFileText("");
              setFsPath(parentRelPath(fsPath));
            }}
            disabled={!fsPath}
          >
            Up
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
            Upload
          </button>
          <button
            type="button"
            onClick={uploadZipAndExtractHere}
            disabled={!uploadFile || !String(uploadFile?.name || "").toLowerCase().endsWith(".zip") || !fsPath}
            title={fsPath ? "" : "Cannot extract to servers/ root; select a folder first"}
          >
            Upload & Extract (.zip)
          </button>
          {uploadFile ? (
            <span className="muted">
              to: <code>{joinRelPath(fsPath, uploadFile.name)}</code>
            </span>
          ) : null}
          {uploadStatus ? <span className="muted">{uploadStatus}</span> : null}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Drag & drop files here to upload into <code>servers/{fsPath || ""}</code>.
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <h3>Entries</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {viewEntries.map((e: any) => (
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
                        Rename
                      </button>
                      <button type="button" onClick={() => moveFsEntry(e)}>
                        Move
                      </button>
                      {!e.isDir ? (
                        <button type="button" className="iconBtn" onClick={() => downloadFsEntry(e)}>
                          <Icon name="download" />
                          Download
                        </button>
                      ) : (
                        <button type="button" className="iconBtn" onClick={() => downloadFsFolderAsZip(e)}>
                          <Icon name="download" />
                          Zip
                        </button>
                      )}
                      <button type="button" className="dangerBtn" onClick={() => deleteFsEntry(e)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3>Editor</h3>
          <div className="row">
            <span className="muted">
              file: <code>{fsSelectedFile || "-"}</code>
            </span>
            {fsSelectedFile && fsSelectedFileMode !== "text" ? <span className="badge">download-only</span> : null}
            {fsSelectedFile &&
            fsSelectedFile.toLowerCase().endsWith(".jar") &&
            inst &&
            (fsSelectedFile === inst || fsSelectedFile.startsWith(`${inst}/`)) ? (
              <button type="button" onClick={() => setServerJarFromFile(fsSelectedFile)}>
                Set as server jar
              </button>
            ) : null}
            <button type="button" onClick={saveFile} disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}>
              Save
            </button>
          </div>
          <textarea
            value={fsFileText}
            onChange={(e) => setFsFileText(e.target.value)}
            rows={16}
            placeholder={
              fsSelectedFile && fsSelectedFileMode !== "text"
                ? "Binary file (editing disabled). Use Download."
                : "Select a text file to edit (e.g. server.properties)"
            }
            style={{ width: "100%", marginTop: 8 }}
            disabled={!fsSelectedFile || fsSelectedFileMode !== "text"}
          />
          <div className="hint">提示：二进制/大文件为 download-only（可用 Download 下载）。</div>
        </div>
      </div>
    </div>
  );
}
