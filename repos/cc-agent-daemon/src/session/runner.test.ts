import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRunner } from "./runner.js";
import type { EngineAdapter, EnginePermissionContext } from "./engine.js";
import type { ClientConnection } from "../rpc/connection.js";
import { PermissionRegistry } from "../permission/registry.js";

function permissionContext(requestId = "sdk-request-1"): EnginePermissionContext {
  return {
    signal: new AbortController().signal,
    requestId,
    toolUseId: "tool-use-1",
    suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    title: "Claude wants to run a command",
  };
}

function mockEngine(): EngineAdapter {
  return {
    start: vi.fn(async (_opts, hooks, runtimeId) => {
      setTimeout(() => {
        hooks.onMessage({ type: "system", subtype: "init", session_id: "sess-1" } as never);
      }, 0);
      return { runtimeId };
    }),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ still_queued: [] })),
    reinitialize: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

let connSeq = 0;
function mockConn(): ClientConnection & { _sent: unknown[] } {
  const sent: unknown[] = [];
  const id = `c${++connSeq}`;
  return {
    id,
    authenticated: true,
    send: (payload) => sent.push(payload),
    close: () => {},
    _sent: sent,
  };
}

describe("SessionRunner", () => {
  it("broadcasts SDK events with session and runtime IDs", () => {
    const runner = new SessionRunner("r1", "/tmp", mockEngine());
    runner.bindSessionId("sess-1");
    const first = mockConn();
    const second = mockConn();
    runner.subscribe(first);
    runner.subscribe(second);
    runner.pushEvent({ type: "assistant" });
    expect(first._sent).toHaveLength(1);
    expect(second._sent).toHaveLength(1);
    expect(first._sent[0]).toMatchObject({
      method: "session/event",
      params: { sessionId: "sess-1", runtimeId: "r1", message: { type: "assistant" } },
    });
  });

  it("unsubscribe stops delivery", () => {
    const runner = new SessionRunner("r1", "/tmp", mockEngine());
    runner.bindSessionId("sess-1");
    const conn = mockConn();
    runner.subscribe(conn);
    runner.unsubscribe(conn.id);
    runner.pushEvent({ type: "x" });
    expect(conn._sent).toHaveLength(0);
  });

  it("notifies separate session, runtime, and turn lifecycles", async () => {
    let onMessage: ((message: never) => void) | undefined;
    const engine = mockEngine();
    engine.start = vi.fn(async (_opts, hooks, runtimeId) => {
      onMessage = hooks.onMessage;
      return { runtimeId };
    });
    const runner = new SessionRunner("r1", "/tmp", engine);
    const conn = mockConn();
    runner.subscribe(conn);
    await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
    onMessage?.({ type: "system", subtype: "init", session_id: "sess-1" } as never);

    const { turnId } = await runner.send("hello");
    expect(runner.getStatus()).toBe("running");
    expect(runner.getRuntimeStatus()).toBe("running");
    expect(runner.getTurnStatus()).toEqual({ id: turnId, status: "running" });

    onMessage?.({ type: "result", subtype: "success", is_error: false } as never);
    expect(runner.getStatus()).toBe("idle");
    expect(runner.getRuntimeStatus()).toBe("running");
    expect(runner.getTurnStatus()).toBeUndefined();
    expect(conn._sent).toContainEqual(
      expect.objectContaining({
        method: "turn/status",
        params: expect.objectContaining({ turnId, status: "completed" }),
      }),
    );
  });

  it("keeps the session alive after interrupt and returns the SDK receipt", async () => {
    const engine = mockEngine();
    engine.interrupt = vi.fn(async () => ({ still_queued: [] }));
    const runner = new SessionRunner("r1", "/tmp", engine);
    await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
    const { turnId } = await runner.send("hello");

    await expect(runner.interrupt()).resolves.toEqual({ still_queued: [] });
    expect(runner.getRuntimeStatus()).toBe("running");
    expect(runner.getStatus()).toBe("running");
    expect(runner.getTurnStatus()).toEqual({ id: turnId, status: "interrupted" });
  });

  it("uses SDK request IDs and replays pending permissions to the latest owner", async () => {
    let canUseTool: Parameters<EngineAdapter["start"]>[1]["canUseTool"] | undefined;
    const engine = mockEngine();
    engine.start = vi.fn(async (_opts, hooks, runtimeId) => {
      canUseTool = hooks.canUseTool;
      return { runtimeId };
    });
    const permissions = new PermissionRegistry(1000);
    const runner = new SessionRunner("r1", "/tmp", engine);
    const oldOwner = mockConn();
    const newOwner = mockConn();
    runner.subscribe(oldOwner, true);
    await runner.startWithEngine({ cwd: "/tmp" }, permissions);
    runner.bindSessionId("sess-1");

    const firstDecision = canUseTool!("Bash", { command: "pwd" }, permissionContext("sdk-request"));
    expect(oldOwner._sent).toContainEqual(
      expect.objectContaining({
        method: "permission/request",
        params: expect.objectContaining({
          requestId: "sdk-request",
          toolUseId: "tool-use-1",
          title: "Claude wants to run a command",
        }),
      }),
    );

    runner.unsubscribe(oldOwner.id);
    runner.subscribe(newOwner, true);
    expect(engine.reinitialize).toHaveBeenCalled();
    expect(newOwner._sent).toContainEqual(
      expect.objectContaining({
        method: "permission/request",
        params: expect.objectContaining({ requestId: "sdk-request" }),
      }),
    );
    expect(permissions.size()).toBe(1);
    expect(permissions.respond("r1", "sdk-request", newOwner.id, { behavior: "allow" })).toBe(true);
    await expect(firstDecision).resolves.toEqual({ behavior: "allow" });
  });

  describe("idle reclaim", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("reclaims an idle session after a completed turn while still subscribed", async () => {
      const reclaim = vi.fn();
      let onMessage: ((message: never) => void) | undefined;
      const engine = mockEngine();
      engine.start = vi.fn(async (_opts, hooks, runtimeId) => {
        onMessage = hooks.onMessage;
        return { runtimeId };
      });
      const runner = new SessionRunner("r1", "/tmp", engine);
      runner.setReclaimHandler(reclaim, 1000);
      const conn = mockConn();
      runner.subscribe(conn);
      await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
      await runner.send("done");
      onMessage?.({ type: "result", subtype: "success" } as never);
      vi.advanceTimersByTime(1000);
      expect(reclaim).toHaveBeenCalledOnce();
    });

    it("does not reclaim while a turn is running", async () => {
      const reclaim = vi.fn();
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.setReclaimHandler(reclaim, 1000);
      await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
      await runner.send("work");
      const conn = mockConn();
      runner.subscribe(conn);
      runner.unsubscribe(conn.id);
      vi.advanceTimersByTime(1000);
      expect(reclaim).not.toHaveBeenCalled();
    });

    it("cancels the pending reclaim timer when a new turn starts", async () => {
      const reclaim = vi.fn();
      let onMessage: ((message: never) => void) | undefined;
      const engine = mockEngine();
      engine.start = vi.fn(async (_opts, hooks, runtimeId) => {
        onMessage = hooks.onMessage;
        return { runtimeId };
      });
      const runner = new SessionRunner("r1", "/tmp", engine);
      runner.setReclaimHandler(reclaim, 1000);
      await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
      await runner.send("first");
      onMessage?.({ type: "result", subtype: "success" } as never);
      await runner.send("second");
      vi.advanceTimersByTime(1000);
      expect(reclaim).not.toHaveBeenCalled();
    });
  });

  describe("turn buffer replay", () => {
    it("replays buffered events to a new subscriber", () => {
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.bindSessionId("sess-1");
      runner.pushEvent({ type: "stream_event", n: 1 });
      runner.pushEvent({ type: "stream_event", n: 2 });
      const late = mockConn();
      runner.subscribe(late);
      expect(late._sent).toHaveLength(2);
      expect(late._sent[0]).toMatchObject({
        method: "session/event",
        params: { sessionId: "sess-1", runtimeId: "r1", message: { type: "stream_event", n: 1 } },
      });
    });

    it("does not replay after a result clears the turn buffer", () => {
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.bindSessionId("sess-1");
      runner.pushEvent({ type: "assistant" });
      runner.pushEvent({ type: "result", subtype: "success" });
      const late = mockConn();
      runner.subscribe(late);
      expect(late._sent).toHaveLength(0);
    });

    it("clears the previous buffer when a new turn is sent", async () => {
      const engine = mockEngine();
      const runner = new SessionRunner("r1", "/tmp", engine);
      await runner.startWithEngine({ cwd: "/tmp" }, new PermissionRegistry());
      runner.bindSessionId("sess-1");
      runner.pushEvent({ type: "stream_event", old: true });
      await runner.send("next question");
      const late = mockConn();
      runner.subscribe(late);
      expect(late._sent.filter((event) => (event as { method?: string }).method === "session/event")).toHaveLength(0);
    });
  });
});
