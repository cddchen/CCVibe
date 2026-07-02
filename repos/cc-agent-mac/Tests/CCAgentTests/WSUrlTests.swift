import XCTest
@testable import CCAgent

final class WSUrlTests: XCTestCase {
    func testBuildAppendsWsAndToken() {
        let url = WSUrl.build(base: "ws://192.168.1.10:4733", token: "a b/c")
        XCTAssertEqual(url?.absoluteString, "ws://192.168.1.10:4733/ws?token=a%20b%2Fc")
    }

    func testStripsTrailingSlash() {
        let url = WSUrl.build(base: "ws://host:4733/", token: "")
        XCTAssertEqual(url?.path, "/ws")
    }
}