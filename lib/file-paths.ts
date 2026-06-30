export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}

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
