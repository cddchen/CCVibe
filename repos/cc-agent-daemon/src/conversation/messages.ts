import { randomUUID } from "node:crypto";
import type { JsonlEntry } from "../history/reader.js";
import type {
  ConversationEntry,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from "./types.js";

type MessageRecord = {
  content?: unknown;
  model?: string;
};

function messageOf(entry: JsonlEntry): MessageRecord {
  return typeof entry.message === "object" && entry.message !== null
    ? entry.message as MessageRecord
    : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function agentContent(content: unknown): Array<TextContent | ThinkingContent | ToolCallContent> {
  if (!Array.isArray(content)) return typeof content === "string" && content
    ? [{ type: "text", text: content }]
    : [];
  const result: Array<TextContent | ThinkingContent | ToolCallContent> = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string" && value.text) {
      result.push({ type: "text", text: value.text });
    } else if (value.type === "thinking" && typeof value.thinking === "string" && value.thinking) {
      result.push({ type: "thinking", thinking: value.thinking });
    } else if (value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") {
      result.push({
        type: "tool_call",
        toolCallId: value.id,
        toolName: value.name,
        input: typeof value.input === "object" && value.input !== null
          ? value.input as Record<string, unknown>
          : {},
      });
    }
  }
  return result;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isHidden(entry: JsonlEntry): boolean {
  return entry.isCompactSummary === true
    || entry.isVisibleInTranscriptOnly === true
    || (entry as { subtype?: string }).subtype === "compact_boundary";
}

export function mapHistoryEntries(entries: JsonlEntry[]): ConversationEntry[] {
  const result: ConversationEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    for (const block of agentContent(messageOf(entry).content)) {
      if (block.type === "tool_call") toolNames.set(block.toolCallId, block.toolName);
    }
  }
  for (const entry of entries) {
    if (isHidden(entry)) continue;
    const message = messageOf(entry);
    if (entry.type === "assistant") {
      const content = agentContent(message.content);
      if (content.length === 0) continue;
      result.push({
        type: "agent_message",
        id: entry.uuid ?? randomUUID(),
        timestamp: entry.timestamp,
        model: message.model,
        agentId: (entry as { agentId?: string }).agentId,
        parentToolUseId: (entry as { parentToolUseID?: string }).parentToolUseID,
        content,
      });
      continue;
    }
    if (entry.type !== "user") continue;
    if (Array.isArray(message.content)) {
      for (let index = 0; index < message.content.length; index += 1) {
        const block = message.content[index];
        if (typeof block !== "object" || block === null) continue;
        const value = block as Record<string, unknown>;
        if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") continue;
        result.push({
          type: "tool_result",
          id: `${entry.uuid ?? randomUUID()}:tool:${index}`,
          timestamp: entry.timestamp,
          toolCallId: value.tool_use_id,
          toolName: toolNames.get(value.tool_use_id),
          content: toolResultText(value.content),
          isError: value.is_error === true,
        });
      }
    }
    const content = textFromContent(message.content);
    if (content) {
      result.push({
        type: "user_message",
        id: entry.uuid ?? randomUUID(),
        timestamp: entry.timestamp,
        content,
      });
    }
  }
  return result;
}

export function latestAssistantModel(entries: JsonlEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "assistant") continue;
    const model = messageOf(entry).model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return undefined;
}
