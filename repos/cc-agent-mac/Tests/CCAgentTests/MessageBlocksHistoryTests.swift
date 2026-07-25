import XCTest
@testable import CCAgent

final class MessageBlocksHistoryTests: XCTestCase {
    func testConversationMessagesUseDomainSnapshotsAndToolResults() throws {
        let json = #"""
        [
          {"type":"user_message","id":"u1","turnId":"t1","timestamp":"2026-07-23T00:00:00Z","status":"completed","content":"hello"},
          {"type":"agent_message","id":"a1","turnId":"t1","timestamp":"2026-07-23T00:00:01Z","status":"streaming","model":"claude-sonnet","content":[
            {"type":"thinking","thinking":"plan"},
            {"type":"text","text":"hi"},
            {"type":"tool_call","toolCallId":"tool-1","toolName":"Read","input":{"file_path":"README.md"},"status":"running"}
          ]},
          {"type":"tool_result","id":"r1","turnId":"t1","timestamp":"2026-07-23T00:00:02Z","status":"completed","toolCallId":"tool-1","content":"done","isError":false}
        ]
        """#
        let domain = try JSONDecoder().decode([ConversationMessage].self, from: Data(json.utf8))
        let chat = MessageBlocksEngine.conversationMessagesToChatMessages(domain)

        XCTAssertEqual(chat.map(\.id), ["u1", "a1"])
        XCTAssertTrue(chat[1].streaming)
        XCTAssertEqual(
            MessageBlocksEngine.buildToolResultsFromConversationMessages(domain)["tool-1"],
            ToolResultState(status: .completed, content: "done", isError: false)
        )
    }

    func testConversationMessageUpsertReplacesWholeSnapshot() throws {
        let first = try JSONDecoder().decode(ConversationMessage.self, from: Data(#"{"type":"agent_message","id":"a1","turnId":"t1","timestamp":"x","status":"streaming","content":[{"type":"text","text":"a"}]}"#.utf8))
        let final = try JSONDecoder().decode(ConversationMessage.self, from: Data(#"{"type":"agent_message","id":"a1","turnId":"t1","timestamp":"x","status":"completed","content":[{"type":"text","text":"answer"}]}"#.utf8))

        let messages = MessageBlocksEngine.upsertConversationMessage([first], final)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].status, "completed")
        XCTAssertEqual(messages[0].content?.arrayValue?.first?["text"]?.stringValue, "answer")
    }

    func testPendingUserIsRemovedAsSoonAsTurnIdMatchesServerMessage() throws {
        let serverMessage = try JSONDecoder().decode(ConversationMessage.self, from: Data(#"{"type":"user_message","id":"u1","turnId":"turn-1","timestamp":"x","status":"completed","content":"hello"}"#.utf8))
        let pending = PendingTurnFeedback(clientMessageId: "client-1", content: "hello", turnId: "turn-1")

        let messages = MessageBlocksEngine.conversationMessagesToChatMessages([serverMessage], pendingTurn: pending)

        XCTAssertEqual(messages.filter { $0.role == "user" }.map(\.id), ["u1"])
        XCTAssertEqual(messages.filter { $0.role == "assistant" }.map(\.id), ["pending-agent:client-1"])
    }

    func testAgentMessagesInSameTurnShareOneBubble() throws {
        let json = #"""
        [
          {"type":"user_message","id":"u1","turnId":"turn-1","timestamp":"1","status":"completed","content":"inspect"},
          {"type":"agent_message","id":"a1","turnId":"turn-1","timestamp":"2","status":"completed","model":"gpt","metrics":{"usage":{"input":10,"output":2,"total":12}},"content":[
            {"type":"thinking","thinking":"plan"},
            {"type":"tool_call","toolCallId":"tool-1","toolName":"Read","input":{},"status":"completed"}
          ]},
          {"type":"tool_result","id":"r1","turnId":"turn-1","timestamp":"3","status":"completed","toolCallId":"tool-1","content":"ok","isError":false},
          {"type":"agent_message","id":"a2","turnId":"turn-1","timestamp":"4","status":"completed","model":"gpt","metrics":{"usage":{"input":3,"output":4,"total":7}},"content":[
            {"type":"thinking","thinking":"summarize"},
            {"type":"text","text":"answer"}
          ]}
        ]
        """#
        let domain = try JSONDecoder().decode([ConversationMessage].self, from: Data(json.utf8))

        let chat = MessageBlocksEngine.conversationMessagesToChatMessages(domain)
        let assistants = chat.filter { $0.role == "assistant" }

        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants[0].id, "a1")
        XCTAssertEqual(assistants[0].metrics?.usage, TokenUsage(input: 13, output: 6, total: 19))
        guard case .blocks(let blocks) = assistants[0].content else {
            return XCTFail("expected assistant blocks")
        }
        XCTAssertEqual(blocks.count, 4)
        XCTAssertEqual(blocks[0], .thinking("plan"))
        XCTAssertEqual(blocks[2], .thinking("summarize"))
        XCTAssertEqual(blocks[3], .text("answer"))
    }
}
