import { describe, expect, it } from "vitest";
import {
  buildToolResultsFromConversationMessages,
  conversationMessagesToChatMessages,
  upsertConversationMessage,
} from "./messageBlocks";
import type { ConversationMessage } from "./daemonClient";

const timestamp = "2026-07-23T00:00:00.000Z";

describe("messageBlocks", () => {
  it("renders daemon domain messages without parsing SDK payloads", () => {
    const messages: ConversationMessage[] = [
      { type: "user_message", id: "u1", turnId: "t1", timestamp, content: "hello", status: "completed" },
      {
        type: "agent_message",
        id: "a1",
        turnId: "t1",
        timestamp,
        status: "streaming",
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "consider" },
          { type: "tool_call", toolCallId: "tool-1", toolName: "Read", input: { file_path: "/tmp/a" }, status: "running" },
          { type: "text", text: "done" },
        ],
      },
      { type: "tool_result", id: "r1", turnId: "t1", timestamp, status: "completed", toolCallId: "tool-1", content: "contents", isError: false },
      { type: "model_changed", id: "m1", timestamp, family: "opus", modelId: "custom-opus" },
    ];

    expect(conversationMessagesToChatMessages(messages)).toEqual([
      { id: "u1", role: "user", content: "hello" },
      {
        id: "agent-turn:t1",
        role: "assistant",
        model: "claude-sonnet-4-6",
        streaming: true,
        content: [
          { type: "thinking", thinking: "consider" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
          { type: "text", text: "done" },
        ],
      },
      { id: "m1", role: "system", content: "模型已切换为 custom-opus" },
    ]);
    expect(buildToolResultsFromConversationMessages(messages)).toEqual({
      "tool-1": { status: "completed", content: "contents", isError: false },
    });
  });

  it("replaces a message with the latest complete snapshot", () => {
    const first: ConversationMessage = {
      type: "agent_message", id: "a1", turnId: "t1", timestamp, status: "streaming", content: [{ type: "text", text: "hel" }],
    };
    const latest: ConversationMessage = {
      type: "agent_message", id: "a1", turnId: "t1", timestamp, status: "completed", content: [{ type: "text", text: "hello" }],
    };
    expect(upsertConversationMessage([first], latest)).toEqual([latest]);
  });

  it("shows optimistic turn feedback until authoritative turn messages arrive", () => {
    const pending = { clientMessageId: "client-1", content: "hello" };
    expect(conversationMessagesToChatMessages([], pending)).toEqual([
      { id: "pending-user:client-1", role: "user", content: "hello" },
      {
        id: "pending-agent:client-1",
        role: "assistant",
        content: [],
        streaming: true,
        placeholderLabel: "正在连接模型",
      },
    ]);

    const authoritative: ConversationMessage[] = [
      { type: "user_message", id: "u1", turnId: "t1", timestamp, content: "hello", status: "completed" },
      { type: "agent_message", id: "a1", turnId: "t1", timestamp, content: [], status: "streaming" },
    ];
    expect(conversationMessagesToChatMessages(authoritative, { ...pending, turnId: "t1" })).toEqual([
      { id: "u1", role: "user", content: "hello" },
      { id: "agent-turn:t1", role: "assistant", content: [], streaming: true },
    ]);
  });

  it("groups multiple agent segments from one turn into one assistant bubble", () => {
    const messages: ConversationMessage[] = [
      { type: "user_message", id: "u1", turnId: "t1", timestamp, content: "inspect", status: "completed" },
      {
        type: "agent_message",
        id: "a1",
        turnId: "t1",
        timestamp,
        status: "completed",
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "check files" },
          { type: "tool_call", toolCallId: "tool-1", toolName: "Read", input: { file_path: "/tmp/a" }, status: "completed" },
        ],
      },
      {
        type: "agent_message",
        id: "a2",
        turnId: "t1",
        timestamp,
        status: "streaming",
        content: [{ type: "text", text: "answer" }],
      },
    ];

    expect(conversationMessagesToChatMessages(messages)).toEqual([
      { id: "u1", role: "user", content: "inspect" },
      {
        id: "agent-turn:t1",
        role: "assistant",
        model: "claude-sonnet-4-6",
        streaming: true,
        content: [
          { type: "thinking", thinking: "check files" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  it("keeps the grouped process expanded while the turn is still active between agent segments", () => {
    const messages: ConversationMessage[] = [
      { type: "user_message", id: "u1", turnId: "t1", timestamp, content: "inspect", status: "completed" },
      {
        type: "agent_message",
        id: "a1",
        turnId: "t1",
        timestamp,
        status: "completed",
        content: [{ type: "tool_call", toolCallId: "tool-1", toolName: "Read", input: {}, status: "completed" }],
      },
    ];

    const rendered = conversationMessagesToChatMessages(messages, {
      clientMessageId: "client-1",
      content: "inspect",
      turnId: "t1",
    });
    expect(rendered[1]).toMatchObject({ id: "agent-turn:t1", streaming: true });
  });
});
