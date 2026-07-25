import { describe, expect, it } from "vitest";
import { ConversationProjector } from "./projector.js";

describe("ConversationProjector", () => {
  it("projects SDK stream deltas into replaceable full message snapshots", () => {
    const projector = new ConversationProjector();
    expect(projector.beginTurn("turn-1", "hello")).toMatchObject([
      { type: "message_start", message: { type: "user_message", id: "turn-1", content: "hello" } },
      { type: "message_end", message: { type: "user_message", id: "turn-1", content: "hello" } },
    ]);

    const start = projector.accept({
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10 } } },
    });
    expect(start).toMatchObject([{
      type: "message_start",
      message: { type: "agent_message", id: "agent:turn-1:0", status: "streaming", model: "claude-sonnet-4-6", content: [] },
    }]);

    projector.accept({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    const update = projector.accept({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    });
    expect(update).toMatchObject([{
      type: "message_update",
      message: {
        id: "agent:turn-1:0",
        status: "streaming",
        content: [{ type: "text", text: "hello" }],
        metrics: { usage: { input: 10, total: 10 } },
      },
    }]);

    expect(projector.accept({ type: "result", subtype: "success", duration_ms: 1200 })).toMatchObject([{
      type: "message_end",
      message: { id: "agent:turn-1:0", status: "completed", content: [{ type: "text", text: "hello" }] },
    }]);
  });

  it("projects tool calls, permission state, and tool results as domain messages", () => {
    const projector = new ConversationProjector();
    projector.beginTurn("turn-2", "read file");
    projector.accept({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      },
    });
    projector.accept({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a"}' } },
    });
    const ready = projector.accept({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    expect(ready[0]).toMatchObject({
      type: "message_update",
      message: { content: [{ type: "tool_call", toolCallId: "tool-1", input: { file_path: "/tmp/a" }, status: "pending" }] },
    });
    expect(projector.setToolStatus("tool-1", "waiting_permission")[0]).toMatchObject({
      type: "message_update",
      message: { content: [{ toolCallId: "tool-1", status: "waiting_permission" }] },
    });

    const result = projector.accept({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents", is_error: false }] },
    });
    expect(result).toMatchObject([
      { type: "message_end", message: { type: "agent_message", content: [{ toolCallId: "tool-1", status: "completed" }] } },
      { type: "message_start", message: { type: "tool_result", toolCallId: "tool-1", content: "contents", status: "completed" } },
      { type: "message_end", message: { type: "tool_result", toolCallId: "tool-1", content: "contents", status: "completed" } },
    ]);
  });
});
