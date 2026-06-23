import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type RunningServer } from "./server.js";
import { MetaStore } from "./store/db.js";
import { PermissionRegistry } from "./permission/registry.js";
import { SessionRegistry } from "./session/registry.js";
import type { AppContext } from "./app/context.js";
import type { EngineAdapter } from "./session/runner.js";
import type { SessionCreateOptions } from "./session/types.js";
import { projectSessionsDir } from "./history/paths.js";

type EngineHooks = Parameters<EngineAdapter["start"]>[1];
type EngineStartRecord = { runtimeId: string; opts: SessionCreateOptions; hooks: EngineHooks };

function makeEngine(
  sent: Array<{ runtimeId: string; content: string }> = [],
  starts: EngineStartRecord[] = [],
  permissionModeChanges: Array<{ runtimeId: string; mode: string }> = [],
): EngineAdapter {
  return {
    start: async (opts, hooks, runtimeId) => {
      starts.push({ runtimeId, opts, hooks });
      return { runtimeId };
    },
    send: async (runtimeId, content) => {
      sent.push({ runtimeId, content });
    },
    interrupt: async () => {},
    setPermissionMode: async (runtimeId, mode) => {
      permissionModeChanges.push({ runtimeId, mode });
    },
    stop: async () => {},
  };
}

function makeContext(
  dataDir: string,
  token: string | null,
  sent: Array<{ runtimeId: string; content: string }> = [],
  starts: EngineStartRecord[] = [],
  permissionModeChanges: Array<{ runtimeId: string; mode: string }> = [],
): AppContext {
  const permissions = new PermissionRegistry(200);
  return {
    config: { host: "127.0.0.1", port: 0, dataDir, token, insecureNoAuth: token === null },
    token,
    store: new MetaStore(dataDir),
    permissions,
    sessions: new SessionRegistry(() => makeEngine(sent, starts, permissionModeChanges), permissions),
  };
}

function wsUrl(server: RunningServer, token?: string): string {
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `ws://127.0.0.1:${address.port}/ws${q}`;
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForNotification<T>(ws: WebSocket, method: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for notification ${method}`));
    }, 1000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as { method?: string };
      if (msg.method !== method) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg as T);
    };
    ws.on("message", onMessage);
  });
}

async function rpc<T>(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for rpc id ${id}`));
    }, 1000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as { id?: number };
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg as T);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

