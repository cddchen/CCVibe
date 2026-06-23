export type TrustInfo = { trusted: boolean; path: string; parent: string };

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function isTrustError(message: string): boolean {
  return /allowlist/i.test(message);
}