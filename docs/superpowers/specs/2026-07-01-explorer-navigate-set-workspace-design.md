# Explorer: Navigate Up & Quick Set-Workspace — Design Spec

- **Date:** 2026-07-01
- **Branch:** `feat/explorer-cwd-navigate`
- **Status:** Approved (brainstorming)

## Goal

Add two capabilities to the Explorer panel so the workspace root can be changed from within the file tree itself (today it can only be changed via the project-cwd dropdown / custom-path input):

1. **Go up one level** — a `..` pseudo-row rendered as the **first item** in the file list. Clicking it re-roots the explorer at the parent directory.
2. **Quick set-as-workspace** — a hover button on every directory row that immediately re-roots the explorer at that directory (making it the active workspace for browsing and new sessions).

## Non-goals

- A navigation **history** (back/forward, breadcrumbs). Only "go up one level" was requested.
- Right-click context menus. Interaction is a hover button, consistent with the existing Download / mention buttons.
- Free-text path entry inside the tree (the existing custom-path input already covers that).
- Renaming / editing cwd from the explorer.

## Constraints & invariants

- No test suite exists in this repo; verification is via `tsc --noEmit`, `npm run lint`, and manual exercise.
- Tailwind v4 / Next 16 / React 19 conventions. Path alias `@/*` → repo root.
- **File-access scoping trap** (`AGENTS.md`): `/api/files` reads are scoped to an allowlist of roots (`lib/file-access.ts`), cached for 5 s. A brand-new cwd is **not** in that set, so any cwd change must route through `POST /api/cwd/validate`, which calls `allowFileRoot()` — otherwise file reads for the new root 403 until the cache TTL expires. The parent of the current cwd may or may not already be allowed; validating unconditionally is the safe path the existing custom-path input already takes.
- **`selectedCwd` is the single source of truth** for both the explorer root and the new-session cwd. `FileExplorer` receives `cwd` as a prop and must remain a controlled/presentational component.

## Confirmed decisions (from brainstorming)

1. **Set-as-workspace interaction = hover button.** Chosen over a right-click context menu to stay consistent with the existing per-row Download / mention hover actions and to avoid introducing a menu-positioning / outside-click subsystem.
2. **Re-root semantics.** "Set as workspace" on a directory makes that directory the new `selectedCwd` (explorer re-roots there and it becomes the default cwd for new sessions). This matches what the custom-path input already does — no new "browse-only" mode is introduced.

## Architecture

```
..  row (depth 0)  ──┐
dir row (hover btn) ─┤──► onChangeCwd(absolutePath)
file row            │
                    │
FileExplorer.onChangeCwd  ─►  SessionSidebar.changeCwd(path)
                            1. POST /api/cwd/validate {cwd: path}   → allowFileRoot(path), returns {cwd: normalized}
                            2. setSelectedCwd(normalized)
                            3. onCwdChange(normalized) ─► AppShell.handleCwdChange
                                  • setActiveCwd(cwd)
                                  • closes any open session whose cwd ≠ new cwd (existing behavior)
                                  • selectedCwdProp becomes null → explorer reads local selectedCwd
```

The existing `AppShell.handleCwdChange` (AppShell.tsx:144) already implements the full switch contract — it closes mismatched sessions, clears branch state, and resets the route to `/`. The explorer-initiated change reuses it verbatim; **no new top-level wiring is added.**

The validate core of `SessionSidebar.commitCustomPath` (SessionSidebar.tsx:284) is refactored into a reusable `changeCwd(path)` so the custom-path input, the `..` row, and the hover button share one code path.

### Parent-directory computation

A new helper `getParentDirPath(cwd): string | null` in `lib/file-paths.ts`, Windows-aware via the existing `normalizeFilePathSlashes`:

