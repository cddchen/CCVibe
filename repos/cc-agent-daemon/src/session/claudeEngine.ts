import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import type { PermissionMode, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineAdapter } from "./runner.js";

type ActiveQuery = {
  q: AsyncIterable<unknown> & {
    streamInput?: (msg: unknown) => Promise<void>;
    interrupt?: () => Promise<void>;
    setPermissionMode?: (m: PermissionMode) => Promise<void>;
    close?: () => void;
  };
  inputPush: (content: string) => void;
  inputDone: boolean;
  abort: AbortController;
};

export function createClaudeEngine(): EngineAdapter {
  const active = new Map<string, ActiveQuery>();

  return {
    async start(opts, hooks, runtimeId: string) {
      log.info("claude engine.start", { runtimeId, cwd: opts.cwd, model: opts.model });
      const queue: string[] = [];
      let resolveWait: (() => void) | null = null;
      const push = (content: string) => {
        queue.push(content);
        resolveWait?.();
        resolveWait = null;
      };

      async function* inputStream(): AsyncGenerator<SDKUserMessage> {
        while (true) {
          while (queue.length === 0) {
            await new Promise<void>((r) => {
              resolveWait = r;
            });
          }
          const content = queue.shift()!;
          yield {
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content },
          };
        }
      }

      const permissionMode = (opts.permissionMode ?? "default") as PermissionMode;
      const systemPrompt =
        typeof opts.systemPrompt === "string"
          ? opts.systemPrompt
          : opts.systemPrompt
            ? {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: opts.systemPrompt.append,
              }
            : undefined;

      const abort = new AbortController();
      const q = query({
        prompt: inputStream(),
        options: {
          abortController: abort,
          cwd: opts.cwd,
          model: opts.model,
          permissionMode,
          allowedTools: opts.allowedTools,
          disallowedTools: opts.disallowedTools,
          settingSources: opts.settingSources,
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          includePartialMessages: true,
          ...(opts.resumeSessionId
            ? { resume: opts.resumeSessionId }
            : opts.forkSessionId
              ? { resume: opts.forkSessionId, forkSession: true }
              : {}),
          canUseTool: async (toolName, input): Promise<PermissionResult> => {
            const result = await hooks.canUseTool(toolName, input as Record<string, unknown>);
            if (result.behavior === "allow") {
              return { behavior: "allow", updatedInput: result.updatedInput };
            }
            return { behavior: "deny", message: result.message ?? "denied" };
          },
          systemPrompt,
        },
      }) as ActiveQuery["q"];

      active.set(runtimeId, { q, inputPush: push, inputDone: false, abort });

      void (async () => {
        try {
          for await (const msg of q) {
            hooks.onMessage(msg);
          }
        } catch (err) {
          log.error("claude engine query error", { runtimeId, err: String(err) });
          hooks.onMessage({
            type: "result",
            subtype: "error_during_execution",
            errors: [String(err)],
          });
        } finally {
          active.delete(runtimeId);
        }
      })();

      return { runtimeId };
    },

    async send(runtimeId, content) {
      const a = active.get(runtimeId);
      if (!a) {
        log.error("claude engine.send unknown runtime", { runtimeId, active: [...active.keys()] });
        throw new Error(`unknown runtime ${runtimeId}`);
      }
      log.info("claude engine.send", { runtimeId, len: content.length });
      a.inputPush(content);
    },

    async interrupt(runtimeId) {
      const a = active.get(runtimeId);
      if (a?.q?.interrupt) await a.q.interrupt();
    },

    async setPermissionMode(runtimeId, mode) {
      const a = active.get(runtimeId);
      if (a?.q?.setPermissionMode) await a.q.setPermissionMode(mode as PermissionMode);
    },

    async stop(runtimeId) {
      const a = active.get(runtimeId);
      if (a) {
        try {
          a.abort.abort();
        } catch {
          /* ignore */
        }
        try {
          a.q.close?.();
        } catch {
          /* ignore */
        }
      }
      active.delete(runtimeId);
    },
  };
}