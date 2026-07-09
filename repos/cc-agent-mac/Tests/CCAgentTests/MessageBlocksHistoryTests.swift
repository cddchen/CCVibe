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
