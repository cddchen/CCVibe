import { realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

export function canonicalPath(path: string): string {
  return normalize(realpathSync(path));
}

export function isPathUnderRoot(candidate: string, root: string): boolean {
  const c = canonicalPath(candidate);
  const r = canonicalPath(root);
  return c === r || c.startsWith(r + sep);
}

export function assertCwdAllowed(cwd: string, allowedRoots: string[]): void {
  let resolved: string;
  try {
    resolved = canonicalPath(cwd);
  } catch {
    throw new Error(`cwd not in workspace allowlist: ${resolve(cwd)}`);
  }
  const ok = allowedRoots.some((root) => {
    try {
      return isPathUnderRoot(resolved, root);
    } catch {
      return false;
    }
  });
  if (!ok) {
    throw new Error(`cwd not in workspace allowlist: ${resolved}`);
  }
}