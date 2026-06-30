# File Upload & Download — Design Spec

- **Date:** 2026-06-30
- **Branch:** `feat/file-upload-download`
- **Status:** Approved (brainstorming)

## Goal

Add two capabilities to the pi-web UI, scoped to the existing workspace file roots:

1. **Upload** files (and folders) into the current workspace directory.
2. **Download** a single file, or package multiple files / a directory into a ZIP and download it.

## Non-goals

- Resumable / chunked uploads, authenticated multi-user quotas, virus scanning.
- Editing or deleting files via the explorer (out of scope; download/upload only).
- Cloud-storage sync.

## Constraints & invariants

- **Security is the hard constraint.** Every read/write must pass through the existing allowlist in `lib/file-access.ts` (`getAllowedFileRoots` + `isFilePathAllowed`). No new endpoint may create a bypass. This applies per-path, including every entry packed into a ZIP and every segment of an uploaded relative path.
- No test suite exists in this repo; verification is via `tsc --noEmit`, `npm run lint`, and manual exercise.
- Tailwind v4 / Next 16 / React 19 conventions. Path alias `@/*` → repo root.
- `app/api/files/[...path]` is a catch-all route; a static sibling segment (`archive`) takes precedence over it, so `app/api/files/archive/route.ts` is safe from catch-all collision.

## Confirmed decisions (from brainstorming)

1. **Upload trigger:** Upload button in the FileExplorer header (multi-file picker) **plus** drag-and-drop onto the explorer area. Drag-drop supports both loose files and entire folders (via `DataTransferItem.webkitGetAsEntry`).
2. **Download selection:** Checkboxes on rows (visible on hover; pinned once checked) drive a header **Download** button that zips the selected items. Per-row hover action downloads a single item (file → direct; directory → single-item ZIP).
3. **Conflict policy:** Ask before overwriting. Stateless two-phase: first call writes non-conflicting files and reports conflicts; if the user approves overwrite, the client re-POSTs the same payload with `overwrite=true`.

## Architecture

```
Upload:   POST /api/files/[...path]?type=upload   (multipart/form-data, ?overwrite=true)
            target dir = [...path] (absolute, must be inside an allowed root)
Download: GET  /api/files/[...path]?type=download  (single file only → attachment stream)
          POST /api/files/archive                  (JSON {paths:[abs,...]} → streamed ZIP)
```

Two new streaming dependencies:

- **`busboy`** — streams multipart uploads straight to disk (avoids buffering 100+ MB in memory via `request.formData()`).
- **`archiver`** — streaming ZIP writer (with `@types/archiver`).

Both are the standard tools for these jobs and stream end-to-end.

## API contracts

### `POST /api/files/[...path]?type=upload`

- `[...path]` is the **target directory** (absolute). Must pass `isFilePathAllowed`.
- Body: `multipart/form-data`. Each file part carries its bytes; for folder uploads the client sets a `webkitRelativePath` field on the part (e.g. `subdir/file.txt`) so server-side structure is preserved.
- Query: `overwrite` (`"true"`/`"false"`, default `false`).
- Size guard: each part's bytes counted against `MAX_UPLOAD_BYTES = 200 * 1024 * 1024` per file → `413` if exceeded.
- Response `200`:
  ```json
  { "uploaded": [{"path": "...", "size": 123}],
    "conflicts": [{"path": "..."}],
    "errors":    [{"path": "...", "error": "..."}] }
  ```
- Behavior:
  - `overwrite=false`: write files whose target does not exist; for existing targets, append to `conflicts` and do **not** write.
  - `overwrite=true`: write all (replace existing).
  - Per-file filesystem errors (`EACCES`, `EROFS`, `ENOSPC`) are caught and reported in `errors`; the rest of the upload proceeds.
- Status codes: `400` (no files / bad target), `403` (target outside allowed roots), `413` (oversize), `500` (unexpected).

### `GET /api/files/[...path]?type=download`

- Single **file** only. Reuses the existing `streamFile()` helper but emits `Content-Disposition: attachment` (whereas `type=read` keeps inline disposition for in-app preview/media).
- Honors `Range` requests identically to `read`.
- `400` if the path is a directory (clients must ZIP directories).

### `POST /api/files/archive`

