import fs from "fs";
import path from "path";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
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
      on(event: "error", listener: (err: Error) => void): void;
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
    let settled = false;
    let errored = false;
    const ws = fs.createWriteStream(dest);

    const settle = (record: () => void): void => {
      if (settled) return;
      settled = true;
      record();
      resolveFile();
    };

    file.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    file.on("limit", () => {
      oversized = true;
    });
    file.on("error", () => {
      // busboy file stream errored — propagate to ws so it settles via its own handlers
      errored = true;
      ws.destroy(new Error("upload stream error"));
    });

    file.pipe(ws);

    ws.on("close", () => {
      settle(() => {
        if (errored) return;
        if (oversized) {
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
          result.errors.push({ path: dest, error: "exceeds size limit" });
        } else {
          result.uploaded.push({ path: dest, size: received });
        }
      });
    });
    ws.on("error", (err) => {
      settle(() => {
        errored = true;
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        result.errors.push({ path: dest, error: err.message });
      });
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
      preservePath: true,
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
      if (args[0] !== "files") {
        (args[1] as NodeJS.ReadableStream).resume();
        return;
      }
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

    const bodyNodeStream = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
    bodyNodeStream.on("error", (err) => bb.destroy(err));
    bodyNodeStream.pipe(bb);
  });
}
