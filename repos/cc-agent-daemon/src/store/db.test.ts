import { describe, it, expect, afterEach } from "vitest";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetaStore } from "./db.js";

describe("MetaStore", () => {
  let dir: string;
  let store: MetaStore;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds and lists workspaces", () => {
    dir = mkdtempSync(join(tmpdir(), "ccd-store-"));
    const workspace = mkdtempSync(join(tmpdir(), "ccd-workspace-"));
    store = new MetaStore(dir);
    const w = store.addWorkspace(workspace);
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(w.path).toBe(realpathSync(workspace));
    expect(store.getWorkspacePaths()).toContain(realpathSync(workspace));
    rmSync(workspace, { recursive: true, force: true });
  });

  it("removes workspace", () => {
    dir = mkdtempSync(join(tmpdir(), "ccd-store-"));
    const workspace = mkdtempSync(join(tmpdir(), "ccd-workspace-"));
    store = new MetaStore(dir);
    const w = store.addWorkspace(workspace);
    expect(store.removeWorkspace(w.id)).toBe(true);
    expect(store.listWorkspaces()).toHaveLength(0);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stores symlinked workspaces as real paths", () => {
    dir = mkdtempSync(join(tmpdir(), "ccd-store-"));
    const workspace = mkdtempSync(join(tmpdir(), "ccd-workspace-"));
    const link = join(tmpdir(), `ccd-workspace-link-${Date.now()}`);
    symlinkSync(workspace, link, "dir");
    store = new MetaStore(dir);
    const w = store.addWorkspace(link);
    expect(w.path).toBe(realpathSync(workspace));
    rmSync(link, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects non-directory workspaces", () => {
    dir = mkdtempSync(join(tmpdir(), "ccd-store-"));
    const file = join(dir, "not-dir");
    closeSync(openSync(file, "w"));
    store = new MetaStore(dir);
    expect(() => store.addWorkspace(file)).toThrow(/not a directory/);
  });

  it("upserts and migrates session meta", () => {
    dir = mkdtempSync(join(tmpdir(), "ccd-store-"));
    store = new MetaStore(dir);
    store.upsertSessionMeta("runtime", "/p", { customName: "hi", pinned: true });
    store.migrateSessionMeta("runtime", "sdk", "/p");
    expect(store.getSessionMeta("runtime")).toBeUndefined();
    expect(store.getSessionMeta("sdk")).toMatchObject({ customName: "hi", pinned: 1 });
    store.upsertSessionMeta("sdk", "/p", { archived: true });
    store.deleteSessionMeta("sdk");
  });
});