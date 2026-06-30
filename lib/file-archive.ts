import fs from "fs";
import path from "path";
import { ZipArchive } from "archiver";
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
  const archive = new ZipArchive({ zlib: { level: 5 } });
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
