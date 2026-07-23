import type {
  PermissionMode,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "node:crypto";
import type { SessionCreateOptions } from "./types.js";
import type { EffortLevel } from "../settings/reader.js";

export type EngineUserInput = {
  id: UUID;
  content: string;
};

export type EnginePermissionContext = {
  signal: AbortSignal;
  requestId: string;
  toolUseId: string;
  agentId?: string;
  suggestions?: Record<string, unknown>[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  matchedAskRule?: Record<string, unknown>;
};

export type EnginePermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
    }
  | { behavior: "deny"; message?: string };
export type EngineInterruptReceipt = Awaited<ReturnType<Query["interrupt"]>>;

export type EngineHooks = {
  onMessage: (message: SDKMessage) => void;
  onRuntimeClosed: (error?: Error) => void;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    context: EnginePermissionContext,
  ) => Promise<EnginePermissionDecision>;
};

export type EngineAdapter = {
  start(
    opts: SessionCreateOptions,
    hooks: EngineHooks,
    runtimeId: string,
  ): Promise<{ runtimeId: string }>;
  send(runtimeId: string, input: EngineUserInput): Promise<void>;
  interrupt(runtimeId: string): Promise<EngineInterruptReceipt>;
  reinitialize(runtimeId: string): Promise<void>;
  setModel(runtimeId: string, model?: string): Promise<void>;
  setEffort(runtimeId: string, effort: EffortLevel): Promise<void>;
  setPermissionMode(runtimeId: string, mode: PermissionMode): Promise<void>;
  stop(runtimeId: string): Promise<void>;
};
