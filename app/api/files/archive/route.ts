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

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
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

  const members = resolved
    .flatMap((p) => collectArchiveMembers(p, ""))
    .filter((m) => {
      try {
        return isFilePathAllowed(fs.realpathSync(m.absPath), allowedRoots);
      } catch {
        return false;
      }
    });
  const archiveNodeStream = createArchiveStream(members);
  archiveNodeStream.on("error", (err) => {
    console.error("archive stream error:", err);
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
