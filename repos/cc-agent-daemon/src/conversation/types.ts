import type { PermissionMode } from "../session/types.js";
import type { EffortLevel } from "../settings/reader.js";

export type ModelFamily = "sonnet" | "opus" | "haiku";
export type ConfigSource = "conversation" | "history" | "settings" | "fallback";

export type TextContent = { type: "text"; text: string };
export type ThinkingContent = { type: "thinking"; thinking: string };
export type ToolCallContent = {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ConversationEntry =
  | {
      type: "user_message";
      id: string;
      timestamp?: string;
      content: string | TextContent[];
    }
  | {
      type: "agent_message";
      id: string;
      timestamp?: string;
      model?: string;
      agentId?: string;
      parentToolUseId?: string;
      content: Array<TextContent | ThinkingContent | ToolCallContent>;
    }
  | {
      type: "tool_result";
      id: string;
      timestamp?: string;
      toolCallId: string;
      toolName?: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "model_changed";
      id: string;
      timestamp: string;
      family: ModelFamily;
      modelId: string;
    }
  | {
      type: "effort_changed";
      id: string;
      timestamp: string;
      effort: EffortLevel;
    }
  | {
      type: "permission_mode_changed";
      id: string;
      timestamp: string;
      mode: PermissionMode;
    }
  | {
      type: "system_message";
      id: string;
      timestamp?: string;
      subtype?: string;
      content: string;
    };

export type ResolvedConversationConfig = {
  model: {
    family: ModelFamily;
    requestedId: string;
    effectiveId?: string;
    source: ConfigSource;
  };
  effort: {
    requested: EffortLevel;
    effective?: EffortLevel;
    source: Exclude<ConfigSource, "history">;
  };
  permissionMode: PermissionMode;
};

export type ConversationRuntimeState =
  | "cold"
  | "spawning"
  | "idle"
  | "running"
  | "waiting_permission"
  | "closing"
  | "closed"
  | "crashed"
  | "error";

export type ConversationSnapshot = {
  conversation: {
    id: string;
    sdkSessionId?: string;
    workspacePath: string;
  };
  runtime: {
    state: ConversationRuntimeState;
    runtimeId?: string;
  };
  config: ResolvedConversationConfig;
  currentTurn?: { turnId: string; status: string };
  messages: ConversationEntry[];
};
