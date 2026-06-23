import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatch } from "./router.js";
import type { AppContext } from "../app/context.js";
import type { ClientConnection } from "./connection.js";
import { PermissionRegistry } from "../permission/registry.js";
import { SessionRegistry } from "../session/registry.js";

function mockConn(authenticated = false): ClientConnection {
  return {
    id: "c1",
    authenticated,
    send: () => {},
    close: () => {},
  };
}

function mockCtx(token: string | null): AppContext {
  const workspaces: { id: string; path: string; createdAt: string }[] = [];
  const store = {
    listWorkspaces: () => workspaces,
    addWorkspace: (path: string) => {
      const w = { id: "w1", path, createdAt: new Date().toISOString() };
      workspaces.push(w);
      return w;
    },
    removeWorkspace: () => true,
    getWorkspacePaths: () => workspaces.map((w) => w.path),
    upsertSessionMeta: () => {},
    migrateSessionMeta: () => {},
    deleteSessionMeta: () => {},
    close: () => {},
  };
  return {
    config: {
      host: "127.0.0.1",
      port: 4733,
      dataDir: "/tmp",
      token,
      insecureNoAuth: token === null,
    },
    token,
    store: store as AppContext["store"],
    permissions: new PermissionRegistry(),
    sessions: new SessionRegistry(
      () => ({
        start: async () => ({ runtimeId: "r1" }),
        send: async () => {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        stop: async () => {},
      }),
      new PermissionRegistry(),
    ),
  };
}

describe("dispatch", () => {
  it("ping returns ok", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { id: 1, method: "ping" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("rejects unknown method", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { id: 2, method: "nope" });
    expect("error" in res && res.error.message).toMatch(/unknown method/);
  });

  it("requires auth when token configured", async () => {
    const ctx = mockCtx("secret");
    const conn = mockConn(false);
    const res = await dispatch(ctx, conn, { id: 3, method: "workspace.list" });
    expect("error" in res && res.error.code).toBe(-32001);
  });

  it("auth sets authenticated", async () => {
    const ctx = mockCtx("secret");
    const conn = mockConn(false);
    const res = await dispatch(ctx, conn, { id: 4, method: "auth", params: { token: "secret" } });
    expect(res).toEqual({ jsonrpc: "2.0", id: 4, result: { ok: true } });
    expect(conn.authenticated).toBe(true);
  });

  it("does not respond to client notifications", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { jsonrpc: "2.0", method: "ping" });
    expect(res).toBeUndefined();
  });

  it("does not auto-add workspaces from history.listAllLocal", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const before = ctx.store.listWorkspaces().length;
    const res = await dispatch(ctx, conn, { jsonrpc: "2.0", id: 5, method: "history.listAllLocal" });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 5, result: { projects: expect.any(Array) } });
    expect(ctx.store.listWorkspaces()).toHaveLength(before);
  });

  it("rejects history.listSessions for non-allowlisted workspaces", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const dir = mkdtempSync(join(tmpdir(), "ccd-history-"));
    try {
      const res = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 6,
        method: "history.listSessions",
        params: { workspacePath: dir },
      });
      expect(res).toMatchObject({ jsonrpc: "2.0", id: 6, error: { code: -32603 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workspace.checkTrust returns trusted false until workspace.add", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const dir = mkdtempSync(join(tmpdir(), "ccd-trust-"));
    try {
      const res1 = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 10,
        method: "workspace.checkTrust",
        params: { path: dir },
      });
      expect(res1).toMatchObject({
        jsonrpc: "2.0",
        id: 10,
        result: { trusted: false, parent: dirname(realpathSync(dir)) },
      });

      await dispatch(ctx, conn, { jsonrpc: "2.0", id: 11, method: "workspace.add", params: { path: dir } });

      const res2 = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 12,
        method: "workspace.checkTrust",
        params: { path: dir },
      });
      expect(res2).toMatchObject({ jsonrpc: "2.0", id: 12, result: { trusted: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns jsonrpc on errors", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { jsonrpc: "2.0", id: "bad", method: "nope" });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: "bad", error: { code: -32601 } });
  });

  it("rejects invalid jsonrpc versions", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { jsonrpc: "1.0" as "2.0", id: 7, method: "ping" });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32600 } });
  });

  it("returns active sessions via JSON-RPC shape", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, { jsonrpc: "2.0", id: 8, method: "session.listActive" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 8, result: { sessions: [] } });
  });

  it("session.attachIfLive attaches to an existing runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-attach-"));
    try {
      const ctx = mockCtx(null);
      const conn = mockConn(true);
      await dispatch(ctx, conn, { jsonrpc: "2.0", id: 20, method: "workspace.add", params: { path: dir } });
      const created = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 21,
        method: "session.create",
        params: { cwd: dir },
      });
      const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
      const res = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 22,
        method: "session.attachIfLive",
        params: { sessionId },
      });
      expect(res).toMatchObject({
        jsonrpc: "2.0",
        id: 22,
        result: { attached: true, sessionId },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session.attachIfLive returns attached false when no runner", async () => {
    const ctx = mockCtx(null);
    const conn = mockConn(true);
    const res = await dispatch(ctx, conn, {
      jsonrpc: "2.0",
      id: 23,
      method: "session.attachIfLive",
      params: { sessionId: "missing-session" },
    });
    expect(res).toEqual({ jsonrpc: "2.0", id: 23, result: { attached: false } });
  });

  it("session.resume supersedes an existing live runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-resume-"));
    const stopped: string[] = [];
    let createCount = 0;
    try {
      const ctx = mockCtx(null);
      const permissions = new PermissionRegistry();
      const sessions = new SessionRegistry(
        () => {
          createCount++;
          return {
            start: async (_opts, hooks, runtimeId) => {
              hooks.onMessage({ type: "system", subtype: "init", session_id: "disk-sess" });
              return { runtimeId };
            },
            send: async () => {},
            interrupt: async () => {},
            setPermissionMode: async () => {},
            stop: async (runtimeId) => {
              stopped.push(runtimeId);
            },
          };
        },
        permissions,
      );
      (ctx as { sessions: typeof sessions }).sessions = sessions;
      const conn = mockConn(true);
      await dispatch(ctx, conn, { jsonrpc: "2.0", id: 30, method: "workspace.add", params: { path: dir } });
      await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 31,
        method: "session.create",
        params: { cwd: dir },
      });
      const resumed = await dispatch(ctx, conn, {
        jsonrpc: "2.0",
        id: 32,
        method: "session.resume",
        params: { sessionId: "disk-sess", cwd: dir },
      });
      expect(stopped).toHaveLength(1);
      expect(createCount).toBe(2);
      expect(resumed).toMatchObject({ jsonrpc: "2.0", id: 32, result: { sessionId: expect.any(String) } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});