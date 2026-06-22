import { afterEach, describe, it, expect } from "vitest";
import { isPathUnderRoot, assertCwdAllowed } from "./workspaceGuard.js";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccd-ws-"));
  tempDirs.push(dir);
  return dir;
}

describe("workspaceGuard", () => {
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it("isPathUnderRoot accepts child paths", () => {
    const root = tempDir();
    const child = join(root, "pkg", "src");
    mkdirSync(child, { recursive: true });
    expect(isPathUnderRoot(child, root)).toBe(true);
    expect(isPathUnderRoot(root, root)).toBe(true);
  });

  it("isPathUnderRoot rejects outside paths", () => {
    const root = tempDir();
    const other = tempDir();
    expect(isPathUnderRoot(other, root)).toBe(false);
  });

  it("assertCwdAllowed throws when not in allowlist", () => {
    const root = tempDir();
    const other = tempDir();
    expect(() => assertCwdAllowed(other, [root])).toThrow(/allowlist/);
  });

  it("assertCwdAllowed passes for listed root", () => {
    const root = tempDir();
    const child = join(root, "sub");
    mkdirSync(child);
    expect(() => assertCwdAllowed(child, [root])).not.toThrow();
  });

  it("rejects symlinks that point outside the allowlist", () => {
    const root = tempDir();
    const outside = tempDir();
    const link = join(root, "outside-link");
    symlinkSync(outside, link, "dir");
    expect(() => assertCwdAllowed(link, [root])).toThrow(/allowlist/);
  });
});