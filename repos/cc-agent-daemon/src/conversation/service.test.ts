import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionRegistry } from "../permission/registry.js";
import type { ClientConnection } from "../rpc/connection.js";
import type { EngineAdapter } from "../session/engine.js";
import { SessionRegistry } from "../session/registry.js";
import { MetaStore } from "../store/db.js";
import { ConversationService } from "./service.js";

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
    const starts = vi.fn<EngineAdapter["start"]>(async (_opts, _hooks, runtimeId) => ({ runtimeId }));
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
    await service.send(opened.conversation.id, "second", conn);

    expect(starts).toHaveBeenCalledTimes(1);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(registry.listActive()).toHaveLength(1);
    expect(registry.listActive()[0].conversationId).toBe(opened.conversation.id);
  });

  it("single-flights concurrent first sends and applies cold configuration on spawn", async () => {
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
    await Promise.all([first, second]);

    const options = starts.mock.calls[0][0];
    expect(options.model).toBe(configured.config.model.requestedId);
    expect(configured.config.model.family).toBe("haiku");
    expect(options.effort).toBe("low");
    expect(options.permissionMode).toBe("plan");
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(registry.listActive()).toHaveLength(1);
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
    await service.setEffort(opened.conversation.id, "xhigh");

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0][1]).toContain("opus");
    expect(setEffort).toHaveBeenCalledWith(expect.any(String), "xhigh");
    expect(registry.listActive()).toHaveLength(1);
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
