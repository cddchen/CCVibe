import { describe, expect, it, vi, beforeEach } from "vitest";
import { PermissionRegistry } from "../permission/registry.js";
import type { ClientConnection } from "../rpc/connection.js";
import { createClaudeEngine } from "./claudeEngine.js";
import { SessionRegistry } from "./registry.js";

const { queryMock, controllers } = vi.hoisted(() => {
  type Controller = {
    call: {
      prompt: AsyncIterable<unknown>;
      options: {
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          context: Record<string, unknown>,
        ) => Promise<unknown>;
        [key: string]: unknown;
      };
    };
    q: AsyncIterable<unknown> & {
      interrupt: ReturnType<typeof vi.fn>;
      reinitialize: ReturnType<typeof vi.fn>;
      setPermissionMode: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    push: (msg: unknown) => void;
    finish: () => void;
  };

  const controllers: Controller[] = [];
  const queryMock = vi.fn((call: Controller["call"]) => {
    const messages: unknown[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const q: Controller["q"] = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      reinitialize: vi.fn(async () => ({})),
      setPermissionMode: vi.fn(async () => {}),
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        while (!done || messages.length > 0) {
          if (messages.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          while (messages.length > 0) yield messages.shift();
        }
      },
    };
    controllers.push({
      call,
      q,
      push: (msg) => {
        messages.push(msg);
        notify();
      },
      finish: () => {
        done = true;
        notify();
      },
    });
    return q;
  });
  return { queryMock, controllers };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

function mockConn(id = "conn1"): ClientConnection & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    id,
    authenticated: true,
    send: (payload) => sent.push(payload),
    close: () => {},
    sent,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition timed out");
}

async function nextInput(iterator: AsyncIterator<unknown>): Promise<unknown> {
  return Promise.race([
    iterator.next().then((r) => r.value),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("input timed out")), 1000)),
  ]);
}

function notifications(conn: { sent: unknown[] }, method: string): Array<{ method?: string; params?: unknown }> {
  return conn.sent.filter((msg): msg is { method?: string; params?: unknown } => (msg as { method?: string }).method === method);
}

function conversationEvents(conn: { sent: unknown[] }, type: string): Array<{
  method?: string;
  params: { sessionId: string; event: Record<string, unknown> };
}> {
  return notifications(conn, "conversation/event").filter((item) => {
    const params = item.params as { event?: { type?: string } } | undefined;
    return params?.event?.type === type;
  }) as Array<{ method?: string; params: { sessionId: string; event: Record<string, unknown> } }>;
}

function sdkPermissionContext(requestId: string): Record<string, unknown> {
  return {
    signal: new AbortController().signal,
    requestId,
    toolUseID: `tool-${requestId}`,
  };
}

