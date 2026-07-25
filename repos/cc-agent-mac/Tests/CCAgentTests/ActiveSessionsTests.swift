import XCTest
@testable import CCAgent

final class ActiveSessionsTests: XCTestCase {
    func testPermissionResolvedEventDecodes() throws {
        let data = Data(#"{"version":1,"sequence":9,"conversationId":"c1","sessionId":"s1","runtimeId":"r1","timestamp":"2026-07-24T00:00:00.000Z","event":{"type":"permission_resolved","requestId":"req-1","behavior":"allow"}}"#.utf8)
        let envelope = try JSONDecoder().decode(ConversationEventEnvelope.self, from: data)

        XCTAssertEqual(envelope.event.type, "permission_resolved")
        XCTAssertEqual(envelope.event.requestId?.stringValue, "req-1")
        XCTAssertEqual(envelope.event.behavior, "allow")
    }

    func testMapActiveSessionsDistinguishesStates() {
        let mapped = mapActiveSessions([
            .init(conversationId: "a", sessionId: "sdk-a", runtimeId: "run-a", cwd: "/tmp/a", status: "running", runtimeStatus: "running", subscriberCount: 1),
            .init(conversationId: "b", sessionId: "sdk-b", runtimeId: "run-b", cwd: "/tmp/b", status: "starting", runtimeStatus: "starting", subscriberCount: 1),
            .init(conversationId: "c", sessionId: "sdk-c", runtimeId: "run-c", cwd: "/tmp/c", status: "idle", runtimeStatus: "running", subscriberCount: 0),
        ])

        XCTAssertEqual(mapped["a"], .running)
        XCTAssertEqual(mapped["b"], .starting)
        XCTAssertEqual(mapped["c"], .attachable)
        XCTAssertEqual(mapped["sdk-a"], .running)
        XCTAssertEqual(mapped["run-b"], .starting)
    }
}
