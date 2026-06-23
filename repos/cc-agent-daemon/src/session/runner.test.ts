import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SessionRunner, type EngineAdapter } from "./runner.js";
import type { ClientConnection } from "../rpc/connection.js";

function mockEngine(): EngineAdapter {
  return {
    start: vi.fn(async (_opts, hooks, _runtimeId) => {
      setTimeout(() => {
        hooks.onMessage({ type: "system", subtype: "init", session_id: "sess-1" });
      }, 0);
      return { runtimeId: "r1" };
    }),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
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
    send: (p) => sent.push(p),
    close: () => {},
    _sent: sent,
  };
}

describe("SessionRunner", () => {
  it("broadcasts to subscribers with session and runtime IDs", () => {
    const runner = new SessionRunner("r1", "/tmp", mockEngine());
    runner.bindSessionId("sess-1");
    const a = mockConn();
    const b = mockConn();
    runner.subscribe(a);
    runner.subscribe(b);
    runner.pushEvent({ type: "assistant" });
    expect(a._sent).toHaveLength(1);
    expect(b._sent).toHaveLength(1);
    expect(a._sent[0]).toMatchObject({
      method: "session/event",
      params: { sessionId: "sess-1", runtimeId: "r1", message: { type: "assistant" } },
    });
  });

  it("unsubscribe stops delivery", () => {
    const runner = new SessionRunner("r1", "/tmp", mockEngine());
    runner.bindSessionId("sess-1");
    const a = mockConn();
    runner.subscribe(a);
    runner.unsubscribe(a.id);
    runner.pushEvent({ type: "x" });
    expect(a._sent).toHaveLength(0);
  });

  it("setStatus notifies subscribers with session and runtime IDs", () => {
    const runner = new SessionRunner("r1", "/tmp", mockEngine());
    runner.bindSessionId("sess-1");
    const a = mockConn();
    runner.subscribe(a);
    runner.setStatus("running");
    expect(a._sent.some((x) => (x as { method?: string }).method === "session/status")).toBe(true);
    expect(a._sent[0]).toMatchObject({
      method: "session/status",
      params: { sessionId: "sess-1", runtimeId: "r1", status: "running" },
    });
  });

  describe("idle reclaim", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reclaims when unsubscribed and not running", () => {
      const reclaim = vi.fn();
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.setReclaimHandler(reclaim, 1000);
      runner.setStatus("completed");
      const a = mockConn();
      runner.subscribe(a);
      runner.unsubscribe(a.id);
      vi.advanceTimersByTime(1000);
      expect(reclaim).toHaveBeenCalledTimes(1);
    });

    it("does not reclaim while status is running", () => {
      const reclaim = vi.fn();
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.setReclaimHandler(reclaim, 1000);
      runner.setStatus("running");
      const a = mockConn();
      runner.subscribe(a);
      runner.unsubscribe(a.id);
      vi.advanceTimersByTime(1000);
      expect(reclaim).not.toHaveBeenCalled();
    });

    it("cancels reclaim when resubscribed", () => {
      const reclaim = vi.fn();
      const runner = new SessionRunner("r1", "/tmp", mockEngine());
      runner.setReclaimHandler(reclaim, 1000);
      runner.setStatus("completed");
      const a = mockConn();
      runner.subscribe(a);
      runner.unsubscribe(a.id);
      runner.subscribe(a);
      vi.advanceTimersByTime(1000);
      expect(reclaim).not.toHaveBeenCalled();
    });
  });
});