- Body: `{ "paths": ["<abs>", ...] }` (non-empty array).
- Validates **every** path with `isFilePathAllowed` before doing any work → `403` on any violation (whole request rejected; no partial archives).
- Streams a ZIP:
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment` with RFC 5987 UTF-8 filename (like the existing `getContentDisposition`). ZIP filename: single directory item → `<dirBasename>.zip`; single file item (client uses `?type=download` instead, but if it reaches archive) → `<fileBasename>.zip`; multiple items → `<rootBasename>-archive.zip` where `rootBasename` is the common allowed-root directory name (fallback `archive.zip`).
  - Each top-level entry is named by its **basename**; directory contents are included recursively, preserving structure. The repo `IGNORED_NAMES` filter (`node_modules`, `.git`, `.next`, …) is applied during recursion.
- Status codes: `400` (empty/invalid body), `403` (any path disallowed), `404` (a path does not exist), `500`.

## Path-traversal & filename sanitization (upload)

For every uploaded part, the server reconstructs the destination from `path.join(targetDir, sanitizedRelativePath)`:

1. Split the part's relative path on `/` and `\`.
2. For each segment: strip leading `/`; reject the whole upload with `400` if a segment is `..`, empty-after-trim, contains a NUL byte, or matches a Windows drive pattern (`^[a-zA-Z]:`).
3. `path.join(targetDir, ...sanitized)` → re-verify the resolved absolute path still passes `isFilePathAllowed`. Belt-and-suspenders.
4. `mkdirSync(dir, { recursive: true })` for any intermediate directory, then stream the bytes to the file via busboy's `file` stream piped to a `createWriteStream`.

## FileExplorer UI changes

- **Header row** (above the tree): `Upload` button + `Download` button + existing `Refresh`.
  - `Upload` → hidden `<input type="file" multiple>`; on change, POST to the **focus directory** (most recently expanded directory, or `cwd` root) with `overwrite=false`.
  - `Download` label: `Download` (disabled when `selectedPaths` empty) or `Download N` (enabled → `POST /api/files/archive` with the selected paths).
- **Selection:** new `selectedPaths: Set<string>` state. Each row shows a checkbox on hover; once a row is checked the checkbox stays visible. Checking any item also pins checkboxes visible across the tree while a selection exists.
- **Drop zone:** the explorer list area handles `dragover`/`drop` for **all** file types (not just images). On drop, read entries via `webkitGetAsEntry`, walk directory trees client-side, and build `File` objects annotated with `webkitRelativePath`. POST to the focus directory with `overwrite=false`.
- **Per-row hover:** keep the existing `mention` button; add a small download icon — file → `GET ?type=download`; directory → `POST /api/files/archive` with just that path.
- **Post-op:** bump `refreshKey` to reload the tree; auto-expand the target directory; surface a toast/inline status (`Uploading 3 files…`, `Zipping…`, `2 conflicts`).

### Conflict flow (client)

1. POST upload with `overwrite=false`.
2. If `conflicts.length > 0`, show a dialog listing them with **Overwrite / Cancel**.
3. On **Overwrite**, re-POST the identical payload with `overwrite=true`.
4. Merge `uploaded`/`errors` from both calls for the final status.

## State, errors & edge cases

- Toast/inline status per operation.
- Network drop mid-POST → inline error; non-conflicting files already written remain (by design).
- Folder upload colliding with an existing folder → merges into it; per-leaf conflict rules still apply.
- Read-only / permission-denied target → `EACCES`/`EROFS` captured per file, reported in `errors`.
- Drag-drop a folder whose name collides with an existing file (not directory) → that top-level item is reported in `errors` (`ENOTDIR`); other items proceed.

## File layout

| Path | Change |
| --- | --- |
| `app/api/files/[...path]/route.ts` | add `POST` (upload) + `type=download` branch in `GET` |
| `app/api/files/archive/route.ts` | **new** — `POST` ZIP stream |
| `lib/file-upload.ts` | **new** — busboy streaming writer + sanitization + conflict detection |
| `lib/file-archive.ts` | **new** — `archiver` ZIP helper (recursive, `IGNORED_NAMES`-aware) |
| `components/FileExplorer.tsx` | header, checkboxes, drop zone, per-row download icon |
| `hooks/useDragDrop.ts` | unchanged (still image-only for chat); explorer uses inline drop handlers because it needs folder entries |
| `package.json` | add `busboy`, `archiver`, `@types/archiver` (dev) |

## Verification plan

- `node_modules/.bin/tsc --noEmit`
- `npm run lint`
- Manual: upload single file, multi-file, folder (button + drag); conflict dialog flow; download single file; download multi-selection ZIP; download a directory ZIP; verify `../` and absolute-path filenames are rejected with 400; verify a path outside an allowed root is 403 for both upload target and archive member.
