"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
}

interface Status {
  kind: "info" | "success" | "error";
  message: string;
}

interface DroppedItem {
  file: File;
  relativePath: string;
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

function parseFilenameFromContentDisposition(cd: string): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try { return decodeURIComponent(star[1]); } catch { return star[1]; }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ?? null;
}

function triggerBrowserDownload(href: string, fallbackName: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<DroppedItem[]> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    );
    if (!file) return [];
    return [{ file, relativePath: prefix + file.name }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const items: DroppedItem[] = [];
    const readBatch = (): Promise<FileSystemEntry[]> =>
      new Promise((resolve) =>
        reader.readEntries((entries) => resolve(entries), () => resolve([]))
      );
    let batch = await readBatch();
    while (batch.length > 0) {
      for (const child of batch) {
        items.push(...await walkEntry(child, prefix + entry.name + "/"));
      }
      batch = await readBatch();
    }
    return items;
  }
  return [];
}

async function collectDroppedFiles(dt: DataTransfer): Promise<DroppedItem[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length > 0) {
    const all = await Promise.all(entries.map((e) => walkEntry(e, "")));
    return all.flat();
  }
  return Array.from(dt.files).map((f) => ({ file: f, relativePath: f.name }));
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
  selectedPaths,
  onToggleSelected,
  onDownloadNode,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  selectedPaths: Set<string>;
  onToggleSelected: (fullPath: string) => void;
  onDownloadNode: (node: FileNode) => void;
}) {
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const selected = selectedPaths.has(node.fullPath);
  const showCheckbox = hovered || selected || selectedPaths.size > 0;

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  const prevLoadedRef = useRef(loaded);
  useEffect(() => { prevLoadedRef.current = loaded; });

  useEffect(() => {
    if (open && loaded) loadChildren(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {showCheckbox && (
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelected(node.fullPath)}
            style={{ flexShrink: 0, margin: 0, width: 12, height: 12 }}
          />
        )}
        {!showCheckbox && (node.isDir ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
        ) : <span style={{ width: 10, flexShrink: 0 }} />)}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)"
            strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onDownloadNode(node); }}
            title={node.isDir ? "Download as ZIP" : "Download"}
            style={{
              position: "absolute",
              right: onAtMention ? 64 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onAtMention(getRelativeFilePath(node.fullPath, cwd)); }}
            title="Insert path into chat"
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            mention
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
              selectedPaths={selectedPaths}
              onToggleSelected={onToggleSelected}
              onDownloadNode={onDownloadNode}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [lastExpandedDir, setLastExpandedDir] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [localTick, setLocalTick] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCwdRef = useRef<string | null>(null);

  const effectiveRefresh = (refreshKey ?? 0) + localTick;

  const flashStatus = useCallback((s: Status) => {
    setStatus(s);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 4000);
  }, []);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) { next.add(fullPath); setLastExpandedDir(fullPath); } else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleToggleSelected = useCallback((fullPath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath);
      return next;
    });
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    if (cwdChanged) { setExpandedPaths(new Set()); setSelectedPaths(new Set()); setLastExpandedDir(null); }
    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [cwd, effectiveRefresh]);

  const uploadTargetDir = lastExpandedDir ?? cwd;

  const doUpload = useCallback(async (items: DroppedItem[]) => {
    if (items.length === 0) return;
    const targetDir = lastExpandedDir ?? cwd;
    setBusy(true);
    flashStatus({ kind: "info", message: `Uploading ${items.length} file(s)…` });
    try {
      const buildForm = () => {
        const fd = new FormData();
        for (const it of items) fd.append("files", it.file, it.relativePath || it.file.name);
        return fd;
      };
      const enc = encodeFilePathForApi(targetDir);
      const r1 = await fetch(`/api/files/${enc}?type=upload`, { method: "POST", body: buildForm() });
      const j1 = await r1.json().catch(() => ({})) as {
        uploaded?: { path: string }[]; conflicts?: { path: string }[]; errors?: { path: string; error: string }[]; error?: string;
      };
      if (!r1.ok) throw new Error(j1.error ?? `HTTP ${r1.status}`);

      let uploadedCount = j1.uploaded?.length ?? 0;
      let errors = j1.errors ?? [];

      if ((j1.conflicts?.length ?? 0) > 0) {
        const sample = j1.conflicts![0].path;
        const ok = window.confirm(`${j1.conflicts!.length} file(s) already exist (e.g. "${sample}"). Overwrite them?`);
        if (ok) {
          const r2 = await fetch(`/api/files/${enc}?type=upload&overwrite=true`, { method: "POST", body: buildForm() });
          const j2 = await r2.json().catch(() => ({})) as {
            uploaded?: { path: string }[]; errors?: { path: string; error: string }[]; error?: string;
          };
          if (!r2.ok) throw new Error(j2.error ?? `HTTP ${r2.status}`);
          uploadedCount = j2.uploaded?.length ?? uploadedCount;
          errors = [...errors, ...(j2.errors ?? [])];
        }
      }

      if (errors.length > 0) {
        flashStatus({ kind: "error", message: `Uploaded ${uploadedCount}, ${errors.length} error(s)` });
      } else {
        flashStatus({ kind: "success", message: `Uploaded ${uploadedCount} file(s)` });
      }
      setLocalTick((t) => t + 1);
    } catch (e) {
      flashStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [lastExpandedDir, cwd, flashStatus]);

  const downloadArchive = useCallback(async (paths: string[], suggestedName?: string) => {
    if (paths.length === 0) return;
    setBusy(true);
    flashStatus({ kind: "info", message: paths.length > 1 ? `Zipping ${paths.length} items…` : "Zipping…" });
    try {
      const res = await fetch("/api/files/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = parseFilenameFromContentDisposition(res.headers.get("content-disposition") ?? "") ?? suggestedName ?? "archive.zip";
      const url = URL.createObjectURL(blob);
      triggerBrowserDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      flashStatus({ kind: "success", message: "Download started" });
    } catch (e) {
      flashStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [flashStatus]);

  const downloadNode = useCallback((node: FileNode) => {
    if (node.isDir) {
      void downloadArchive([node.fullPath], `${node.name}.zip`);
    } else {
      triggerBrowserDownload(`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`, node.name);
    }
  }, [downloadArchive]);

  const downloadSelected = useCallback(() => {
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) return;
    void downloadArchive(paths);
  }, [selectedPaths, downloadArchive]);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length === 0) return;
    void doUpload(files.map((f) => ({ file: f, relativePath: f.name })));
  }, [doUpload]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const items = await collectDroppedFiles(e.dataTransfer);
    if (items.length === 0) return;
    void doUpload(items);
  }, [doUpload]);

  const selectedCount = selectedPaths.size;

  if (loading) {
    return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>;
  }
  if (error) {
    return <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>;
  }

  return (
    <div style={{ padding: "2px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px 6px" }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          style={toolbarBtnStyle(busy)}
          title={`Upload into ${uploadTargetDir}`}
        >
          Upload
        </button>
        <button
          onClick={downloadSelected}
          disabled={busy || selectedCount === 0}
          style={toolbarBtnStyle(busy || selectedCount === 0)}
          title={selectedCount === 0 ? "Select files to download" : "Download selected as ZIP"}
        >
          {selectedCount > 0 ? `Download ${selectedCount}` : "Download"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={onFileInputChange}
        />
        {status && (
          <span style={{
            marginLeft: "auto",
            fontSize: 11,
            color: status.kind === "error" ? "#f87171" : status.kind === "success" ? "var(--accent)" : "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {status.message}
          </span>
        )}
      </div>

      <div
        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={handleDrop}
        style={{
          border: dragOver ? "1px dashed var(--accent)" : "1px solid transparent",
          borderRadius: 4,
          minHeight: 40,
        }}
      >
        {roots.map((node) => (
          <TreeNode
            key={node.fullPath}
            node={node}
            depth={0}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            expandedPaths={expandedPaths}
            onToggleExpanded={handleToggleExpanded}
            refreshKey={effectiveRefresh}
            selectedPaths={selectedPaths}
            onToggleSelected={handleToggleSelected}
            onDownloadNode={downloadNode}
          />
        ))}
        {roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {dragOver ? "Drop files to upload" : "No files found"}
          </div>
        )}
      </div>
    </div>
  );
}

function toolbarBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 22,
    padding: "0 10px",
    fontSize: 11,
    fontWeight: 600,
    color: disabled ? "var(--text-dim)" : "var(--text)",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
