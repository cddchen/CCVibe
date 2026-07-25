import type { ConversationMessage } from "./daemonClient";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type MessageBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export type ToolResultState = {
  status: "pending" | "completed" | "error";
  content?: string;
  isError?: boolean;
};

export type TokenUsage = { input?: number; output?: number; total?: number };
export type MessageMetrics = { usage?: TokenUsage; elapsedSeconds?: number };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | MessageBlock[];
  streaming?: boolean;
  model?: string;
  metrics?: MessageMetrics;
  placeholderLabel?: string;
};

export type PendingTurnFeedback = {
  clientMessageId: string;
  content: string;
  turnId?: string;
};

export function isAssistantBlocks(content: ChatMessage["content"]): content is MessageBlock[] {
  return Array.isArray(content);
}

function agentContentToBlocks(
  content: Extract<ConversationMessage, { type: "agent_message" }>["content"],
): MessageBlock[] {
  return content.map((block): MessageBlock => {
    if (block.type === "tool_call") {
      return { type: "tool_use", id: block.toolCallId, name: block.toolName, input: block.input };
    }
    return block;
  });
}

function mergeMessageMetrics(
  current: MessageMetrics | undefined,
  next: MessageMetrics | undefined,
): MessageMetrics | undefined {
  if (!next) return current;
  return {
    usage: current?.usage || next.usage
      ? { ...current?.usage, ...next.usage }
      : undefined,
    elapsedSeconds: next.elapsedSeconds ?? current?.elapsedSeconds,
  };
}

/** The UI consumes only daemon-owned domain messages; Claude SDK events never cross this boundary. */
export function conversationMessagesToChatMessages(
  messages: ConversationMessage[],
  pendingTurn?: PendingTurnFeedback | null,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const assistantByTurn = new Map<string, number>();
  for (const message of messages) {
    if (message.type === "tool_result") continue;
    if (message.type === "user_message") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text).join("\n");
      if (content) out.push({ id: message.id, role: "user", content });
      continue;
    }
    if (message.type === "agent_message") {
      const blocks = agentContentToBlocks(message.content);
      if (blocks.length === 0 && message.status !== "streaming") continue;
      const existingIndex = assistantByTurn.get(message.turnId);
      if (existingIndex === undefined) {
        assistantByTurn.set(message.turnId, out.length);
        const chatMessage: ChatMessage = {
          id: `agent-turn:${message.turnId}`,
          role: "assistant",
          content: blocks,
          streaming: message.status === "streaming",
        };
        if (message.model) chatMessage.model = message.model;
        if (message.metrics) chatMessage.metrics = message.metrics;
        out.push(chatMessage);
      } else {
        const existing = out[existingIndex];
        if (Array.isArray(existing.content)) existing.content = [...existing.content, ...blocks];
        existing.model = message.model ?? existing.model;
        existing.metrics = mergeMessageMetrics(existing.metrics, message.metrics);
        existing.streaming = existing.streaming === true || message.status === "streaming";
      }
      continue;
    }
    if (message.type === "model_changed") {
      out.push({ id: message.id, role: "system", content: `模型已切换为 ${message.modelId}` });
    } else if (message.type === "effort_changed") {
      out.push({ id: message.id, role: "system", content: `思考强度已切换为 ${message.effort}` });
    } else if (message.type === "permission_mode_changed") {
      out.push({ id: message.id, role: "system", content: `权限模式已切换为 ${message.mode}` });
    } else if (message.content) {
      out.push({ id: message.id, role: "system", content: message.content });
    }
  }
  if (pendingTurn) {
    const hasUserMessage = pendingTurn.turnId
      ? messages.some((message) => message.type === "user_message" && message.turnId === pendingTurn.turnId)
      : false;
    const hasAgentMessage = pendingTurn.turnId
      ? messages.some((message) => message.type === "agent_message" && message.turnId === pendingTurn.turnId)
      : false;
    const activeAssistantIndex = pendingTurn.turnId
      ? assistantByTurn.get(pendingTurn.turnId)
      : undefined;
    if (activeAssistantIndex !== undefined) out[activeAssistantIndex].streaming = true;
    if (!hasUserMessage) {
      out.push({
        id: `pending-user:${pendingTurn.clientMessageId}`,
        role: "user",
        content: pendingTurn.content,
      });
    }
    if (!hasAgentMessage) {
      out.push({
        id: `pending-agent:${pendingTurn.clientMessageId}`,
        role: "assistant",
        content: [],
        streaming: true,
        placeholderLabel: "正在连接模型",
      });
    }
  }
  return out;
}

export function buildToolResultsFromConversationMessages(
  messages: ConversationMessage[],
): Record<string, ToolResultState> {
  const out: Record<string, ToolResultState> = {};
  for (const message of messages) {
    if (message.type === "agent_message") {
      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        const isError = block.status === "failed" || block.status === "denied";
        out[block.toolCallId] = {
          status: isError ? "error" : block.status === "completed" ? "completed" : "pending",
          isError,
        };
      }
    } else if (message.type === "tool_result") {
      out[message.toolCallId] = {
        status: message.isError ? "error" : "completed",
        content: message.content,
        isError: message.isError,
      };
    }
  }
  return out;
}

export function upsertConversationMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}
