import { describe, expect, it } from "vitest";
import { PermissionRegistry } from "../permission/registry.js";
import type { ClientConnection } from "../rpc/connection.js";
import { SessionRegistry } from "./registry.js";
import type { EngineAdapter } from "./runner.js";

function mockConn(id = "conn1"): ClientConnection {
  return {
    id,
    authenticated: true,
    send: () => {},
    close: () => {},
  };
}

describe("SessionRegistry", () => {
  it("returns a runtime alias before SDK session_id and keeps both aliases", async () => {
    let onMessage: ((msg: unknown) => void) | undefined;
    const sent: Array<{ runtimeId: string; content: string }> = [];
    const engine: EngineAdapter = {
      start: async (_opts, hooks, runtimeId) => {
        onMessage = hooks.onMessage;
        return { runtimeId };
      },
      send: async (runtimeId, content) => {
        sent.push({ runtimeId, content });
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      stop: async () => {},
    };
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());
    const aliased: Array<{ sdkSessionId: string; runtimeId: string }> = [];

    const runtimeId = await registry.create(
      { cwd: process.cwd() },
      mockConn(),
      "hello",
      (sdkSessionId, runtimeId) => aliased.push({ sdkSessionId, runtimeId }),
    );

    expect(runtimeId).toMatch(/[0-9a-f-]{36}/);
    expect(sent).toEqual([{ runtimeId, content: "hello" }]);
    expect(registry.get(runtimeId)).toBeDefined();

    onMessage?.({ type: "system", subtype: "init", session_id: "sdk-session" });

    expect(registry.get("sdk-session")).toBe(registry.get(runtimeId));
    expect(aliased).toEqual([{ sdkSessionId: "sdk-session", runtimeId }]);
  });

  it("excludes completed sessions from listActive", async () => {
    let onMessage: ((msg: unknown) => void) | undefined;
    const engine: EngineAdapter = {
      start: async (_opts, hooks, runtimeId) => {
        onMessage = hooks.onMessage;
        return { runtimeId };
      },
      send: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
      stop: async () => {},
    };
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());

    const runtimeId = await registry.create({ cwd: process.cwd() }, mockConn());
    expect(registry.listActive().map((s) => s.sessionId)).toContain(runtimeId);

    onMessage?.({ type: "result", subtype: "success" });

    expect(registry.listActive().map((s) => s.sessionId)).not.toContain(runtimeId);
  });

  it("remove stops and unregisters sessions by runtime alias", async () => {
    const stopped: string[] = [];
    const engine: EngineAdapter = {
      start: async (_opts, _hooks, runtimeId) => ({ runtimeId }),
      send: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
      stop: async (runtimeId) => {
        stopped.push(runtimeId);
      },
    };
    const registry = new SessionRegistry(() => engine, new PermissionRegistry());

    const runtimeId = await registry.create({ cwd: process.cwd() }, mockConn());
    await registry.remove(runtimeId);

    expect(stopped).toEqual([runtimeId]);
    expect(registry.get(runtimeId)).toBeUndefined();
  });
});
