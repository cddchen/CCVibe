import XCTest
@testable import CCAgent

final class ActiveSessionsTests: XCTestCase {
    func testMapActiveSessionsDistinguishesStates() {
        let mapped = mapActiveSessions([
            .init(sessionId: "a", cwd: "/tmp/a", status: "running", subscriberCount: 1),
            .init(sessionId: "b", cwd: "/tmp/b", status: "starting", subscriberCount: 1),
            .init(sessionId: "c", cwd: "/tmp/c", status: "idle", subscriberCount: 0),
        ])

        XCTAssertEqual(mapped["a"], .running)
        XCTAssertEqual(mapped["b"], .starting)
        XCTAssertEqual(mapped["c"], .attachable)
    }
}