- Normalize to forward slashes, strip trailing separators.
- `"/"` and Windows drive roots (`C:/`, `C:\`) → return `null` (no parent → `..` row hidden).
- Otherwise return everything up to the last separator. For a single-segment relative-ish path, return the empty/root ancestor.

`lib/file-paths.ts` already centralizes Windows-vs-posix path handling (`normalizeFilePathSlashes`, `joinFilePath`), so this is the consistent home for it.

## API contracts

No new endpoints. Both actions call the existing endpoints:

- `POST /api/cwd/validate` — body `{ cwd: string }`; validates the directory exists, calls `allowFileRoot`, returns `{ success: true, cwd: "<normalized>" }` or `{ error }`.
- `POST /api/default-cwd` — unchanged, not used by this feature.

## FileExplorer UI changes

- **`..` row** — rendered above `roots.map(...)` as a standalone pseudo-entry (not a `FileNode`, so it never participates in selection/download/upload):
  - Layout identical to a depth-0 directory row (same height 24, padding, hover background).
  - Leading up-arrow icon (⬆ or a chevron-up SVG) + the label `..`.
  - `title="Go up to <parent>"`.
  - `onClick` → `onChangeCwd(parent)`.
  - **Hidden** when `getParentDirPath(cwd)` returns `null` (filesystem root) or when `onChangeCwd` is not provided.
- **Set-as-workspace hover button** — on `node.isDir` rows only, rendered in the same absolutely-positioned cluster as the existing Download / mention buttons:
  - Folder/target icon + `title="Set as workspace"`.
  - `onClick` → `onChangeCwd(node.fullPath)` (with `e.stopPropagation()` so the row does not also toggle-expand).
  - Positioning: the existing buttons are anchored `right`; to avoid overlap, the new button is placed immediately left of the Download button. The `right` offsets already used by the Download/mention buttons are recalculated so the three buttons (workspace · download · mention) sit in a consistent cluster when present. Placement mirrors the current hover-button styling (`--bg-panel` background, `1px solid --border`, 20×20, `translateY(-50%)`).

### Props change

```ts
interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onChangeCwd?: (path: string) => void;   // NEW
}
```

`onChangeCwd` is optional and threaded down to `TreeNode` (only directory rows use it). When absent (no caller passes it), both affordances degrade: `..` hidden, workspace button not rendered. The `..` row's parent is computed in `FileExplorer` (from `cwd`) and passed to the row render; `TreeNode` receives `onChangeCwd` and the current `cwd` it already has.

## State, errors & edge cases

- **Validate failure** (path vanished between list and click, permission) → `flashStatus({ kind: "error", message })` in the explorer header; cwd is **not** changed. Reuses the existing `flashStatus` machinery.
- **In-flight guard** — `changeCwd` reuses the existing `customPathValidating` state (the same flag `commitCustomPath` already toggles) as its guard, so rapid clicks on `..` / hover buttons don't fire overlapping validate requests. The `..` row and the workspace hover button are disabled while a change is pending. No second flag is introduced.
- **Root reached** — `..` row hidden at `/` and Windows drive roots; no infinite-up navigation.
- **Open session mismatch** — switching cwd away from an open session's cwd closes that session (existing `handleCwdChange` behavior). This is intentional and matches the custom-path input; no new confirmation dialog is added (the session file is untouched, only the UI selection changes).
- **`selectedCwdProp` override** — when a session is open, `FileExplorer.cwd` is `selectedCwdProp ?? selectedCwd!`. After a workspace switch, `handleCwdChange` nulls the mismatched session, so `selectedCwdProp` becomes `null` and the explorer reads the freshly-set local `selectedCwd`. Verified against the current code; no change needed to that precedence.

## File layout

| Path | Change |
| --- | --- |
| `lib/file-paths.ts` | add `getParentDirPath(cwd): string \| null` (Windows-aware) |
| `components/FileExplorer.tsx` | add `onChangeCwd` prop; render `..` row; add set-as-workspace hover button on dir rows; thread `onChangeCwd` into `TreeNode` |
| `components/SessionSidebar.tsx` | refactor `commitCustomPath`'s validate core into reusable `changeCwd(path)`; pass `onChangeCwd={changeCwd}` to `FileExplorer` |

No new files. No new dependencies. No API route changes.

## Verification plan

- `node_modules/.bin/tsc --noEmit`
- `npm run lint`
- Manual:
  - `..` row appears at top of a nested workspace; clicking it re-roots the explorer at the parent and the parent's file list loads (no 403 — confirms `allowFileRoot` ran).
  - `..` row is **absent** when the workspace is `/` (or a Windows drive root).
  - Hover a directory row → workspace button appears alongside Download/mention; clicking re-roots the explorer at that directory; new sessions created afterward use that cwd.
  - Switching cwd away from an open session closes the session pane (existing behavior preserved).
  - Validate failure path (e.g. point at a path then delete it) shows an inline error and leaves cwd unchanged.
  - Rapid double-click on `..` does not fire overlapping requests (in-flight guard).
