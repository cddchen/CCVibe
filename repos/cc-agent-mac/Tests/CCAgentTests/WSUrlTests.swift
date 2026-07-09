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

    func testUsesWssAndOmitsTokenWhenEmpty() {
        let url = WSUrl.build(config: .init(host: "example.com", port: 443, useTLS: true), token: "")
        XCTAssertEqual(url?.absoluteString, "wss://example.com:443/ws")
    }

    func testResolveFullWsUrlLikeWeb() {
        let cfg = WSUrl.resolveLoginInput(hostOrUrl: "ws://me.ts.cddchen.net:5174", portField: "4733", useTLS: false)
        XCTAssertEqual(cfg?.host, "me.ts.cddchen.net")
        XCTAssertEqual(cfg?.port, 5174)
        let url = WSUrl.build(config: cfg!, token: "cddchen")
        XCTAssertEqual(url?.absoluteString, "ws://me.ts.cddchen.net:5174/ws?token=cddchen")
    }

    func testResolveWsDoubleSlashTypo() {
        let cfg = WSUrl.resolveLoginInput(hostOrUrl: "ws//me.ts.cddchen.net", portField: "5174", useTLS: false)
        XCTAssertEqual(cfg?.host, "me.ts.cddchen.net")
        XCTAssertEqual(cfg?.port, 5174)
        XCTAssertEqual(cfg?.baseURLString, "ws://me.ts.cddchen.net:5174")
    }

    func testResolveHostOnlyNotDoubleScheme() {
        let cfg = WSUrl.resolveLoginInput(hostOrUrl: "me.ts.cddchen.net", portField: "5174", useTLS: false)
        XCTAssertEqual(cfg?.baseURLString, "ws://me.ts.cddchen.net:5174")
    }
}
