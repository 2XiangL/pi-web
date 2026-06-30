# File Upload & Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace file upload (files + folders) and download (single file, multi-file ZIP, directory ZIP) to the pi-web UI.

**Architecture:** Two new streaming deps (`busboy` for multipart→disk, `archiver` for ZIP). Three server additions hang off the existing `/api/files` scoping (`isFilePathAllowed`): a `type=download` GET branch, a `POST .../upload` multipart handler, and a new `POST /api/files/archive` ZIP route. `FileExplorer.tsx` grows an internal toolbar (Upload + Download buttons), checkbox selection, a drop zone (folder-aware via `webkitGetAsEntry`), and inline status.

**Tech Stack:** Next.js 16 route handlers (Node runtime), React 19, TypeScript, `busboy@^1`, `archiver@^7`, `@types/archiver`, `@types/busboy`.

## Global Constraints

- **No test suite exists in this repo.** Verification per task = `node_modules/.bin/tsc --noEmit`, then `npm run lint`, then manual exercise. Do NOT introduce a test framework.
- **Never run `next build` / `npm run build` during dev.** Dev server is `npm run dev` (port 30141).
- **Every file path read or written MUST pass `isFilePathAllowed` from `@/lib/file-access`.** No bypass. This applies per uploaded segment, per ZIP member, and to the upload target directory.
- Path alias `@/*` → repo root. Follow existing inline-style (no CSS modules) and the `var(--*)` theme tokens.
- Do not add comments to source files (repo convention).

---

## Task 1: Add streaming deps + shared ignore-filter module

**Files:**
- Create: `lib/file-filter.ts`
- Modify: `app/api/files/[...path]/route.ts` (remove duplicated `IGNORED_NAMES`/`IGNORED_SUFFIXES`, import from new module)
- Modify: `package.json` / `package-lock.json` (via npm)

