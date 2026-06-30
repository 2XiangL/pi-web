# Explorer: Navigate Up & Quick Set-Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workspace root be changed from inside the Explorer tree — a `..` row at the top of the list goes up one level, and a hover button on every directory row sets it as the workspace.

**Architecture:** `FileExplorer` gains an optional `onChangeCwd(path)` callback. It renders a `..` pseudo-row (hidden at filesystem root) and a "Set as workspace" hover button on directory rows; both call `onChangeCwd`. `SessionSidebar` refactors the validate core of `commitCustomPath` into a reusable `changeCwd(path)` (validate → `allowFileRoot` → `setSelectedCwd`), and passes it as `onChangeCwd`. The existing `AppShell.handleCwdChange` then closes any session whose cwd no longer matches and the explorer re-roots — no new top-level wiring.

**Tech Stack:** Next 16, React 19, TypeScript 5, Tailwind v4. Path alias `@/*` → repo root.

## Global Constraints

- **No test suite** exists in this repo (`AGENTS.md`). Verification is `tsc --noEmit`, `npm run lint`, and manual exercise. Do NOT invent test files.
- **Never run `next build` / `npm run build` during dev** — it corrupts the dev server (`AGENTS.md`).
- Typecheck: `node_modules/.bin/tsc --noEmit`. Lint: `npm run lint`.
- **File-access scoping**: every cwd change must go through `POST /api/cwd/validate` (which calls `allowFileRoot`), or `/api/files` reads for the new root 403 until a 5s cache expires. Both affordances reuse that endpoint.
- `lib/file-paths.ts` is the single home for Windows-aware path helpers (`normalizeFilePathSlashes`, `joinFilePath`, …). Reuse it; do not hand-roll posix-only path math.
- Follow existing inline-style conventions in `components/FileExplorer.tsx` (no Tailwind classes inside components; raw CSS vars like `var(--bg-panel)`).

---

### Task 1: `getParentDirPath` helper

**Files:**
- Modify: `lib/file-paths.ts` (append new export after `joinFilePath`, line 34)

**Interfaces:**
- Produces: `getParentDirPath(filePath: string): string | null` — returns the absolute parent directory, or `null` when already at a filesystem root (posix `/`, or a Windows drive root `C:/`). Windows-aware via `normalizeFilePathSlashes` (backslashes → forward slashes). Later tasks consume this to decide whether to render the `..` row.

- [ ] **Step 1: Add the helper to `lib/file-paths.ts`**

Append after the existing `joinFilePath` function (end of file):

```ts
export function getParentDirPath(filePath: string): string | null {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  if (normalized === "") return null;
  // Already at posix root.
  if (normalized === "/") return null;
  // Windows drive root after trailing-slash strip (e.g. "C:").
  if (/^[a-zA-Z]:$/.test(normalized)) return null;

  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    // lastSlash === 0 → "/foo", whose parent is "/".
    // lastSlash === -1 → no separator at all (not absolute); nothing above.
    return lastSlash === 0 ? "/" : null;
  }
  const parent = normalized.slice(0, lastSlash);
  // Windows: a bare "C:" parent is drive-relative and ambiguous; normalize to "C:/".
  if (/^[a-zA-Z]:$/.test(parent)) return parent + "/";
  return parent;
}
```

