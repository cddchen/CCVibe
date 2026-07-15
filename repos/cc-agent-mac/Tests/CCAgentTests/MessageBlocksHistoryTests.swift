import XCTest
@testable import CCAgent

final class MessageBlocksHistoryTests: XCTestCase {
    func testHistoryFiltersNonDialogAndToolResultOnlyEntries() {
        let messages = MessageBlocksEngine.historyEntriesToChatMessages([
            .init(type: "system", subtype: nil, uuid: "sys", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .string("init should not render"), model: nil, usage: nil)),
            .init(type: "user", subtype: nil, uuid: "u1", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("text"), "text": .string("hello")])]), model: nil, usage: nil)),
            .init(type: "user", subtype: nil, uuid: "tool", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("tool_result"), "tool_use_id": .string("t1")])]), model: nil, usage: nil)),
            .init(type: "assistant", subtype: nil, uuid: "a1", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("text"), "text": .string("hi")])]), model: "claude", usage: nil)),
        ])

        XCTAssertEqual(messages.map(\.id), ["u1", "a1"])
    }

    func testHistoryIgnoresControlNoiseBetweenAssistantChunks() {
        // Real jsonl inserts last-prompt / mode / file-history-snapshot mid-turn.
        // Those must not split one user turn into multiple assistant bubbles.
        let messages = MessageBlocksEngine.historyEntriesToChatMessages([
            .init(type: "user", subtype: nil, uuid: "u1", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("text"), "text": .string("go")])]), model: nil, usage: nil)),
            .init(type: "assistant", subtype: nil, uuid: "a1", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("thinking"), "thinking": .string("plan")])]), model: "m", usage: nil)),
            .init(type: "assistant", subtype: nil, uuid: "a2", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("text"), "text": .string("step1")])]), model: "m", usage: nil)),
            .init(type: "assistant", subtype: nil, uuid: "a3", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("tool_use"), "id": .string("t1"), "name": .string("Bash"), "input": .object([:])])]), model: "m", usage: nil)),
            .init(type: "user", subtype: nil, uuid: "tr1", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("tool_result"), "tool_use_id": .string("t1"), "content": .string("ok")])]), model: nil, usage: nil)),
            .init(type: "last-prompt", subtype: nil, uuid: "lp", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: nil),
            .init(type: "mode", subtype: nil, uuid: "md", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: nil),
            .init(type: "permission-mode", subtype: nil, uuid: "pm", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: nil),
            .init(type: "file-history-snapshot", subtype: nil, uuid: "fh", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: nil),
            .init(type: "assistant", subtype: nil, uuid: "a4", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("thinking"), "thinking": .string("more")])]), model: "m", usage: nil)),
            .init(type: "assistant", subtype: nil, uuid: "a5", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: .init(content: .array([.object(["type": .string("text"), "text": .string("done")])]), model: "m", usage: nil)),
            .init(type: "system", subtype: "turn_duration", uuid: "sys", parentUuid: nil, timestamp: nil, duration_ms: nil, durationMs: nil, elapsed_ms: nil, elapsedMs: nil, isCompactSummary: nil, isVisibleInTranscriptOnly: nil, message: nil),
        ])

        let assistants = messages.filter { $0.role == "assistant" }
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0].id, "a5")
        if case .blocks(let blocks) = assistants[0].content {
            XCTAssertEqual(blocks.count, 5)
            XCTAssertEqual(blocks[0], .thinking("plan"))
            XCTAssertEqual(blocks[1], .text("step1"))
            if case .toolUse(let id, let name, _) = blocks[2] {
                XCTAssertEqual(id, "t1")
                XCTAssertEqual(name, "Bash")
            } else {
                XCTFail("expected tool_use")
            }
            XCTAssertEqual(blocks[3], .thinking("more"))
            XCTAssertEqual(blocks[4], .text("done"))
        } else {
            XCTFail("expected blocks")
        }
    }

    func testBuildToolResultsFromHistoryBackfillsToolResult() {
        let history = [HistoryJsonlEntry(
            type: "user",
            subtype: nil,
            uuid: nil,
            parentUuid: nil,
            timestamp: nil,
            duration_ms: nil,
            durationMs: nil,
            elapsed_ms: nil,
            elapsedMs: nil,
            isCompactSummary: nil,
            isVisibleInTranscriptOnly: nil,
            message: .init(content: .array([.object([
                "type": .string("tool_result"),
                "tool_use_id": .string("tool-1"),
                "content": .array([.object(["text": .string("file contents")])]),
            ])]), model: nil, usage: nil)
        )]

        XCTAssertEqual(
            MessageBlocksEngine.buildToolResultsFromHistory(history),
            ["tool-1": ToolResultState(status: .completed, content: "file contents", isError: false)]
        )
    }
}
