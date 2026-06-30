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
