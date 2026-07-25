import type { PermissionMode } from "../session/types.js";
import type { EffortLevel } from "../settings/reader.js";
import type { RuntimeStatus, SessionStatus, TurnStatus } from "../events/types.js";

export type ModelFamily = "sonnet" | "opus" | "haiku";
export type ConfigSource = "conversation" | "history" | "settings" | "fallback";

export type TokenUsage = { input?: number; output?: number; total?: number };
export type MessageMetrics = { usage?: TokenUsage; elapsedSeconds?: number };
export type MessageStatus = "streaming" | "completed" | "interrupted" | "failed";
export type ToolCallStatus =
  | "building"
  | "pending"
  | "waiting_permission"
  | "running"
  | "completed"
  | "failed"
  | "denied";

export type TextContent = { type: "text"; text: string };
export type ThinkingContent = { type: "thinking"; thinking: string };
export type ToolCallContent = {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
};

export type UserMessage = {
  type: "user_message";
  id: string;
  turnId: string;
  timestamp: string;
  content: string | TextContent[];
  status: Exclude<MessageStatus, "streaming">;
};

export type AgentMessage = {
  type: "agent_message";
  id: string;
  turnId: string;
  timestamp: string;
  status: MessageStatus;
  model?: string;
  agentId?: string;
  parentToolUseId?: string;
  content: Array<TextContent | ThinkingContent | ToolCallContent>;
  metrics?: MessageMetrics;
};

export type ToolResultMessage = {
  type: "tool_result";
  id: string;
  turnId: string;
  timestamp: string;
  status: "completed" | "failed";
  toolCallId: string;
  toolName?: string;
  content: string;
  isError: boolean;
};

export type ConversationMessage =
  | UserMessage
  | AgentMessage
  | ToolResultMessage
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
      timestamp: string;
      subtype?: string;
      content: string;
    };

export type MessageLifecycleEvent =
  | { type: "message_start"; message: ConversationMessage }
  | { type: "message_update"; message: ConversationMessage }
  | { type: "message_end"; message: ConversationMessage };

export type ConversationEvent =
  | MessageLifecycleEvent
  | { type: "conversation_status"; status: SessionStatus; error?: string }
  | { type: "runtime_status"; status: RuntimeStatus; error?: string }
  | {
      type: "runtime_initialized";
      sdkSessionId: string;
      model?: string;
      cwd?: string;
      slashCommands?: unknown[];
    }
  | {
      type: "turn_status";
      turnId: string;
      status: TurnStatus;
      error?: string;
      resultSubtype?: string;
    }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      input: unknown;
      toolUseId?: string;
      agentId?: string;
      suggestions?: unknown[];
      title?: string;
      displayName?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      behavior: "allow" | "deny";
      reason?: string;
    };

export type ConversationEventEnvelope = {
  version: 1;
  sequence: number;
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  timestamp: string;
  event: ConversationEvent;
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
  revision: number;
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
  messages: ConversationMessage[];
};
