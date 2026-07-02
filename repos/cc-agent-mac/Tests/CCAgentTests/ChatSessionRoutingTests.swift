import XCTest
@testable import CCAgent

final class ChatSessionRoutingTests: XCTestCase {
    func testShouldReplaceUrlOnlyForNewChat() {
        XCTAssertTrue(ChatSessionRouting.shouldReplaceChatUrlFromInit(historySessionId: nil))
        XCTAssertFalse(ChatSessionRouting.shouldReplaceChatUrlFromInit(historySessionId: "abc"))
    }

    func testLiveTurnBusy() {
        XCTAssertTrue(ChatSessionRouting.liveTurnIsBusy(status: "running"))
        XCTAssertTrue(ChatSessionRouting.liveTurnIsBusy(status: "starting"))
        XCTAssertFalse(ChatSessionRouting.liveTurnIsBusy(status: "completed"))
    }
}