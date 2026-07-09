import XCTest
@testable import CCAgent

final class DirectoryExpansionStoreTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: DirectoryExpansionStore.homeExpandedKey)
    }

    func testWriteAndReadExpandedState() {
        DirectoryExpansionStore.write(["/tmp/project": true])

        XCTAssertEqual(DirectoryExpansionStore.read()["/tmp/project"], true)
    }

    func testDefaultCollapsedWhenNoPreferenceExists() {
        XCTAssertFalse(DirectoryExpansionStore.isExpanded(path: "/tmp/project", prefs: [:]))
    }
}
