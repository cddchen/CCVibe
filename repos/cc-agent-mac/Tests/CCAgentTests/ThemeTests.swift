import XCTest
@testable import CCAgent

final class ThemeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: Theme.themeKey)
    }

    func testThemePreferencePersists() {
        XCTAssertEqual(Theme.readTheme(), .system)
        Theme.writeTheme(.dark)
        XCTAssertEqual(Theme.readTheme(), .dark)
        XCTAssertEqual(Theme.colorScheme(.light), .light)
        XCTAssertNil(Theme.colorScheme(.system))
    }
}
