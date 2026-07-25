import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionRegistry } from "../permission/registry.js";
import type { ClientConnection } from "../rpc/connection.js";
import type { EngineAdapter } from "../session/engine.js";
import { SessionRegistry } from "../session/registry.js";
import { MetaStore } from "../store/db.js";
import { ConversationService, overlayActiveTurn } from "./service.js";
import type { ConversationMessage } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function connection(): ClientConnection {
  return { id: "client-1", authenticated: true, send: vi.fn(), close: vi.fn() };
}

function engine(overrides: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    start: async (_opts, _hooks, runtimeId) => ({ runtimeId }),
    send: async () => {},
    interrupt: async () => ({ still_queued: [] }),
    reinitialize: async () => {},
    setModel: async () => {},
    setEffort: async () => {},
    setPermissionMode: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

describe("ConversationService", () => {
  it("opens a cold conversation without spawning and reuses one runtime for sends", async () => {
    let onMessage: Parameters<EngineAdapter["start"]>[1]["onMessage"] | undefined;
    const starts = vi.fn<EngineAdapter["start"]>(async (_opts, hooks, runtimeId) => {
      onMessage = hooks.onMessage;
      return { runtimeId };
    });
    const sends = vi.fn<EngineAdapter["send"]>(async () => {});
    const registry = new SessionRegistry(
      () => engine({ start: starts, send: sends }),
      new PermissionRegistry(),
    );
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const conn = connection();
    const workspacePath = tempDir("conversation-workspace");

    const opened = await service.open({ workspacePath }, conn);
    expect(opened.runtime.state).toBe("cold");
    expect(starts).not.toHaveBeenCalled();

    await service.send(opened.conversation.id, "first", conn);
    onMessage?.({ type: "result", subtype: "success", is_error: false } as never);
    await service.send(opened.conversation.id, "second", conn);

    expect(starts).toHaveBeenCalledTimes(1);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(registry.listActive()).toHaveLength(1);
    expect(registry.listActive()[0].conversationId).toBe(opened.conversation.id);
  });

  it("single-flights runtime creation and rejects a second concurrent active turn", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const starts = vi.fn<EngineAdapter["start"]>(async (_opts, _hooks, runtimeId) => {
      await startGate;
      return { runtimeId };
    });
    const setPermissionMode = vi.fn<EngineAdapter["setPermissionMode"]>(async () => {});
    const registry = new SessionRegistry(
      () => engine({ start: starts, setPermissionMode }),
      new PermissionRegistry(),
    );
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const conn = connection();
    const opened = await service.open({ workspacePath: tempDir("conversation-workspace") }, conn);

    await service.setModel(opened.conversation.id, "haiku");
    await service.setEffort(opened.conversation.id, "low");
    await service.setPermissionMode(opened.conversation.id, "plan");
    const configured = await service.get(opened.conversation.id);

    const first = service.send(opened.conversation.id, "one", conn);
    const second = service.send(opened.conversation.id, "two", conn);
    await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(1));
    releaseStart?.();
    const results = await Promise.allSettled([first, second]);

    const options = starts.mock.calls[0][0];
    expect(options.model).toBe(configured.config.model.requestedId);
    expect(configured.config.model.family).toBe("haiku");
    expect(options.effort).toBe("low");
    expect(options.permissionMode).toBe("plan");
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(registry.listActive()).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: "conversation already has an active turn" }),
    });
  });

  it("replaces any JSONL messages for the active turn with one live snapshot", () => {
    const history: ConversationMessage[] = [
      {
        type: "user_message",
        id: "jsonl-user",
        turnId: "active-turn",
        timestamp: "2026-07-24T00:00:00.000Z",
        content: "stale",
        status: "completed",
      },
      {
        type: "agent_message",
        id: "completed-agent",
        turnId: "completed-turn",
        timestamp: "2026-07-23T00:00:00.000Z",
        content: [{ type: "text", text: "completed" }],
        status: "completed",
      },
    ];
    const messages = overlayActiveTurn(history, {
      turnId: "active-turn",
      status: "running",
      messages: [{
        type: "user_message",
        id: "live-user",
        turnId: "active-turn",
        timestamp: "2026-07-24T00:00:00.000Z",
        content: "current",
        status: "completed",
      }],
    });

    expect(messages.map((message) => message.id)).toEqual(["completed-agent", "live-user"]);
  });

  it("returns the active turn snapshot when another client opens the conversation", async () => {
    const registry = new SessionRegistry(() => engine(), new PermissionRegistry());
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const firstClient = connection();
    const opened = await service.open({ workspacePath: tempDir("conversation-workspace") }, firstClient);
    const sent = await service.send(opened.conversation.id, "still streaming", firstClient);

    const secondClient = { ...connection(), id: "client-2" };
    const resumed = await service.open({
      conversationId: opened.conversation.id,
      workspacePath: opened.conversation.workspacePath,
      subscribe: true,
    }, secondClient);

    expect(resumed.currentTurn).toEqual({ turnId: sent.turnId, status: "running" });
    expect(resumed.messages).toContainEqual(expect.objectContaining({
      type: "user_message",
      turnId: sent.turnId,
      content: "still streaming",
    }));
    expect(registry.get(opened.conversation.id)?.subscriberCount()).toBe(2);
  });

  it("switches model and effort in-place after the runtime exists", async () => {
    const setModel = vi.fn<EngineAdapter["setModel"]>(async () => {});
    const setEffort = vi.fn<EngineAdapter["setEffort"]>(async () => {});
    const registry = new SessionRegistry(
      () => engine({ setModel, setEffort }),
      new PermissionRegistry(),
    );
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const conn = connection();
    const opened = await service.open({ workspacePath: tempDir("conversation-workspace") }, conn);
    await service.send(opened.conversation.id, "start", conn);

    await service.setModel(opened.conversation.id, "opus");
    await service.setModel(opened.conversation.id, "opus");
    await service.setEffort(opened.conversation.id, "xhigh");

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][1]).toContain("opus");
    expect(setEffort).toHaveBeenCalledWith(expect.any(String), "xhigh");
    expect(registry.listActive()).toHaveLength(1);
    const snapshot = await service.get(opened.conversation.id);
    expect(snapshot.messages.filter((message) => message.type === "model_changed")).toHaveLength(1);
  });

  it("serializes concurrent identical model changes into one effective change", async () => {
    const setModel = vi.fn<EngineAdapter["setModel"]>(async () => {});
    const registry = new SessionRegistry(
      () => engine({ setModel }),
      new PermissionRegistry(),
    );
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const conn = connection();
    const opened = await service.open({ workspacePath: tempDir("conversation-workspace") }, conn);
    await service.send(opened.conversation.id, "start", conn);

    await Promise.all([
      service.setModel(opened.conversation.id, "haiku"),
      service.setModel(opened.conversation.id, "haiku"),
    ]);

    expect(setModel).toHaveBeenCalledTimes(1);
    const snapshot = await service.get(opened.conversation.id);
    expect(snapshot.messages.filter((message) => message.type === "model_changed")).toHaveLength(1);
  });

  it("deduplicates retried sends by clientMessageId", async () => {
    const sends = vi.fn<EngineAdapter["send"]>(async () => {});
    const registry = new SessionRegistry(
      () => engine({ send: sends }),
      new PermissionRegistry(),
    );
    const service = new ConversationService(registry, new MetaStore(tempDir("conversation-store")));
    const conn = connection();
    const opened = await service.open({ workspacePath: tempDir("conversation-workspace") }, conn);

    const first = await service.send(opened.conversation.id, "hello", conn, "client-message-1");
    const retry = await service.send(opened.conversation.id, "hello", conn, "client-message-1");

    expect(retry.turnId).toBe(first.turnId);
    expect(sends).toHaveBeenCalledTimes(1);
    await expect(
      service.send(opened.conversation.id, "different", conn, "client-message-1"),
    ).rejects.toThrow("different content");
  });
});
