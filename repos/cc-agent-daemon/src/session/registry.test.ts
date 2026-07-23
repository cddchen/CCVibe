import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionRegistry } from "../permission/registry.js";
import type { ClientConnection } from "../rpc/connection.js";
import { SessionRegistry } from "./registry.js";
import type { EngineAdapter, EngineHooks, EngineUserInput } from "./engine.js";

function mockConn(id = "conn1"): ClientConnection {
  return {
    id,
    authenticated: true,
    send: () => {},
    close: () => {},
  };
}

function engineBase(overrides: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    start: async (_opts, _hooks, runtimeId) => ({ runtimeId }),
    send: async () => {},
    interrupt: async () => ({ still_queued: [] }),
    reinitialize: async () => {},
    setPermissionMode: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  it("returns a runtime alias before SDK session_id and keeps both aliases", async () => {
    let hooks: EngineHooks | undefined;
    const sent: Array<{ runtimeId: string; input: EngineUserInput }> = [];
    const engine = engineBase({
      start: async (_opts, engineHooks, runtimeId) => {
        hooks = engineHooks;
        return { runtimeId };
      },
      send: async (runtimeId, input) => {
        sent.push({ runtimeId, input });
      },
    });
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());
    const aliased: Array<{ sdkSessionId: string; runtimeId: string }> = [];

    const runtimeId = await registry.create(
      { cwd: process.cwd() },
      mockConn(),
      "hello",
      (sdkSessionId, id) => aliased.push({ sdkSessionId, runtimeId: id }),
    );

    expect(runtimeId).toMatch(/[0-9a-f-]{36}/);
    expect(sent).toEqual([
      {
        runtimeId,
        input: { id: expect.stringMatching(/[0-9a-f-]{36}/), content: "hello" },
      },
    ]);
    expect(registry.get(runtimeId)).toBeDefined();

    hooks?.onMessage({ type: "system", subtype: "init", session_id: "sdk-session" } as never);

    expect(registry.get("sdk-session")).toBe(registry.get(runtimeId));
    expect(aliased).toEqual([{ sdkSessionId: "sdk-session", runtimeId }]);
  });

  it("keeps an idle streaming session active after a turn result", async () => {
    let hooks: EngineHooks | undefined;
    const engine = engineBase({
      start: async (_opts, engineHooks, runtimeId) => {
        hooks = engineHooks;
        return { runtimeId };
      },
    });
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());
    const runtimeId = await registry.create({ cwd: process.cwd() }, mockConn(), "hello");

    hooks?.onMessage({ type: "result", subtype: "success", is_error: false } as never);

    expect(registry.listActive()).toContainEqual(
      expect.objectContaining({ sessionId: runtimeId, status: "idle", runtimeStatus: "running" }),
    );
  });

  it("unregisters a runtime only when its SDK query closes", async () => {
    let hooks: EngineHooks | undefined;
    const engine = engineBase({
      start: async (_opts, engineHooks, runtimeId) => {
        hooks = engineHooks;
        return { runtimeId };
      },
    });
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());
    const runtimeId = await registry.create({ cwd: process.cwd() }, mockConn());
    expect(registry.get(runtimeId)).toBeDefined();

    hooks?.onRuntimeClosed();

    expect(registry.get(runtimeId)).toBeUndefined();
    expect(registry.listActive()).toEqual([]);
  });

  it("remove stops and unregisters sessions by runtime alias", async () => {
    const stopped: string[] = [];
    const engine = engineBase({
      stop: async (runtimeId) => {
        stopped.push(runtimeId);
      },
    });
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());

    const runtimeId = await registry.create({ cwd: process.cwd() }, mockConn());
    await registry.remove(runtimeId);

    expect(stopped).toEqual([runtimeId]);
    expect(registry.get(runtimeId)).toBeUndefined();
  });

  it("stops every unique runtime during daemon shutdown", async () => {
    const stopped: string[] = [];
    const registry = new SessionRegistry(
      () => engineBase({ stop: async (runtimeId) => { stopped.push(runtimeId); } }),
      new PermissionRegistry(),
    );
    await registry.create({ cwd: process.cwd() }, mockConn("conn-1"));
    await registry.create({ cwd: process.cwd() }, mockConn("conn-2"));

    await registry.shutdown();

    expect(stopped).toHaveLength(2);
    expect(registry.listActive()).toEqual([]);
  });

  describe("idle reclaim", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("stops and unregisters after an idle turn even while subscribed", async () => {
      let hooks: EngineHooks | undefined;
      const stopped: string[] = [];
      const engine = engineBase({
        start: async (_opts, engineHooks, runtimeId) => {
          hooks = engineHooks;
          return { runtimeId };
        },
        stop: async (runtimeId) => {
          stopped.push(runtimeId);
        },
      });
      const registry = new SessionRegistry(() => engine, new PermissionRegistry(), 1000);
      const conn = mockConn();
      const runtimeId = await registry.create({ cwd: process.cwd() }, conn, "hello");
      hooks?.onMessage({ type: "result", subtype: "success", is_error: false } as never);
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();
      expect(stopped).toEqual([runtimeId]);
      expect(registry.get(runtimeId)).toBeUndefined();
    });

    it("does not stop while a turn is running", async () => {
      const stopped: string[] = [];
      const engine = engineBase({
        stop: async (runtimeId) => {
          stopped.push(runtimeId);
        },
      });
      const registry = new SessionRegistry(() => engine, new PermissionRegistry(), 1000);
      const conn = mockConn();
      const runtimeId = await registry.create({ cwd: process.cwd() }, conn, "work");
      registry.onClientDisconnect(conn.id);
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();
      expect(stopped).toEqual([]);
      expect(registry.get(runtimeId)).toBeDefined();
    });
  });

  describe("thread capacity", () => {
    it("reuses the single runner registered for a conversation", async () => {
      let engines = 0;
      const registry = new SessionRegistry(
        () => {
          engines += 1;
          return engineBase();
        },
        new PermissionRegistry(),
      );

      const first = await registry.create({ cwd: process.cwd() }, mockConn("one"), undefined, undefined, "conversation-1");
      const second = await registry.create({ cwd: process.cwd() }, mockConn("two"), undefined, undefined, "conversation-1");

      expect(second).toBe(first);
      expect(engines).toBe(1);
      expect(registry.listActive()).toHaveLength(1);
    });

    it("evicts the least recently completed idle conversation before spawning", async () => {
      vi.useFakeTimers();
      const hooks = new Map<string, EngineHooks>();
      const stopped: string[] = [];
      const registry = new SessionRegistry(
        () => engineBase({
          start: async (_opts, engineHooks, runtimeId) => {
            hooks.set(runtimeId, engineHooks);
            return { runtimeId };
          },
          stop: async (runtimeId) => { stopped.push(runtimeId); },
        }),
        new PermissionRegistry(),
        { autoReclaimMs: 60_000, maxThreads: 2 },
      );

      vi.setSystemTime(1_000);
      const oldest = await registry.create({ cwd: process.cwd() }, mockConn("one"), "first", undefined, "conversation-1");
      hooks.get(oldest)?.onMessage({ type: "result", subtype: "success", is_error: false } as never);

      vi.setSystemTime(2_000);
      const newest = await registry.create({ cwd: process.cwd() }, mockConn("two"), "second", undefined, "conversation-2");
      hooks.get(newest)?.onMessage({ type: "result", subtype: "success", is_error: false } as never);

      const third = await registry.create({ cwd: process.cwd() }, mockConn("three"), "third", undefined, "conversation-3");

      expect(stopped).toEqual([oldest]);
      expect(registry.get(oldest)).toBeUndefined();
      expect(registry.get(newest)).toBeDefined();
      expect(registry.get(third)).toBeDefined();
      vi.useRealTimers();
    });

    it("does not evict running conversations when all slots are busy", async () => {
      const registry = new SessionRegistry(
        () => engineBase(),
        new PermissionRegistry(),
        { maxThreads: 1 },
      );
      await registry.create({ cwd: process.cwd() }, mockConn("one"), "running", undefined, "conversation-1");

      await expect(registry.create(
        { cwd: process.cwd() },
        mockConn("two"),
        "next",
        undefined,
        "conversation-2",
      )).rejects.toThrow(/all threads are busy/);
    });
  });
});
