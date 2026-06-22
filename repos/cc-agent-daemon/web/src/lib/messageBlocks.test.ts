import { describe, expect, it } from "vitest";
import {
  applySdkMessage,
  buildToolResultsFromHistory,
  historyEntriesToChatMessages,
  historyEntryToChatMessage,
  isNonDialogHistoryEntry,
  mergeMetrics,
} from "./messageBlocks";

const COMPACT_SUMMARY_TEXT =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request...";

describe("messageBlocks", () => {
  it("filters non-dialog history entries and tool-result-only user entries", () => {
    const messages = historyEntriesToChatMessages([
      { type: "system", uuid: "sys", message: { content: "init should not render" } },
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "hello" }] } },
      {
        type: "user",
        uuid: "tool-result-only",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hi" }], model: "claude-opus-4-7" } },
      { type: "debug", uuid: "debug", message: { content: "raw metadata" } },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(JSON.stringify(messages)).not.toContain("init should not render");
    expect(JSON.stringify(messages)).not.toContain("raw metadata");
  });

  it("does not render the compaction summary as a user message", () => {
    const messages = historyEntriesToChatMessages([
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "before compaction" }] } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "earlier reply" }], model: "claude-opus-4-7" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        // @ts-expect-error compactMetadata is extra runtime data, not part of HistoryJsonlEntry
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 168001, postTokens: 11777 },
      },
      {
        type: "user",
        uuid: "compact-summary",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: COMPACT_SUMMARY_TEXT },
      },
      {
        type: "assistant",
        uuid: "a2",
        message: { content: [{ type: "text", text: "after compaction" }], model: "claude-opus-4-7" },
      },
    ]);

    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    const dump = JSON.stringify(messages);
    expect(dump).not.toContain("This session is being continued");
    expect(dump).not.toContain("Conversation compacted");
  });

  it("flushes the assistant turn at a compaction boundary instead of merging across it", () => {
    const messages = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "pre",
        message: { content: [{ type: "text", text: "pre-compact" }], model: "claude-opus-4-7" },
      },
      { type: "user", uuid: "summary", isCompactSummary: true, message: { content: COMPACT_SUMMARY_TEXT } },
      {
        type: "assistant",
        uuid: "post",
        message: { content: [{ type: "text", text: "post-compact" }], model: "claude-opus-4-7" },
      },
    ]);

    // Two distinct assistant messages, not one merged turn spanning the boundary
    expect(messages.map((m) => m.id)).toEqual(["pre", "post"]);
    expect(messages[0].content).toEqual([{ type: "text", text: "pre-compact" }]);
    expect(messages[1].content).toEqual([{ type: "text", text: "post-compact" }]);
  });

  it("isNonDialogHistoryEntry flags compaction markers but allows real turns", () => {
    expect(isNonDialogHistoryEntry({ type: "user", isCompactSummary: true })).toBe(true);
    expect(isNonDialogHistoryEntry({ type: "user", isVisibleInTranscriptOnly: true })).toBe(true);
    expect(isNonDialogHistoryEntry({ type: "system", subtype: "compact_boundary" })).toBe(true);
    expect(isNonDialogHistoryEntry({ type: "user", message: { content: "real" } })).toBe(false);
    expect(isNonDialogHistoryEntry({ type: "assistant", message: { content: [] } })).toBe(false);
  });

  it("historyEntryToChatMessage returns null for a compaction summary entry", () => {
    expect(
      historyEntryToChatMessage({
        type: "user",
        uuid: "compact-summary",
        isCompactSummary: true,
        message: { content: COMPACT_SUMMARY_TEXT },
      }),
    ).toBeNull();
  });

  it("skips signature-only thinking blocks (empty text) like cc CLI", () => {
    const messages = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            // signature-only redacted thinking persisted on resume → no text
            { type: "thinking", thinking: "", signature: "gAAAAAB..." },
            { type: "text", text: "Here is the answer." },
          ],
          model: "claude-opus-4-7",
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "Here is the answer." }]);
  });

  it("keeps thinking blocks that do have text", () => {
    const messages = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "Let me reason about this.", signature: "sig" },
            { type: "text", text: "Answer." },
          ],
          model: "claude-opus-4-7",
        },
      },
    ]);

    expect(messages[0].content).toEqual([
      { type: "thinking", thinking: "Let me reason about this." },
      { type: "text", text: "Answer." },
    ]);
  });

  it("does not emit an assistant message for a turn that is only empty thinking", () => {
    const messages = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "thinking", thinking: "", signature: "sig-only" }], model: "claude-opus-4-7" },
      },
    ]);

    // No renderable blocks → no message row at all (matches cc CLI rendering null)
    expect(messages).toEqual([]);
  });

  it("merges split assistant history into one message with blocks and metrics", () => {
    const messages = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "a-thinking",
        duration_ms: 1234,
        message: {
          content: [{ type: "thinking", thinking: "think" }],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10 },
        },
      },
      {
        type: "assistant",
        uuid: "a-text",
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
            { type: "text", text: "answer" },
          ],
          usage: { output_tokens: 5, total_tokens: 15 },
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "a-text",
      role: "assistant",
      model: "claude-sonnet-4-6",
      metrics: { usage: { input: 10, output: 5, total: 15 }, elapsedSeconds: 1.2 },
    });
    expect(messages[0].content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
      { type: "text", text: "answer" },
    ]);
  });

  it("collects tool results from history without rendering them as messages", () => {
    const history = [
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ text: "file contents" }] }],
        },
      },
    ];

    expect(buildToolResultsFromHistory(history)).toEqual({
      "tool-1": { status: "completed", content: "file contents", isError: false },
    });
    expect(historyEntriesToChatMessages(history)).toEqual([]);
  });

  it("emits live token usage and model from message_start and message_delta", () => {
    const start = applySdkMessage([], {}, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "grok-composer-2.5-fast", usage: { input_tokens: 76, output_tokens: 0 } },
      },
    });
    expect(start.model).toBe("grok-composer-2.5-fast");
    expect(start.metrics).toEqual({ usage: { input: 76, output: 0, total: 76 } });

    const delta = applySdkMessage(start.blocks, start.toolResults, {
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 485 }, delta: { stop_reason: null } },
    });
    expect(delta.metrics).toEqual({ usage: { output: 485, total: 485 } });
  });

  it("mergeMetrics streams a live total: input from start, output from each delta", () => {
    // Reproduces the user's example: grok-composer-2.5-fast in 76 / out 485 / total 561
    let m = mergeMetrics(undefined, { usage: { input: 76, output: 0, total: 76 } });
    expect(m).toEqual({ usage: { input: 76, output: 0, total: 76 } });

    m = mergeMetrics(m, { usage: { output: 200, total: 200 } });
    expect(m).toEqual({ usage: { input: 76, output: 200, total: 276 } });

    m = mergeMetrics(m, { usage: { output: 485, total: 485 } });
    expect(m).toEqual({ usage: { input: 76, output: 485, total: 561 } });

    // Final result reconciles and adds elapsed without clobbering the live total
    m = mergeMetrics(m, { usage: { input: 76, output: 485, total: 561 }, elapsedSeconds: 3.2 });
    expect(m).toEqual({ usage: { input: 76, output: 485, total: 561 }, elapsedSeconds: 3.2 });
  });

  it("mergeMetrics returns current unchanged when there is no new usage event", () => {
    const current = { usage: { input: 5, output: 6, total: 11 }, elapsedSeconds: 1 };
    expect(mergeMetrics(current, undefined)).toBe(current);
  });

  it("keeps live mixed blocks consistent with reloaded history", () => {
    let liveBlocks = [] as Parameters<typeof applySdkMessage>[0];
    let liveTools = {} as Parameters<typeof applySdkMessage>[1];
    let liveMetrics: ReturnType<typeof mergeMetrics>;
    let liveModel: string | undefined;

    const applyLive = (msg: unknown) => {
      const applied = applySdkMessage(liveBlocks, liveTools, msg);
      liveBlocks = applied.blocks;
      liveTools = applied.toolResults;
      liveMetrics = mergeMetrics(liveMetrics, applied.metrics);
      liveModel = applied.model ?? liveModel;
    };

    applyLive({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 0 } },
      },
    });
    applyLive({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } },
    });
    applyLive({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } } },
    });
    applyLive({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ text: "file contents" }] }] },
    });
    applyLive({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } },
    });
    applyLive({
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: null } },
    });
    applyLive({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      duration_ms: 1200,
    });

    const history = [
      {
        type: "assistant",
        uuid: "a-thinking",
        message: {
          content: [{ type: "thinking", thinking: "think" }],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10 },
        },
      },
      {
        type: "assistant",
        uuid: "a-tool-text",
        duration_ms: 1200,
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
            { type: "text", text: "answer" },
          ],
          usage: { output_tokens: 5, total_tokens: 15 },
        },
      },
      {
        type: "user",
        uuid: "tool-result-only",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ text: "file contents" }] }] },
      },
    ];
    const [historyMessage] = historyEntriesToChatMessages(history);

    expect(liveBlocks).toEqual(historyMessage.content);
    expect(liveModel).toBe(historyMessage.model);
    expect(liveMetrics).toEqual(historyMessage.metrics);
    expect(liveTools).toEqual(buildToolResultsFromHistory(history));
  });

  it("keeps live assistant snapshots consistent with reloaded split assistant history", () => {
    let liveBlocks = [] as Parameters<typeof applySdkMessage>[0];
    let liveTools = {} as Parameters<typeof applySdkMessage>[1];

    for (const msg of [
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } } },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }], model: "claude-opus-4-7" },
      },
    ]) {
      const applied = applySdkMessage(liveBlocks, liveTools, msg);
      liveBlocks = applied.blocks;
      liveTools = applied.toolResults;
    }

    const [historyMessage] = historyEntriesToChatMessages([
      {
        type: "assistant",
        uuid: "a-thinking",
        message: { content: [{ type: "thinking", thinking: "plan" }], model: "claude-opus-4-7" },
      },
      {
        type: "assistant",
        uuid: "a-tool-text",
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
            { type: "text", text: "done" },
          ],
        },
      },
    ]);

    expect(liveBlocks).toEqual(historyMessage.content);
    expect(liveTools).toEqual({ "tool-1": { status: "pending" } });
  });

  it("keeps live and history paths aligned when non-dialog data appears", () => {
    const liveApplied = applySdkMessage([], {}, { type: "system", message: { content: "init metadata" } });
    const historyMessages = historyEntriesToChatMessages([
      { type: "system", uuid: "sys", message: { content: "init metadata" } },
      { type: "debug", uuid: "debug", message: { content: "raw metadata" } },
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "hello" }] } },
    ]);

    expect(liveApplied.blocks).toEqual([]);
    expect(liveApplied.toolResults).toEqual({});
    expect(historyMessages).toEqual([{ id: "u1", role: "user", content: "hello" }]);
  });

  it("keeps existing live thinking and tool blocks when assistant snapshots arrive", () => {
    let blocks = [] as Parameters<typeof applySdkMessage>[0];
    let tools = {} as Parameters<typeof applySdkMessage>[1];

    let applied = applySdkMessage(blocks, tools, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } },
    });
    blocks = applied.blocks;
    tools = applied.toolResults;

    applied = applySdkMessage(blocks, tools, {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } },
    });
    blocks = applied.blocks;
    tools = applied.toolResults;

    applied = applySdkMessage(blocks, tools, {
      type: "assistant",
      message: { content: [{ type: "text", text: "latest answer" }], model: "claude-sonnet-4-6" },
    });

    expect(applied.blocks).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "text", text: "latest answer" },
    ]);
    expect(applied.toolResults.t1).toEqual({ status: "pending" });
  });

  it("updates the live trailing text from assistant snapshots instead of duplicating it", () => {
    let applied = applySdkMessage([{ type: "text", text: "hel" }], {}, {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });

    expect(applied.blocks).toEqual([{ type: "text", text: "hello" }]);

    applied = applySdkMessage([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "text", text: "old" },
    ], { t1: { status: "pending" } }, {
      type: "assistant",
      message: { content: [{ type: "text", text: "new" }] },
    });

    expect(applied.blocks).toEqual([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "text", text: "new" },
    ]);
  });

  it("applies streaming deltas, tool state, model and result metrics without leaking result text", () => {
    let blocks = [] as Parameters<typeof applySdkMessage>[0];
    let tools = {} as Parameters<typeof applySdkMessage>[1];

    let applied = applySdkMessage(blocks, tools, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "consider" } },
    });
    blocks = applied.blocks;
    tools = applied.toolResults;

    applied = applySdkMessage(blocks, tools, {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Bash" } },
    });
    blocks = applied.blocks;
    tools = applied.toolResults;

    applied = applySdkMessage(blocks, tools, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "done" } },
    });
    blocks = applied.blocks;
    tools = applied.toolResults;

    applied = applySdkMessage(blocks, tools, {
      type: "result",
      result: "raw result should not become a visible assistant block",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      duration_ms: 2000,
    });

    expect(applied.blocks).toEqual([
      { type: "thinking", thinking: "consider" },
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "text", text: "done" },
    ]);
    expect(applied.toolResults.t1).toEqual({ status: "pending" });
    expect(applied.metrics).toEqual({ usage: { input: 3, output: 4, total: 7 }, elapsedSeconds: 2 });
    expect(JSON.stringify(applied.blocks)).not.toContain("raw result");
  });
});
