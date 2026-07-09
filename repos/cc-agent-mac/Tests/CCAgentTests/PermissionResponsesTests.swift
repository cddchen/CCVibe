import XCTest
@testable import CCAgent

final class PermissionResponsesTests: XCTestCase {
    private let request = PendingPermission(
        id: "req-1",
        sessionId: "sess-1",
        requestId: "req-1",
        toolName: "AskUserQuestion",
        input: .object(["questions": .array([])])
    )

    func testPermissionInputTextFormatsJson() {
        XCTAssertEqual(PermissionResponses.permissionInputText(nil), "{}")
        XCTAssertTrue(PermissionResponses.permissionInputText(.object(["a": .string("b")])).contains("\"a\""))
    }

    func testBuildAllowResponseWithUpdatedInput() throws {
        let params = try PermissionResponses.buildPermissionRespondParams(
            request: request,
            behavior: "allow",
            updatedInputText: "{\"answers\":{\"q\":\"a\"}}"
        )
        XCTAssertEqual(params["behavior"] as? String, "allow")
        XCTAssertNotNil(params["updatedInput"])
    }

    func testBuildDenyResponseWithMessage() throws {
        let params = try PermissionResponses.buildPermissionRespondParams(
            request: request,
            behavior: "deny",
            denyMessage: "不要进入计划"
        )
        XCTAssertEqual(params["message"] as? String, "不要进入计划")
    }

    func testRejectsNonObjectUpdatedInput() {
        XCTAssertThrowsError(try PermissionResponses.parseUpdatedInput("[]"))
        XCTAssertThrowsError(try PermissionResponses.parseUpdatedInput("\"yes\""))
    }
}