- [ ] **Step 2: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors (exit 0).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/file-paths.ts
git commit -m "feat: add getParentDirPath path helper"
```

---

### Task 2: `onChangeCwd` + `..` row + workspace hover button in `FileExplorer`

**Files:**
- Modify: `components/FileExplorer.tsx`
  - line 5: extend import from `@/lib/file-paths`
  - lines 23-28 (`Props`): add `onChangeCwd`
  - lines 121-145 (`TreeNode` signature + props type): add `onChangeCwd` + `cwdBusy`
  - lines 244-305 (`TreeNode` hover-button block): rewrite with computed offsets + new workspace button
  - lines 309-323 (`TreeNode` recursive `<TreeNode>` call): pass new props
  - `FileExplorer` body (after line 345 `busy` state): add `handleChangeCwd`
  - add `UpDirRow` component (above the `FileExplorer` export)
  - lines 553-568 (`roots.map` area): render `..` row; pass new props to `TreeNode`

**Interfaces:**
- Consumes: `getParentDirPath` from Task 1.
- Produces: `FileExplorer` now accepts `onChangeCwd?: (path: string) => void`. When provided, it renders a `..` row at the top of the list (clicking calls `onChangeCwd(parent)`) and a "Set as workspace" hover button on directory rows (clicking calls `onChangeCwd(node.fullPath)`). When `onChangeCwd` is absent, both affordances are hidden (graceful degradation). Task 3 wires the real handler.

- [ ] **Step 1: Extend the path import**

In `components/FileExplorer.tsx` line 5, change:

```ts
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
```

to:

```ts
import { encodeFilePathForApi, getRelativeFilePath, getParentDirPath, joinFilePath } from "@/lib/file-paths";
```

- [ ] **Step 2: Add `onChangeCwd` to `Props`**

Replace the `Props` interface (lines 23-28):

```ts
interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onChangeCwd?: (path: string) => void;
}
```

- [ ] **Step 3: Add props to `TreeNode`**

Replace the `TreeNode` destructuring + type (lines 121-145):

```tsx
function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  onChangeCwd,
  cwdBusy,
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
  onChangeCwd?: (path: string) => void;
  cwdBusy: boolean;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  selectedPaths: Set<string>;
  onToggleSelected: (fullPath: string) => void;
  onDownloadNode: (node: FileNode) => void;
}) {
```

- [ ] **Step 4: Rewrite the `TreeNode` hover-button block with computed offsets + workspace button**

In the `TreeNode` return, replace the entire block that renders the download button and the mention button (the `{hovered && ( ... download ... )}` and `{onAtMention && hovered && ( ... mention ... )}` JSX — currently lines 244-305) with:

```tsx
        {(() => {
          // Hover-action cluster, stacked leftward from the right edge.
          // mention (~76px, widest) → download (20px) → workspace (20px).
          const canSetWorkspace = node.isDir && !!onChangeCwd;
          const MENTION_W = 76;
          const SQUARE_W = 20;
          const GAP = 4;
          let rightEdge = 4;
          const mentionRight = rightEdge;
          if (onAtMention) rightEdge += MENTION_W + GAP;
          const downloadRight = rightEdge;
          if (canSetWorkspace) rightEdge += SQUARE_W + GAP;
          const workspaceRight = rightEdge;
          const squareBtn: React.CSSProperties = {
            position: "absolute",
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: SQUARE_W,
            height: SQUARE_W,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
          };
          return (
            <>
              {canSetWorkspace && hovered && (
                <button
                  onClick={(e) => { e.stopPropagation(); onChangeCwd!(node.fullPath); }}
                  disabled={cwdBusy}
                  title="Set as workspace"
                  style={{ ...squareBtn, right: workspaceRight, opacity: cwdBusy ? 0.5 : 1, cursor: cwdBusy ? "default" : "pointer" }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </button>
              )}
              {hovered && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDownloadNode(node); }}
                  disabled={cwdBusy}
                  title={node.isDir ? "Download as ZIP" : "Download"}
                  style={{ ...squareBtn, right: downloadRight, opacity: cwdBusy ? 0.5 : 1, cursor: cwdBusy ? "default" : "pointer" }}
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
                    right: mentionRight,
                    top: "50%",
                    transform: "translateY(-50%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    padding: "0 8px",
                    height: SQUARE_W,
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
            </>
          );
        })()}
```

- [ ] **Step 5: Pass new props in the recursive `<TreeNode>` call inside `TreeNode`**

In the recursive render (the `{children.map((child) => (<TreeNode ... />))}` block, currently lines 309-323), add `onChangeCwd={onChangeCwd}` and `cwdBusy={cwdBusy}` to the props. Replace:

```tsx
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
```

with:

```tsx
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              onChangeCwd={onChangeCwd}
              cwdBusy={cwdBusy}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
              selectedPaths={selectedPaths}
              onToggleSelected={onToggleSelected}
              onDownloadNode={onDownloadNode}
            />
```

- [ ] **Step 6: Add `handleChangeCwd` to the `FileExplorer` component body**

Inside `export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention }: Props) {`, first update the destructure to include the new prop:

```tsx
export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, onChangeCwd }: Props) {
```

Then, immediately after the `const [busy, setBusy] = useState(false);` line (currently line 345), add:

```ts
  const handleChangeCwd = useCallback(async (path: string) => {
    if (!onChangeCwd || busy) return;
    setBusy(true);
    try {
      await onChangeCwd(path);
    } catch (e) {
      flashStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [onChangeCwd, busy, flashStatus]);
```

- [ ] **Step 7: Add the `UpDirRow` component**

Add this component just above `export function FileExplorer(...)`:

```tsx
function UpDirRow({ parentDir, busy, onNavigate }: {
  parentDir: string;
  busy: boolean;
  onNavigate: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={() => { if (!busy) onNavigate(parentDir); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`Go up to ${parentDir}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8,
        paddingRight: 8,
        height: 24,
        cursor: busy ? "default" : "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span style={{ width: 10, flexShrink: 0, display: "flex", justifyContent: "center" }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2 6 5 3 8 6" />
        </svg>
      </span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        <FolderIcon size={14} open={false} />
      </span>
      <span
        style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
        title={parentDir}
      >
        ..
      </span>
    </div>
  );
}
```

- [ ] **Step 8: Render the `..` row and pass new props to `TreeNode` in the main list**

In the `FileExplorer` return, the list currently renders `{roots.map((node) => (<TreeNode ... />))}` inside the drag/drop `<div>` (currently lines 553-568). Replace that whole `{roots.map(...)}` + empty-state block:

```tsx
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
```

with:

```tsx
        {parentDir !== null && (
          <UpDirRow parentDir={parentDir} busy={busy} onNavigate={handleChangeCwd} />
        )}
        {roots.map((node) => (
          <TreeNode
            key={node.fullPath}
            node={node}
            depth={0}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            onChangeCwd={handleChangeCwd}
            cwdBusy={busy}
            expandedPaths={expandedPaths}
            onToggleExpanded={handleToggleExpanded}
            refreshKey={effectiveRefresh}
            selectedPaths={selectedPaths}
            onToggleSelected={handleToggleSelected}
            onDownloadNode={downloadNode}
          />
        ))}
        {roots.length === 0 && parentDir === null && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {dragOver ? "Drop files to upload" : "No files found"}
          </div>
        )}
```

Then add the `parentDir` computation. In the `FileExplorer` body, immediately after the `handleChangeCwd` block from Step 6, add:

```ts
  const parentDir = onChangeCwd ? getParentDirPath(cwd) : null;
```

- [ ] **Step 9: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors. (`onChangeCwd` is optional and no caller passes it yet, so the build is clean and both affordances stay hidden until Task 3.)

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add components/FileExplorer.tsx
git commit -m "feat: add go-up row and set-as-workspace hover button to FileExplorer"
```

---

### Task 3: `changeCwd` refactor + wire `SessionSidebar` → `FileExplorer`

**Files:**
- Modify: `components/SessionSidebar.tsx`
  - lines 284-310: replace `commitCustomPath` with a `changeCwd` helper + a thin `commitCustomPath` that calls it
  - lines 795-800 (`<FileExplorer>` render): pass `onChangeCwd={changeCwd}`

**Interfaces:**
- Consumes: `FileExplorer.onChangeCwd` prop from Task 2.
- Produces: end-to-end behavior. `changeCwd(path)` does `POST /api/cwd/validate` → on success `setSelectedCwd(normalized)` and returns; on failure it throws an `Error` (whose `.message` is the server error or `HTTP <status>`). `commitCustomPath` wraps it to preserve the existing custom-path dropdown error UI. The `FileExplorer` receives `onChangeCwd={changeCwd}`, enabling both affordances. `AppShell.handleCwdChange` (unchanged) then closes any session whose cwd no longer matches.

- [ ] **Step 1: Refactor `commitCustomPath` into a reusable `changeCwd`**

Replace the entire `commitCustomPath` block (lines 284-310):

```ts
  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSelectedCwd(data.cwd ?? path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);
```

with:

```ts
  // Shared cwd-switch core: validates the path (server calls allowFileRoot),
  // then setSelectedCwd. Throws Error(message) on failure so callers surface
  // errors in their own UI. Reuses customPathValidating as the in-flight guard.
  const changeCwd = useCallback(async (path: string): Promise<void> => {
    if (customPathValidating) return;
    setCustomPathValidating(true);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSelectedCwd(data.cwd ?? path);
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValidating]);

  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;
    setCustomPathError(null);
    try {
      await changeCwd(path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [customPathValue, customPathValidating, changeCwd]);
```

- [ ] **Step 2: Pass `onChangeCwd` to `FileExplorer`**

Replace the `<FileExplorer>` render (lines 795-800):

```tsx
              <FileExplorer
                cwd={selectedCwdProp ?? selectedCwd!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
              />
```

with:

```tsx
              <FileExplorer
                cwd={selectedCwdProp ?? selectedCwd!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onChangeCwd={changeCwd}
              />
```

- [ ] **Step 3: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual end-to-end verification**

Start the dev server (only if not already running): `npm run dev` → open http://localhost:30141. Pick a workspace that has a parent with files (e.g. a project under your home dir). Verify each item; fix and re-typecheck if anything fails:

1. **`..` row appears** at the very top of the file list, showing a `..` label with a folder icon and an up-chevron. Tooltip reads `Go up to <parent absolute path>`.
2. **Click `..`** → explorer re-roots at the parent; the parent's file list loads (confirms `allowFileRoot` ran — no 403). The previously open session, if its cwd no longer matches, closes.
3. **`..` absent at root** → set the workspace to `/` (use the custom-path input, type `/`). The `..` row must NOT render.
4. **Set-as-workspace hover button** → expand a subdirectory in the tree, hover a directory row: a home-icon button appears (left of Download, right of the row text) with tooltip `Set as workspace`. Download and mention buttons still render without overlapping it.
5. **Click the workspace button** on a directory → explorer re-roots at that directory; its contents load; a new session created afterward (New Session) uses that cwd.
6. **Workspace button hidden on files** → hover a plain file row: no home-icon button (only Download / mention).
7. **Validate failure surface** → open the project-cwd dropdown, type a nonexistent path (e.g. `/nope/does-not-exist`) and submit: the dropdown shows an error and the cwd does not change. (This exercises the same `changeCwd` throw path that the explorer's `flashStatus` catches in `handleChangeCwd`; no cwd change occurs on failure.)
8. **In-flight guard** → double-click `..` rapidly: only one validate request fires (the `..` row and hover buttons go dim/disabled while busy).
9. **Custom path input still works** → open the project-cwd dropdown, type a path, submit: it switches cwd and shows the dropdown's own error on a bad path (confirms the refactor didn't regress `commitCustomPath`).

- [ ] **Step 6: Commit**

```bash
git add components/SessionSidebar.tsx
git commit -m "feat: wire explorer go-up and set-as-workspace to changeCwd"
```

---

## Notes for the implementer

- **Icon for set-as-workspace** is a Lucide-style "home" (`<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>` + inner door polyline). It means "make this the working root"; the tooltip disambiguates from "home directory".
- **Hover-button offsets** are computed (`mentionRight` / `downloadRight` / `workspaceRight`) rather than hardcoded, so the three buttons stack leftward without overlap regardless of which are present. If visual verification in Step 5.4 shows overlap, bump `MENTION_W` (currently 76) — it tracks the rendered width of the "mention" button (icon + `mention` text + `padding 0 8px`).
- **No new dependencies, no API route changes, no new files** beyond what's listed.
- After all tasks: the branch `feat/explorer-cwd-navigate` holds three commits, one per task. Do not merge or open a PR unless asked.