describe("startServer", () => {
  const originalClaudeHome = process.env.CLAUDE_HOME;
  const tempDirs: string[] = [];
  const servers: RunningServer[] = [];

  afterEach(async () => {
    if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = originalClaudeHome;
    for (const server of servers.splice(0)) await server.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeSettings(claudeHome: string): void {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "secret-token",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku",
        },
        model: "custom-default-model",
        effortLevel: "max",
        permissions: {
          allow: ["Read", "Bash"],
          deny: ["WebFetch"],
          defaultMode: "acceptEdits",
          additionalDirectories: ["/tmp/extra"],
        },
      }),
    );
  }

  function writeHistorySession(claudeHome: string, workspacePath: string, sessionId: string): void {
    const dir = projectSessionsDir(workspacePath, claudeHome);
    mkdirSync(dir, { recursive: true });
    const entries = [
      {
        uuid: "u1",
        parentUuid: null,
        type: "user",
        sessionId,
        cwd: workspacePath,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
      {
        uuid: "a1",
        parentUuid: "u1",
        type: "assistant",
        sessionId,
        cwd: workspacePath,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));
  }

  it("serves /health", async () => {
    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);

    const res = await server.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("closes websocket connections with invalid token", async () => {
    const ctx = makeContext(tempDir("ccd-server-"), "secret");
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);

    const ws = new WebSocket(wsUrl(server, "wrong"));
    const closed = await waitForClose(ws);
    expect(closed).toMatchObject({ code: 4401, reason: "unauthorized" });
  });

  it("handles auth and ping over websocket JSON-RPC", async () => {
    const ctx = makeContext(tempDir("ccd-server-"), "secret");
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server, "secret"));

    expect(await rpc(ws, 1, "auth", { token: "secret" })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(await rpc(ws, 2, "ping")).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    ws.close();
  });

  it("does not send responses for websocket notifications", async () => {
    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));
    const messages: unknown[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toEqual([]);
    ws.close();
  });

  it("returns parse errors over websocket", async () => {
    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    const next = waitForMessage(ws);
    ws.send("{");

    expect(await next).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    ws.close();
  });

  it("reads Claude settings over websocket without exposing env secrets", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    process.env.CLAUDE_HOME = claudeHome;
    writeSettings(claudeHome);
    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    const res = await rpc<{
      result: {
        settings: {
          models: { default?: string; opus?: string; sonnet?: string; haiku?: string };
          permissions: { allow: string[]; deny: string[]; defaultMode?: string; additionalDirectories: string[] };
          effortLevel?: string;
        };
      };
    }>(ws, 1, "settings.get");

    expect(res.result.settings).toEqual({
      models: {
        default: "custom-default-model",
        opus: "custom-opus",
        sonnet: "custom-sonnet",
        haiku: "custom-haiku",
        advisor: undefined,
      },
      permissions: {
        allow: ["Read", "Bash"],
        deny: ["WebFetch"],
        defaultMode: "acceptEdits",
        additionalDirectories: ["/tmp/extra"],
      },
      effortLevel: "max",
    });
    expect(JSON.stringify(res)).not.toContain("secret-token");
    ws.close();
  });

  it("runs workspace.add and session.create over websocket", async () => {
    const sent: Array<{ runtimeId: string; content: string }> = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, sent);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    const addRes = await rpc<{ result: { workspace: { path: string } } }>(ws, 1, "workspace.add", { path: workspace });
    expect(addRes.result.workspace.path).toBe(realpathSync(workspace));

    const createRes = await rpc<{ result: { sessionId: string } }>(ws, 2, "session.create", {
      cwd: workspace,
      initialMessage: "hello",
    });

    expect(createRes.result.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(sent).toEqual([{ runtimeId: createRes.result.sessionId, content: "hello" }]);
    ws.close();
  });

  it("passes allowed and disallowed tools through websocket session create", async () => {
    const starts: EngineStartRecord[] = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, [], starts);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });
    await rpc(ws, 2, "session.create", {
      cwd: workspace,
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["WebFetch"],
    });

    expect(starts[0].opts).toMatchObject({
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["WebFetch"],
    });
    ws.close();
  });

  it("forwards SDK slash command metadata and sends slash input unchanged", async () => {
    const sent: Array<{ runtimeId: string; content: string }> = [];
    const starts: EngineStartRecord[] = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, sent, starts);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });
    const createRes = await rpc<{ result: { sessionId: string } }>(ws, 2, "session.create", {
      cwd: workspace,
      settingSources: ["user", "project"],
    });

    const initEvent = waitForNotification<{
      method: "session/event";
      params: { sessionId: string; message: { slash_commands?: Array<{ name: string; description?: string }> } };
    }>(ws, "session/event");
    starts[0].hooks.onMessage({
      type: "system",
      subtype: "init",
      session_id: "sdk-session",
      slash_commands: [
        { name: "compact", description: "Compact conversation" },
        { name: "project-skill", description: "Project skill" },
      ],
    });

    expect(await initEvent).toMatchObject({
      jsonrpc: "2.0",
      method: "session/event",
      params: {
        sessionId: "sdk-session",
        message: {
          slash_commands: [
            { name: "compact", description: "Compact conversation" },
            { name: "project-skill", description: "Project skill" },
          ],
        },
      },
    });
    expect(starts[0].opts.settingSources).toEqual(["user", "project"]);

    expect(
      await rpc(ws, 3, "session.sendMessage", {
        sessionId: "sdk-session",
        content: "/project-skill refactor this file",
      }),
    ).toEqual({ jsonrpc: "2.0", id: 3, result: { accepted: true } });
    expect(sent).toContainEqual({ runtimeId: createRes.result.sessionId, content: "/project-skill refactor this file" });
    ws.close();
  });

  it("round-trips SDK permission requests through websocket permission.respond", async () => {
    const starts: EngineStartRecord[] = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, [], starts);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });
    const createRes = await rpc<{ result: { sessionId: string } }>(ws, 2, "session.create", { cwd: workspace });
    const permissionRequest = waitForNotification<{
      method: "permission/request";
      params: { sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> };
    }>(ws, "permission/request");

    const decision = starts[0].hooks.canUseTool("Bash", { command: "pwd" });
    const request = await permissionRequest;

    expect(request.params).toMatchObject({
      sessionId: createRes.result.sessionId,
      toolName: "Bash",
      input: { command: "pwd" },
    });

    const wrongConn = await openWs(wsUrl(server));
    const wrongRes = await rpc<{ error: { message: string } }>(wrongConn, 1, "permission.respond", {
      sessionId: request.params.sessionId,
      requestId: request.params.requestId,
      behavior: "allow",
    });
    expect(wrongRes.error.message).toBe("unknown permission request");
    wrongConn.close();

    expect(
      await rpc(ws, 3, "permission.respond", {
        sessionId: request.params.sessionId,
        requestId: request.params.requestId,
        behavior: "allow",
        updatedInput: { command: "ls" },
      }),
    ).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    ws.close();
  });

  it("returns denied permission responses with messages over websocket", async () => {
    const starts: EngineStartRecord[] = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, [], starts);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });
    const createRes = await rpc<{ result: { sessionId: string } }>(ws, 2, "session.create", { cwd: workspace });
    const permissionRequest = waitForNotification<{
      method: "permission/request";
      params: { sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> };
    }>(ws, "permission/request");

    const decision = starts[0].hooks.canUseTool("Bash", { command: "rm -rf /tmp/example" });
    const request = await permissionRequest;

    expect(request.params).toMatchObject({
      sessionId: createRes.result.sessionId,
      toolName: "Bash",
      input: { command: "rm -rf /tmp/example" },
    });
    await expect(
      rpc(ws, 3, "permission.respond", {
        sessionId: request.params.sessionId,
        requestId: request.params.requestId,
        behavior: "deny",
        message: "Use a safer read-only command",
      }),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "Use a safer read-only command" });
    ws.close();
  });

  it("passes model and effort through websocket session create and resume", async () => {
    const starts: EngineStartRecord[] = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, [], starts);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });

    const cases: Array<{ model: string; effort: NonNullable<SessionCreateOptions["effort"]> }> = [
      { model: "claude-opus-4-7", effort: "low" },
      { model: "claude-sonnet-4-6", effort: "medium" },
      { model: "claude-haiku-4-5-20251001", effort: "high" },
      { model: "my-custom-model", effort: "max" },
    ];
    for (const [index, params] of cases.entries()) {
      const res = await rpc<{ result: { sessionId: string } }>(ws, 2 + index, "session.create", {
        cwd: workspace,
        model: params.model,
        effort: params.effort,
      });
      expect(res.result.sessionId).toBe(starts[index].runtimeId);
    }

    expect(starts.map((s) => ({ model: s.opts.model, effort: s.opts.effort }))).toEqual(cases);

    await rpc(ws, 10, "session.resume", {
      sessionId: "disk-session-id",
      cwd: workspace,
      model: "custom-resume-model",
      effort: "xhigh",
    });
    expect(starts[starts.length - 1].opts).toMatchObject({
      resumeSessionId: "disk-session-id",
      model: "custom-resume-model",
      effort: "xhigh",
    });

    await rpc(ws, 11, "session.fork", {
      sessionId: "disk-session-id",
      cwd: workspace,
      model: "custom-fork-model",
      effort: "low",
      permissionMode: "dontAsk",
    });
    expect(starts[starts.length - 1].opts).toMatchObject({
      forkSessionId: "disk-session-id",
      model: "custom-fork-model",
      effort: "low",
      permissionMode: "dontAsk",
    });
    ws.close();
  });

  it("passes permission modes through websocket create, resume and runtime switch", async () => {
    const starts: EngineStartRecord[] = [];
    const permissionModeChanges: Array<{ runtimeId: string; mode: string }> = [];
    const ctx = makeContext(tempDir("ccd-server-"), null, [], starts, permissionModeChanges);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const workspace = tempDir("ccd-workspace-");
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });

    const modes: Array<NonNullable<SessionCreateOptions["permissionMode"]>> = [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ];
    const created: string[] = [];
    for (const [index, permissionMode] of modes.entries()) {
      const res = await rpc<{ result: { sessionId: string } }>(ws, 2 + index, "session.create", {
        cwd: workspace,
        permissionMode,
      });
      created.push(res.result.sessionId);
    }

    expect(starts.slice(0, modes.length).map((s) => s.opts.permissionMode)).toEqual(modes);

    await rpc(ws, 20, "session.resume", {
      sessionId: "disk-session-id",
      cwd: workspace,
      permissionMode: "auto",
    });
    expect(starts[starts.length - 1].opts).toMatchObject({
      resumeSessionId: "disk-session-id",
      permissionMode: "auto",
    });

    await expect(
      rpc(ws, 21, "session.setPermissionMode", {
        sessionId: created[0],
        mode: "plan",
      }),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 21, result: { ok: true } });
    expect(permissionModeChanges).toContainEqual({ runtimeId: created[0], mode: "plan" });
    ws.close();
  });

  it("returns all allowlisted local history sessions over websocket", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    process.env.CLAUDE_HOME = claudeHome;
    const root = tempDir("ccd-history-root-");
    const workspaceA = join(root, "alpha-project");
    const workspaceB = join(root, "beta-project");
    mkdirSync(workspaceA, { recursive: true });
    mkdirSync(workspaceB, { recursive: true });
    const workspacePathA = realpathSync(workspaceA);
    const workspacePathB = realpathSync(workspaceB);
    writeHistorySession(claudeHome, workspacePathA, "alpha-1");
    writeHistorySession(claudeHome, workspacePathA, "alpha-2");
    writeHistorySession(claudeHome, workspacePathB, "beta-1");
    writeHistorySession(claudeHome, workspacePathB, "agent-hidden");

    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: root });

    const allLocal = await rpc<{
      result: { projects: Array<{ workspacePath: string; sessions: Array<{ sessionId: string; messageCount: number }> }> };
    }>(ws, 2, "history.listAllLocal");
    const byPath = new Map(allLocal.result.projects.map((p) => [p.workspacePath, p.sessions.map((s) => s.sessionId).sort()]));

    expect(byPath).toEqual(
      new Map([
        [workspacePathA, ["alpha-1", "alpha-2"]],
        [workspacePathB, ["beta-1"]],
      ]),
    );
    expect(allLocal.result.projects.flatMap((p) => p.sessions).every((s) => s.messageCount === 2)).toBe(true);
    ws.close();
  });

  it("returns local history sessions even without an allowlist entry", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    process.env.CLAUDE_HOME = claudeHome;
    const workspace = tempDir("ccd-workspace-");
    const workspacePath = realpathSync(workspace);
    writeHistorySession(claudeHome, workspacePath, "untrusted-1");
    writeHistorySession(claudeHome, workspacePath, "agent-hidden");

    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    const allLocal = await rpc<{
      result: { projects: Array<{ workspacePath: string; sessions: Array<{ sessionId: string }> }> };
    }>(ws, 1, "history.listAllLocal");
    const project = allLocal.result.projects.find((p) => p.workspacePath === workspacePath);
    expect(project?.sessions.map((s) => s.sessionId)).toEqual(["untrusted-1"]);
    ws.close();
  });

  it("workspace.checkTrust reflects allowlist before and after workspace.add", async () => {
    const workspace = tempDir("ccd-workspace-");
    const workspacePath = realpathSync(workspace);
    const parentPath = join(workspacePath, "..");

    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    const before = await rpc<{ result: { trusted: boolean; path: string; parent: string } }>(
      ws,
      1,
      "workspace.checkTrust",
      { path: workspace },
    );
    expect(before.result.trusted).toBe(false);
    expect(before.result.path).toBe(workspacePath);
    expect(realpathSync(before.result.parent)).toBe(realpathSync(parentPath));

    await rpc(ws, 2, "workspace.add", { path: workspace });

    const after = await rpc<{ result: { trusted: boolean; path: string } }>(
      ws,
      3,
      "workspace.checkTrust",
      { path: workspace },
    );
    expect(after.result.trusted).toBe(true);
    expect(after.result.path).toBe(workspacePath);
    ws.close();
  });

  it("reads history sessions and messages over websocket after workspace.add", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    process.env.CLAUDE_HOME = claudeHome;
    const workspace = tempDir("ccd-workspace-");
    const workspacePath = realpathSync(workspace);
    writeHistorySession(claudeHome, workspacePath, "hist-1");

    const ctx = makeContext(tempDir("ccd-server-"), null);
    const server = await startServer(ctx, { ...ctx.config, port: 0 });
    servers.push(server);
    const ws = await openWs(wsUrl(server));

    await rpc(ws, 1, "workspace.add", { path: workspace });

    const allLocal = await rpc<{ result: { projects: Array<{ workspacePath: string; sessions: Array<{ sessionId: string }> }> } }>(
      ws,
      2,
      "history.listAllLocal",
    );
    const project = allLocal.result.projects.find((p) => p.workspacePath === workspacePath);
    expect(project?.sessions.map((s) => s.sessionId)).toEqual(["hist-1"]);

    const listRes = await rpc<{ result: { sessions: Array<{ sessionId: string; messageCount: number; lastTimestamp?: string }> } }>(
      ws,
      3,
      "history.listSessions",
      { workspacePath },
    );
    expect(listRes.result.sessions).toEqual([
      expect.objectContaining({ sessionId: "hist-1", messageCount: 2, lastTimestamp: "2026-01-01T00:00:01.000Z" }),
    ]);

    const loadRes = await rpc<{ result: { messages: Array<{ uuid?: string; type?: string }> } }>(ws, 4, "history.loadSession", {
      workspacePath,
      sessionId: "hist-1",
    });
    expect(loadRes.result.messages.map((m) => m.uuid)).toEqual(["u1", "a1"]);
    ws.close();
  });
});