**Interfaces:**
- Produces: `isIgnoredName(name: string): boolean`, plus exported `IGNORED_NAMES: Set<string>` and `IGNORED_SUFFIXES: string[]` from `@/lib/file-filter`.

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install busboy@^1 archiver
npm install -D @types/archiver @types/busboy
```
Expected: packages added to `dependencies` / `devDependencies` in `package.json`; lockfile updated.

- [ ] **Step 2: Create `lib/file-filter.ts`**

```ts
export const IGNORED_NAMES = new Set<string>([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

export const IGNORED_SUFFIXES = [".pyc"];

export function isIgnoredName(name: string): boolean {
  if (IGNORED_NAMES.has(name)) return true;
  return IGNORED_SUFFIXES.some((s) => name.endsWith(s));
}
```

- [ ] **Step 3: Refactor `app/api/files/[...path]/route.ts` to use it**

In `app/api/files/[...path]/route.ts`:

Remove these lines (the local consts near the top):
```ts
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];
```

Add to the existing import block at the top:
```ts
import { isIgnoredName } from "@/lib/file-filter";
```

Replace the directory-listing filter (in the `// type === "list"` section):
```ts
      .filter((name) => !IGNORED_NAMES.has(name) && !IGNORED_SUFFIXES.some((s) => name.endsWith(s)))
```
with:
```ts
      .filter((name) => !isIgnoredName(name))
```

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors. If `tsc` reports it cannot find types for `busboy`, confirm `@types/busboy` is in `devDependencies` (it is from Step 1).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Manual smoke test**

Run `npm run dev`, open http://localhost:30141, open a project in the sidebar, and confirm the file tree still lists files/dirs (and still hides `node_modules`, `.git`).

- [ ] **Step 7: Commit**

```bash
git add lib/file-filter.ts app/api/files/\[...path\]/route.ts package.json package-lock.json
git commit -m "feat: add busboy/archiver deps and shared file-ignore filter"
```

---

## Task 2: Single-file download (`type=download` GET branch)

**Files:**
- Modify: `app/api/files/[...path]/route.ts`

**Interfaces:**
- Produces: `GET /api/files/<encoded>?type=download` → streams one file with `Content-Disposition: attachment`. Reuses existing `streamFile` (signature widened below).

- [ ] **Step 1: Widen `getContentDisposition` to support attachment**

In `app/api/files/[...path]/route.ts`, change:
```ts
function getContentDisposition(filePath: string): string {
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}
```
to:
```ts
function getContentDisposition(
  filePath: string,
  disposition: "inline" | "attachment" = "inline"
): string {
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}
```

- [ ] **Step 2: Widen `streamFile` to pass disposition**

Change the `streamFile` signature and its `headers` block from:
```ts
function streamFile(filePath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath),
  };
```
to:
```ts
function streamFile(
  filePath: string,
  stat: fs.Stats,
  contentType: string,
  rangeHeader: string | null,
  disposition: "inline" | "attachment" = "inline"
): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, disposition),
  };
```

- [ ] **Step 3: Add the `type=download` branch**

Inside `export async function GET(...)`, immediately BEFORE the `// type === "list"` section, add:
```ts
    if (type === "download") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime =
        getImageMime(filePath) ??
        getAudioMime(filePath) ??
        getDocumentMime(filePath) ??
        "application/octet-stream";
      return streamFile(filePath, stat, mime, request.headers.get("range"), "attachment");
    }
```

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Manual verify**

With `npm run dev` running and a session open whose `cwd` is an allowed root, pick any file in that cwd and download it via curl (replace `<encoded>` with the URL-encoded absolute path produced by `encodeFilePathForApi`, and ensure the path is under a session cwd):

```bash
curl -OJ "http://localhost:30141/api/files/<encoded>?type=download"
```
Expected: a file is saved with the correct original name. Confirm a directory path returns `{"error":"Not a file"}` (400):
```bash
curl -i "http://localhost:30141/api/files/<encoded-dir>?type=download"
```

- [ ] **Step 7: Commit**

```bash
git add app/api/files/\[...path\]/route.ts
git commit -m "feat: add single-file download endpoint (?type=download)"
```

---

## Task 3: ZIP archive — `lib/file-archive.ts` + `POST /api/files/archive`

**Files:**
- Create: `lib/file-archive.ts`
- Create: `app/api/files/archive/route.ts`

**Interfaces:**
- Consumes: `isIgnoredName` from `@/lib/file-filter`; `getAllowedFileRoots`, `isFilePathAllowed` from `@/lib/file-access`.
- Produces:
  - `lib/file-archive.ts` → `collectArchiveMembers(absPath: string, prefix: string): ArchiveMember[]` and `createArchiveStream(members: ArchiveMember[]): Readable` where `ArchiveMember = { absPath: string; entryName: string }`.
  - `POST /api/files/archive` → `{ "paths": string[] }` body → streamed `application/zip` response. `400` empty body, `403` any disallowed path, `404` missing path, `500` unexpected.

- [ ] **Step 1: Create `lib/file-archive.ts`**

```ts
import fs from "fs";
import path from "path";
import archiver from "archiver";
import type { Readable } from "stream";
import { isIgnoredName } from "./file-filter";

export interface ArchiveMember {
  absPath: string;
  entryName: string;
}

export function collectArchiveMembers(absPath: string, prefix: string): ArchiveMember[] {
  const members: ArchiveMember[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return members;
  }

  if (stat.isFile()) {
    members.push({ absPath, entryName: prefix || path.basename(absPath) });
    return members;
  }
  if (!stat.isDirectory()) {
    return members;
  }

  const dirName = prefix || path.basename(absPath);
  let names: string[] = [];
  try {
    names = fs.readdirSync(absPath);
  } catch {
    return members;
  }
  for (const name of names) {
    if (isIgnoredName(name)) continue;
    const childAbs = path.join(absPath, name);
    members.push(...collectArchiveMembers(childAbs, dirName + "/" + name));
  }
  return members;
}

export function createArchiveStream(members: ArchiveMember[]): Readable {
  const archive = archiver("zip", { zlib: { level: 5 } });
  for (const m of members) {
    try {
      const st = fs.statSync(m.absPath);
      if (!st.isFile()) continue;
      archive.append(fs.createReadStream(m.absPath), { name: m.entryName, mode: st.mode });
    } catch {
      // skip unreadable members
    }
  }
  archive.finalize();
  return archive as unknown as Readable;
}
```

- [ ] **Step 2: Create `app/api/files/archive/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { collectArchiveMembers, createArchiveStream } from "@/lib/file-archive";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function zipFileName(paths: string[], allowedRoots: Set<string>): string {
  if (paths.length === 1) {
    return path.basename(paths[0].replace(/\/+$/, "")) + ".zip";
  }
  const first = paths[0];
  let rootName = "archive";
  for (const root of allowedRoots) {
    const r = path.resolve(root);
    if (first === r || first.startsWith(r + path.sep)) {
      rootName = path.basename(r) || "archive";
      break;
    }
  }
  return `${rootName.slice(0, 40)}-archive.zip`;
}

export async function POST(req: NextRequest) {
  let body: { paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawPaths = Array.isArray(body.paths) ? (body.paths as unknown[]) : null;
  if (!rawPaths || rawPaths.length === 0 || rawPaths.some((p) => typeof p !== "string")) {
    return NextResponse.json({ error: "paths must be a non-empty array of strings" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  const resolved = (rawPaths as string[]).map((p) => path.resolve(p));

  for (const p of resolved) {
    if (!isFilePathAllowed(p, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", path: p }, { status: 403 });
    }
    if (!fs.existsSync(p)) {
      return NextResponse.json({ error: "Not found", path: p }, { status: 404 });
    }
  }

  const members = resolved.flatMap((p) => collectArchiveMembers(p, ""));
  const archiveNodeStream = createArchiveStream(members);
  archiveNodeStream.on("error", () => {
    // stream error after headers are sent cannot be recovered; client gets a truncated zip
  });

  const webStream = Readable.toWeb(archiveNodeStream) as unknown as ReadableStream<Uint8Array>;
  const fileName = zipFileName(resolved, allowedRoots);

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(fileName),
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
```

> Note: a static segment `archive` takes precedence over the catch-all `[...path]` route in Next.js, so `POST /api/files/archive` is routed here, not to the catch-all.

- [ ] **Step 3: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors. If `Readable.toWeb` typing fails, the cast (`as unknown as ReadableStream<Uint8Array>`) already covers it.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual verify (single dir → zip)**

With `npm run dev` running, choose a directory `DIR` that lives under a session cwd. ZIP it:
```bash
curl -X POST http://localhost:30141/api/files/archive \
  -H "Content-Type: application/json" \
  -d '{"paths":["<DIR-abs>"]}' \
  -o out.zip && unzip -l out.zip
```
Expected: `out.zip` lists the directory's files (excluding `node_modules`, `.git`, etc.), preserving subpaths.

- [ ] **Step 6: Manual verify (multi-file + security)**

```bash
# multiple files
curl -X POST http://localhost:30141/api/files/archive \
  -H "Content-Type: application/json" \
  -d '{"paths":["<abs-file-1>","<abs-file-2>"]}' -o multi.zip && unzip -l multi.zip

# disallowed path -> 403
curl -i -X POST http://localhost:30141/api/files/archive \
  -H "Content-Type: application/json" \
  -d '{"paths":["/etc/hosts"]}'

# empty body -> 400
curl -i -X POST http://localhost:30141/api/files/archive \
  -H "Content-Type: application/json" -d '{"paths":[]}'
```
Expected: multi.zip contains both files by basename; `/etc/hosts` → `403 Access denied`; empty → `400`.

- [ ] **Step 7: Commit**

```bash
git add lib/file-archive.ts app/api/files/archive/route.ts
git commit -m "feat: add directory/multi-file ZIP download endpoint"
```

---

## Task 4: Upload — `lib/file-upload.ts` + `POST /api/files/[...path]?type=upload`

**Files:**
- Create: `lib/file-upload.ts`
- Modify: `app/api/files/[...path]/route.ts` (add `POST` export)

**Interfaces:**
- Consumes: `isFilePathAllowed` from `@/lib/file-access`.
- Produces:
  - `lib/file-upload.ts` → `MAX_UPLOAD_BYTES`, `sanitizeRelativePath`, `resolveUploadTarget`, `streamUpload`.
  - `streamUpload(targetDir, allowedRoots, request, overwrite) => Promise<UploadResult>` where `UploadResult = { uploaded: {path,size}[]; conflicts: {path}[]; errors: {path,error}[] }`.
  - `POST /api/files/<encoded-target-dir>?type=upload` (multipart `files` parts; `?overwrite=true`). The **part filename IS the relative path** (client sets it; folder uploads send `subdir/file.txt` as the filename). Server sanitizes each segment. `400` bad target, `403` target outside allowed roots, `413` per-file size exceeded, `500` unexpected.

- [ ] **Step 1: Create `lib/file-upload.ts`**

```ts
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import busboy from "busboy";
import { isFilePathAllowed } from "./file-access";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface UploadResult {
  uploaded: { path: string; size: number }[];
  conflicts: { path: string }[];
  errors: { path: string; error: string }[];
}

export type SanitizeResult = { ok: true; segments: string[] } | { ok: false; reason: string };

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

export function sanitizeRelativePath(raw: string): SanitizeResult {
  if (!raw) return { ok: false, reason: "empty filename" };
  const parts = raw
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { ok: false, reason: "empty filename" };
  for (const seg of parts) {
    if (seg === "..") return { ok: false, reason: "path segment '..' not allowed" };
    if (seg.includes("\0")) return { ok: false, reason: "NUL byte in filename" };
    if (WINDOWS_DRIVE_RE.test(seg)) return { ok: false, reason: `drive-letter segment not allowed: ${seg}` };
  }
  const cleaned = parts.filter((seg) => seg !== ".");
  if (cleaned.length === 0) return { ok: false, reason: "empty filename" };
  return { ok: true, segments: cleaned };
}

export function resolveUploadTarget(targetDir: string, segments: string[]): string {
  return path.join(targetDir, ...segments);
}

function handleOneFile(
  fileStream: NodeJS.ReadableStream,
  filename: string,
  targetDir: string,
  allowedRoots: Set<string>,
  overwrite: boolean,
  result: UploadResult
): Promise<void> {
  return new Promise((resolveFile) => {
    // Busboy's per-file stream adds non-standard events (e.g. "limit") that
    // @types/busboy does not declare consistently across versions. Cast once
    // to the minimal contract we rely on so this typechecks regardless.
    const file = fileStream as unknown as {
      resume(): void;
      on(event: "close", listener: () => void): void;
      on(event: "data", listener: (chunk: Buffer) => void): void;
      on(event: "limit", listener: () => void): void;
      pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    };

    const sanitized = sanitizeRelativePath(filename);
    if (!sanitized.ok) {
      file.resume();
      file.on("close", () => {
        result.errors.push({ path: filename, error: sanitized.reason });
        resolveFile();
      });
      return;
    }

    const dest = resolveUploadTarget(targetDir, sanitized.segments);

    if (!isFilePathAllowed(dest, allowedRoots)) {
      file.resume();
      file.on("close", () => {
        result.errors.push({ path: dest, error: "destination outside allowed root" });
        resolveFile();
      });
      return;
    }

    const exists = fs.existsSync(dest);
    if (exists && !overwrite) {
      file.resume();
      file.on("close", () => {
        result.conflicts.push({ path: dest });
        resolveFile();
      });
      return;
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch (err) {
      file.resume();
      file.on("close", () => {
        result.errors.push({ path: dest, error: err instanceof Error ? err.message : String(err) });
        resolveFile();
      });
      return;
    }

    let oversized = false;
    let received = 0;
    const ws = fs.createWriteStream(dest);

    file.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    file.on("limit", () => {
      oversized = true;
    });

    file.pipe(ws);

    ws.on("close", () => {
      if (oversized) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        result.errors.push({ path: dest, error: "exceeds size limit" });
      } else {
        result.uploaded.push({ path: dest, size: received });
      }
      resolveFile();
    });
    ws.on("error", (err) => {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      result.errors.push({ path: dest, error: err.message });
      resolveFile();
    });
  });
}

export function streamUpload(
  targetDir: string,
  allowedRoots: Set<string>,
  request: Request,
  overwrite: boolean
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const result: UploadResult = { uploaded: [], conflicts: [], errors: [] };
    const filePromises: Promise<void>[] = [];

    const bb = busboy({
      headers: Object.fromEntries(request.headers) as Record<string, string>,
      limits: { fileSize: MAX_UPLOAD_BYTES },
    });

    // Cast bb to a minimal emitter so the listener is accepted regardless of
    // whether @types/busboy's `file` callback uses the object form
    // `(fieldname, stream, info)` or the positional form
    // `(fieldname, stream, filename, encoding, mimetype)`.
    const bbAny = bb as unknown as {
      on(event: "file", listener: (...args: unknown[]) => void): void;
      on(event: "finish", listener: () => void): void;
      on(event: "error", listener: (err: unknown) => void): void;
    };

    bbAny.on("file", (...args: unknown[]) => {
      const fileStream = args[1] as NodeJS.ReadableStream;
      const third = args[2];
      const filename =
        typeof third === "string"
          ? third
          : (third as { filename?: string } | undefined)?.filename ?? "file";
      filePromises.push(handleOneFile(fileStream, filename, targetDir, allowedRoots, overwrite, result));
    });

    bbAny.on("finish", async () => {
      try {
        await Promise.all(filePromises);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });

    bbAny.on("error", (err) => reject(err));

    const bodyNodeStream = Readable.fromWeb(request.body as ReadableStream<Uint8Array>);
    bodyNodeStream.pipe(bb);
  });
}
```

> The rest-args listener above is deliberately written to accept either `@types/busboy` callback shape, so no adjustment should be needed between versions. If `tsc` still complains about `busboy` itself (e.g. it ships its own types that differ from `@types/busboy`), uninstall `@types/busboy` and re-run `tsc`; the `bbAny` cast keeps this code decoupled from either source.

- [ ] **Step 2: Add `POST` export to `app/api/files/[...path]/route.ts`**

Add to the existing imports in that file:
```ts
import { streamUpload } from "@/lib/file-upload";
```

Append a new `POST` handler at the end of the file (after the `GET` export):
```ts
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const targetDir = filePathFromSegments(segments);
    const overwrite = request.nextUrl.searchParams.get("overwrite") === "true";

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(targetDir, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetDir);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Target is not a directory" }, { status: 400 });
    }

    const result = await streamUpload(targetDir, allowedRoots, request, overwrite);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors. (If the busboy `file` signature mismatch described in the note above appears, apply the noted fix and re-run.)

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual verify — basic upload + conflict flow**

With `npm run dev` running and a target directory `TDIR` under a session cwd:

Upload two small files (first call, `overwrite=false`):
```bash
echo hello > /tmp/a.txt
echo world > /tmp/b.txt
curl -i -X POST "http://localhost:30141/api/files/<TDIR-encoded>?type=upload" \
  -F "files=@/tmp/a.txt" -F "files=@/tmp/b.txt"
```
Expected: `200` with `uploaded: [{path ...}, {path ...}]`, `conflicts: []`. Confirm both files exist in `TDIR`.

Re-upload the same files (conflict path):
```bash
curl -i -X POST "http://localhost:30141/api/files/<TDIR-encoded>?type=upload" \
  -F "files=@/tmp/a.txt"
```
Expected: `200` with `conflicts: [{path ...}]`, `uploaded: []`.

Overwrite path:
```bash
curl -i -X POST "http://localhost:30141/api/files/<TDIR-encoded>?type=upload?overwrite=true" \
  -F "files=@/tmp/a.txt"
```
Expected: `200` with `uploaded: [{path ...}]`.

- [ ] **Step 6: Manual verify — traversal rejection + oversize**

Path-traversal (the `../` is in the server-controlled filename only via our client; curl sends the literal filename, so test sanitization by forcing a malicious name):
```bash
curl -i -X POST "http://localhost:30141/api/files/<TDIR-encoded>?type=upload" \
  -F "files=@/tmp/a.txt;filename=../evil.txt"
```
Expected: `200` with `errors: [{ path: "../evil.txt", error: "path segment '..' not allowed" }]`, and `../evil.txt` is NOT created outside `TDIR`.

Oversize (create a >200MB file is impractical; instead temporarily set `MAX_UPLOAD_BYTES` to `1024` in `lib/file-upload.ts`, restart dev, upload a small file, confirm `413`-style `errors` entry and the file is unlinked, then revert the constant):
```bash
# after temporarily lowering the limit and restarting:
curl -i -X POST "http://localhost:30141/api/files/<TDIR-encoded>?type=upload" -F "files=@/tmp/a.txt"
# expected: errors: [{ error: "exceeds size limit" }]; no file written
```

- [ ] **Step 7: Commit**

```bash
git add lib/file-upload.ts app/api/files/\[...path\]/route.ts
git commit -m "feat: add streaming multipart upload with sanitization + conflicts"
```

---

## Task 5: FileExplorer UI — selection, download, upload, drag-drop, status

**Files:**
- Modify: `components/FileExplorer.tsx` (full rewrite of the component body to add toolbar, selection, drop zone, status)

**Interfaces:**
- Consumes (network): `GET /api/files/<enc>?type=download`, `POST /api/files/archive` `{paths}`, `POST /api/files/<enc>?type=upload[&overwrite=true]` (multipart `files` parts, filename = relative path).
- Produces: same `Props` as before (`cwd`, `onOpenFile`, `refreshKey`, `onAtMention`); no change to `SessionSidebar.tsx`.

UX implemented:
- A toolbar row at the top of the explorer with **Upload** (opens `<input type=file multiple>`) and **Download** (`Download` disabled when nothing selected, else `Download N` → POST archive).
- Per-row hover checkbox for selection (pinned visible once the row is checked). A small per-row download icon: file → direct `?type=download`; dir → single-item archive.
- The whole list area is a drop zone accepting files AND folders (folder walk via `webkitGetAsEntry`).
- Upload target = the most recently expanded directory, or `cwd` if none expanded.
- Two-phase overwrite: on conflicts, `window.confirm` listing a sample; on accept, re-POST with `overwrite=true`.
- Inline status line (info/success/error) with auto-clear.

- [ ] **Step 1: Replace `components/FileExplorer.tsx` with the full new implementation**

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors. (`FileSystemEntry`, `FileSystemFileEntry`, `FileSystemDirectoryEntry`, `DataTransfer`, `webkitGetAsEntry` are all in the DOM lib already included by `tsconfig.json`.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual verify — selection + download**

With `npm run dev` running, open a project in the sidebar:
1. Hover rows → checkbox + download icon appear; clicking a row still expands/opens as before.
2. Check 2–3 files → header button reads `Download N`; click → a ZIP downloads containing those files by basename.
3. Click a single directory's download icon → a `<dirname>.zip` downloads with its contents (no `node_modules`).
4. Click a single file's download icon → the file downloads directly (not zipped).

- [ ] **Step 5: Manual verify — upload (button + drag, files + folders, conflict)**

1. Click **Upload** → pick 2 new files → tree refreshes; status shows `Uploaded 2 file(s)`. Files appear under `cwd` (no dir expanded) or under the most recently expanded directory.
2. Upload a file whose name already exists → a confirm dialog appears naming a sample conflict path; choose **Cancel** (file untouched) then repeat choosing **OK** (file replaced).
3. Drag a folder from the OS file manager onto the explorer → its contents upload recursively into the target directory, preserving subpaths.
4. Drag a file that would traverse outside the root (e.g. craft via devtools if needed) → server reports a per-file error in status; nothing is created outside the workspace.

- [ ] **Step 6: Commit**

```bash
git add components/FileExplorer.tsx
git commit -m "feat: add upload/download UI to FileExplorer (selection, drag-drop, zip)"
```

---

## Final verification (after Task 5)

- [ ] **A. Full typecheck:** `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **B. Full lint:** `npm run lint` → clean.
- [ ] **C. Security sweep (manual):** for each of upload target, every ZIP member, and `type=download`, confirm a path outside an allowed root returns 403 / is rejected and nothing is written/read outside the workspace.
- [ ] **D. End-to-end happy path:** upload a folder via drag-drop → it appears in the tree → multi-select its files + the folder → Download N → unzip and confirm contents match.

## Notes for the implementer

- The repo's `AGENTS.md` is the source of truth for toolchain quirks (Next 16, Tailwind v4, `serverExternalPackages`, `@/*` alias). Re-read it if a bundler/type error seems mysterious.
- The `NoticeShelf` in `ChatWindow.tsx` is agent-session-scoped; do NOT wire upload status into it — keep status local to `FileExplorer` as implemented.
- If `busboy`'s `file` event type signature differs from `(fieldname, fileStream, info)` (positional vs object), Task 4 Step 3's typecheck will tell you; apply the note in Task 4 Step 1.
