import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import type { EngineAdapter, EngineUserInput } from "./engine.js";

type ActiveQuery = {
  query: Query;
  pushInput: (input: EngineUserInput) => void;
  abort: AbortController;
  stopping: boolean;
};

function requireActive(active: Map<string, ActiveQuery>, runtimeId: string): ActiveQuery {
  const value = active.get(runtimeId);
  if (!value) {
    throw new Error(`unknown runtime ${runtimeId}`);
  }
  return value;
}

export function createClaudeEngine(): EngineAdapter {
  const active = new Map<string, ActiveQuery>();

  return {
    async start(opts, hooks, runtimeId) {
      log.info("claude engine.start", { runtimeId, cwd: opts.cwd, model: opts.model });
      const queue: EngineUserInput[] = [];
      let resolveWait: (() => void) | undefined;
      const pushInput = (input: EngineUserInput) => {
        queue.push(input);
        resolveWait?.();
        resolveWait = undefined;
      };

      async function* inputStream(): AsyncGenerator<SDKUserMessage> {
        while (true) {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
            });
          }
          const input = queue.shift();
          if (!input) continue;
          yield {
            type: "user",
            uuid: input.id,
            parent_tool_use_id: null,
            message: { role: "user", content: input.content },
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
      const sdkQuery = query({
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
          canUseTool: async (toolName, input, context): Promise<PermissionResult> => {
            const decision = await hooks.canUseTool(toolName, input, {
              signal: context.signal,
              requestId: context.requestId,
              toolUseId: context.toolUseID,
              agentId: context.agentID,
              suggestions: context.suggestions as Record<string, unknown>[] | undefined,
              blockedPath: context.blockedPath,
              decisionReason: context.decisionReason,
              title: context.title,
              displayName: context.displayName,
              description: context.description,
              matchedAskRule: context.matchedAskRule,
            });
            if (decision.behavior === "allow") {
              const result: PermissionResult = { behavior: "allow" };
              if (decision.updatedInput !== undefined) result.updatedInput = decision.updatedInput;
              if (decision.updatedPermissions !== undefined) {
                result.updatedPermissions = decision.updatedPermissions as PermissionUpdate[];
              }
              return result;
            }
            return { behavior: "deny", message: decision.message ?? "denied" };
          },
          systemPrompt,
        },
      });

      const state: ActiveQuery = {
        query: sdkQuery,
        pushInput,
        abort,
        stopping: false,
      };
      active.set(runtimeId, state);

      void (async () => {
        let runtimeError: Error | undefined;
        try {
          for await (const message of sdkQuery) {
            hooks.onMessage(message);
          }
        } catch (error) {
          if (!state.stopping) {
            runtimeError = error instanceof Error ? error : new Error(String(error));
            log.error("claude engine query error", { runtimeId, err: runtimeError.message });
          }
        } finally {
          if (active.get(runtimeId) === state) active.delete(runtimeId);
          hooks.onRuntimeClosed(runtimeError);
        }
      })();

      return { runtimeId };
    },

    async send(runtimeId, input) {
      const state = requireActive(active, runtimeId);
      log.info("claude engine.send", { runtimeId, turnId: input.id, len: input.content.length });
      state.pushInput(input);
    },

    async interrupt(runtimeId) {
      return requireActive(active, runtimeId).query.interrupt();
    },

    async reinitialize(runtimeId) {
      await requireActive(active, runtimeId).query.reinitialize();
    },

    async setModel(runtimeId, model) {
      await requireActive(active, runtimeId).query.setModel(model);
    },

    async setEffort(runtimeId, effort) {
      await requireActive(active, runtimeId).query.applyFlagSettings({ effortLevel: effort });
    },

    async setPermissionMode(runtimeId, mode) {
      await requireActive(active, runtimeId).query.setPermissionMode(mode);
    },

    async stop(runtimeId) {
      const state = active.get(runtimeId);
      if (!state) return;
      state.stopping = true;
      state.abort.abort();
      state.query.close();
    },
  };
}