describe("Claude SDK daemon data flow", () => {
  beforeEach(() => {
    queryMock.mockClear();
    controllers.splice(0);
  });

  it("manages session lifecycle through Agent SDK query streams", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn();
    const aliases: Array<{ sdkSessionId: string; runtimeId: string }> = [];

    const runtimeId = await registry.create(
      {
        cwd: "/tmp/project",
        model: "custom-model",
        effort: "xhigh",
        permissionMode: "acceptEdits",
        settingSources: ["user", "project"],
      },
      conn,
      "hello",
      (sdkSessionId, runtimeId) => aliases.push({ sdkSessionId, runtimeId }),
    );

    expect(queryMock).toHaveBeenCalledOnce();
    const controller = controllers[0];
    expect(controller.call.options).toMatchObject({
      cwd: "/tmp/project",
      model: "custom-model",
      effort: "xhigh",
      permissionMode: "acceptEdits",
      settingSources: ["user", "project"],
      includePartialMessages: true,
    });

    const input = controller.call.prompt[Symbol.asyncIterator]();
    await expect(nextInput(input)).resolves.toMatchObject({
      type: "user",
      message: { role: "user", content: "hello" },
    });

    controller.push({ type: "system", subtype: "init", session_id: "sdk-session", model: "custom-model", cwd: "/tmp/project" });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    expect(registry.get(runtimeId)).toBe(registry.get("sdk-session"));
    expect(aliases).toEqual([{ sdkSessionId: "sdk-session", runtimeId }]);
    expect(conversationEvents(conn, "conversation_status")).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "sdk-session", event: expect.objectContaining({ status: "running" }) }) }),
    );
    expect(notifications(conn, "conversation/event")).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "sdk-session" }) }),
    );

    controller.push({ type: "result", subtype: "success", is_error: false });
    await waitFor(() => registry.get("sdk-session")?.getTurnStatus() === undefined);
    await registry.get("sdk-session")!.send("next");
    await expect(nextInput(input)).resolves.toMatchObject({
      type: "user",
      message: { role: "user", content: "next" },
    });

    await registry.get("sdk-session")!.setPermissionMode("plan");
    expect(controller.q.setPermissionMode).toHaveBeenCalledWith("plan");

    await registry.get("sdk-session")!.interrupt();
    expect(controller.q.interrupt).toHaveBeenCalledOnce();
    expect(conversationEvents(conn, "turn_status")).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "sdk-session", event: expect.objectContaining({ status: "interrupted" }) }) }),
    );

    controller.push({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    await waitFor(() => conversationEvents(conn, "message_update").length >= 1 || conversationEvents(conn, "message_start").length >= 1);
    controller.push({ type: "result", subtype: "success" });
    await waitFor(() => registry.listActive().some((s) => s.sessionId === "sdk-session" && s.status === "idle"));
    expect(conversationEvents(conn, "conversation_status")).toContainEqual(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "sdk-session", event: expect.objectContaining({ status: "idle" }) }) }),
    );
    controller.finish();
    await waitFor(() => registry.listActive().every((s) => s.sessionId !== "sdk-session"));
  });

  it("passes slash command input unchanged and forwards SDK slash command metadata", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn();

    await registry.create({ cwd: "/tmp/project", settingSources: ["user", "project"] }, conn);
    const controller = controllers[0];
    controller.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-session",
      slash_commands: [
        { name: "compact", description: "Compact conversation" },
        { name: "project-skill", description: "Project skill" },
      ],
    });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    expect(conversationEvents(conn, "runtime_initialized")).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          sessionId: "sdk-session",
          event: expect.objectContaining({
            slashCommands: [
              { name: "compact", description: "Compact conversation" },
              { name: "project-skill", description: "Project skill" },
            ],
          }),
        }),
      }),
    );

    const input = controller.call.prompt[Symbol.asyncIterator]();
    await registry.get("sdk-session")!.send("/project-skill refactor this file");
    await expect(nextInput(input)).resolves.toMatchObject({
      type: "user",
      message: { role: "user", content: "/project-skill refactor this file" },
    });
    controller.finish();
  });

  it("round-trips permission decisions from SDK canUseTool through PermissionRegistry", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn("owner");

    await registry.create({ cwd: "/tmp/project" }, conn);
    const controller = controllers[0];
    controller.push({ type: "system", subtype: "init", session_id: "sdk-session" });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    const decision = controller.call.options.canUseTool(
      "Read",
      { file_path: "/tmp/a" },
      sdkPermissionContext("sdk-read-request"),
    );
    await waitFor(() => conversationEvents(conn, "permission_request").length === 1);
    const request = conversationEvents(conn, "permission_request")[0] as {
      params: { sessionId: string; event: { requestId: string; toolName: string; input: Record<string, unknown> } };
    };

    expect({ sessionId: request.params.sessionId, ...request.params.event }).toMatchObject({
      sessionId: "sdk-session",
      requestId: "sdk-read-request",
      toolName: "Read",
      input: { file_path: "/tmp/a" },
    });
    const permissionScope = registry.get("sdk-session")!.runtimeId;
    expect(
      permissions.respond(permissionScope, request.params.event.requestId, {
        behavior: "allow",
        updatedInput: { file_path: "/tmp/b" },
      }),
    ).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/b" } });
    expect(permissions.size()).toBe(0);
    controller.finish();
  });

  it("returns denied permission decisions with messages to the Agent SDK", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn("owner");

    await registry.create({ cwd: "/tmp/project" }, conn);
    const controller = controllers[0];
    controller.push({ type: "system", subtype: "init", session_id: "sdk-session" });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    const decision = controller.call.options.canUseTool(
      "Bash",
      { command: "rm -rf /tmp/example" },
      sdkPermissionContext("sdk-bash-request"),
    );
    await waitFor(() => conversationEvents(conn, "permission_request").length === 1);
    const request = conversationEvents(conn, "permission_request")[0] as {
      params: { sessionId: string; event: { requestId: string; toolName: string; input: Record<string, unknown> } };
    };

    expect({ sessionId: request.params.sessionId, ...request.params.event }).toMatchObject({
      sessionId: "sdk-session",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/example" },
    });
    expect(
      permissions.respond(registry.get("sdk-session")!.runtimeId, request.params.event.requestId, {
        behavior: "deny",
        message: "Use a safer read-only command",
      }),
    ).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "Use a safer read-only command" });
    expect(permissions.size()).toBe(0);
    controller.finish();
  });

  it("allows ExitPlanMode confirmations once and clears the request", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn("owner");

    await registry.create({ cwd: "/tmp/project", permissionMode: "plan" }, conn);
    const controller = controllers[0];
    controller.push({ type: "system", subtype: "init", session_id: "sdk-session" });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    const decision = controller.call.options.canUseTool(
      "ExitPlanMode",
      { plan: "Implement the approved changes" },
      sdkPermissionContext("sdk-plan-request"),
    );
    await waitFor(() => conversationEvents(conn, "permission_request").length === 1);
    const request = conversationEvents(conn, "permission_request")[0] as {
      params: { sessionId: string; event: { requestId: string; toolName: string; input: Record<string, unknown> } };
    };

    expect({ sessionId: request.params.sessionId, ...request.params.event }).toMatchObject({
      sessionId: "sdk-session",
      toolName: "ExitPlanMode",
      input: { plan: "Implement the approved changes" },
    });
    const permissionScope = registry.get("sdk-session")!.runtimeId;
    expect(permissions.respond(permissionScope, request.params.event.requestId, { behavior: "allow" })).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: undefined });
    expect(permissions.size()).toBe(0);
    expect(permissions.respond(permissionScope, request.params.event.requestId, { behavior: "allow" })).toBe(false);
    controller.finish();
  });

  it("round-trips AskUserQuestion answers through updatedInput", async () => {
    const permissions = new PermissionRegistry(1000);
    const registry = new SessionRegistry(() => createClaudeEngine(), permissions);
    const conn = mockConn("owner");

    await registry.create({ cwd: "/tmp/project" }, conn);
    const controller = controllers[0];
    controller.push({ type: "system", subtype: "init", session_id: "sdk-session" });
    await waitFor(() => registry.get("sdk-session") !== undefined);

    const input = {
      questions: [
        {
          question: "Which approach should I use?",
          header: "Approach",
          options: [
            { label: "Safe", description: "Use the safe path" },
            { label: "Fast", description: "Use the fast path" },
          ],
          multiSelect: false,
        },
      ],
    };
    const decision = controller.call.options.canUseTool(
      "AskUserQuestion",
      input,
      sdkPermissionContext("sdk-question-request"),
    );
    await waitFor(() => conversationEvents(conn, "permission_request").length === 1);
    const request = conversationEvents(conn, "permission_request")[0] as {
      params: { sessionId: string; event: { requestId: string; toolName: string; input: Record<string, unknown> } };
    };

    expect({ sessionId: request.params.sessionId, ...request.params.event }).toMatchObject({
      sessionId: "sdk-session",
      toolName: "AskUserQuestion",
      input,
    });
    expect(
      permissions.respond(registry.get("sdk-session")!.runtimeId, request.params.event.requestId, {
        behavior: "allow",
        updatedInput: { ...input, answers: { "Which approach should I use?": "Safe" } },
      }),
    ).toBe(true);
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which approach should I use?": "Safe" } },
    });
    expect(permissions.size()).toBe(0);
    controller.finish();
  });
});
