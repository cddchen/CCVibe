import XCTest
@testable import CCAgent

final class ChatPreferencesTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: ChatPreferences.chatSidebarOpenKey)
        UserDefaults.standard.removeObject(forKey: ChatPreferences.chatFollowOutputKey)
    }

    func testReadBoolFallsBackAndPersists() {
        XCTAssertTrue(ChatPreferences.readBool(ChatPreferences.chatSidebarOpenKey, fallback: true))
        ChatPreferences.writeBool(ChatPreferences.chatSidebarOpenKey, value: false)
        XCTAssertFalse(ChatPreferences.readBool(ChatPreferences.chatSidebarOpenKey, fallback: true))
    }
}
