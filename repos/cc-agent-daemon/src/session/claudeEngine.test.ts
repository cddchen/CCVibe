import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeEngine } from "./claudeEngine.js";
import type { EngineHooks } from "./engine.js";
import type { PermissionMode } from "./types.js";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

function emptyQuery(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

function hooks(overrides: Partial<EngineHooks> = {}): EngineHooks {
  return {
    onMessage: () => {},
    onRuntimeClosed: () => {},
    canUseTool: async () => ({ behavior: "deny", message: "no" }),
    ...overrides,
  };
}

describe("createClaudeEngine", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("passes model and effort to Agent SDK query options", async () => {
    queryMock.mockReturnValue(emptyQuery());
    const engine = createClaudeEngine();

    await engine.start(
      {
        cwd: "/tmp/project",
        model: "custom-model-name",
        effort: "max",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["WebFetch"],
        settingSources: ["user", "project"],
      },
      hooks(),
      "runtime-1",
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          cwd: "/tmp/project",
          model: "custom-model-name",
          effort: "max",
          permissionMode: "acceptEdits",
          allowedTools: ["Read", "Grep"],
          disallowedTools: ["WebFetch"],
          settingSources: ["user", "project"],
          includePartialMessages: true,
        }),
      }),
    );
  });

  it("stop aborts the query controller and calls close on the subprocess", async () => {
    const close = vi.fn();
    queryMock.mockReturnValue({
      close,
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
    });
    const engine = createClaudeEngine();
    await engine.start(
      { cwd: "/tmp/project" },
      hooks(),
      "runtime-stop",
    );
    const options = queryMock.mock.calls.at(-1)?.[0]?.options as {
      abortController?: AbortController;
    };
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.abortController!.signal.aborted).toBe(false);
    await engine.stop("runtime-stop");
    expect(options.abortController!.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes every Claude SDK permission mode through to query options", async () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

    for (const mode of modes) {
      queryMock.mockReturnValue(emptyQuery());
      const engine = createClaudeEngine();
      await engine.start(
        {
          cwd: "/tmp/project",
          permissionMode: mode,
        },
        hooks(),
        `runtime-${mode}`,
      );

      const options = queryMock.mock.calls.at(-1)?.[0]?.options as Record<string, unknown>;
      expect(options.permissionMode).toBe(mode);
      expect(options.allowDangerouslySkipPermissions).toBe(mode === "bypassPermissions" ? true : undefined);
    }
  });

  it("maps the full SDK permission context and returns persistent permission updates", async () => {
    queryMock.mockReturnValue(emptyQuery());
    const canUseTool = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    }));
    const engine = createClaudeEngine();
    await engine.start({ cwd: "/tmp/project" }, hooks({ canUseTool }), "runtime-permission");

    const callback = queryMock.mock.calls.at(-1)?.[0]?.options?.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<unknown>;
    const signal = new AbortController().signal;
    await expect(callback("Bash", { command: "pwd" }, {
      signal,
      requestId: "request-1",
      toolUseID: "tool-1",
      agentID: "agent-1",
      suggestions: [{ type: "addRules" }],
      title: "Run command",
    })).resolves.toEqual({
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
    expect(canUseTool).toHaveBeenCalledWith(
      "Bash",
      { command: "pwd" },
      expect.objectContaining({
        signal,
        requestId: "request-1",
        toolUseId: "tool-1",
        agentId: "agent-1",
        title: "Run command",
      }),
    );
  });
});
