import XCTest
@testable import CCAgent

final class ReconnectBackoffTests: XCTestCase {
    func testBackoff() {
        XCTAssertEqual(reconnectDelayMs(attempt: 0), 1000)
        XCTAssertEqual(reconnectDelayMs(attempt: 1), 2000)
        XCTAssertEqual(reconnectDelayMs(attempt: 10), 30_000)
    }
}