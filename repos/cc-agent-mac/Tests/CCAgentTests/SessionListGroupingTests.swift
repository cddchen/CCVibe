import XCTest
@testable import CCAgent

final class SessionListGroupingTests: XCTestCase {
    func testSessionGroupsSortDirectoriesAndSessionsDescending() {
        let data = SessionListData(
            workspaces: [
                .init(id: "/b", path: "/b", createdAt: "2026-01-01T00:00:00Z"),
                .init(id: "/a", path: "/a", createdAt: "2026-01-03T00:00:00Z"),
            ],
            sessionsByPath: [
                "/a": [
                    .init(sessionId: "a1", messageCount: 1, lastTimestamp: "2026-01-02T00:00:00Z"),
                    .init(sessionId: "a2", messageCount: 1, lastTimestamp: "2026-01-04T00:00:00Z"),
                ],
                "/b": [
                    .init(sessionId: "b1", messageCount: 1, lastTimestamp: "2026-01-05T00:00:00Z"),
                ],
            ]
        )

        let groups = sessionGroups(from: data)

        XCTAssertEqual(groups.map(\.workspace.path), ["/b", "/a"])
        XCTAssertEqual(groups[1].sessions.map(\.sessionId), ["a2", "a1"])
    }

    func testSessionGroupsKeepEmptyWorkspace() {
        let data = SessionListData(
            workspaces: [
                .init(id: "/empty", path: "/empty", createdAt: "2026-01-01T00:00:00Z"),
            ],
            sessionsByPath: [:]
        )

        let groups = sessionGroups(from: data)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].workspace.path, "/empty")
        XCTAssertTrue(groups[0].sessions.isEmpty)
    }

    func testWorkspaceDisplayNameUsesLastPathComponent() {
        XCTAssertEqual(displayNameForWorkspacePath("/Users/cdd/Documents/cc-agent-mac"), "cc-agent-mac")
        XCTAssertEqual(displayNameForWorkspacePath("   "), "工作区")
    }

    func testSessionDisplayUsesExistingSessionFieldsOnly() {
        let session = HistorySession(
            sessionId: "1234567890abcdef",
            messageCount: 7,
            lastTimestamp: "2026-01-05T00:00:00Z"
        )

        XCTAssertEqual(displayTitleForSession(session, workspacePath: "/tmp/project"), "project")
        XCTAssertEqual(displaySubtitleForSession(session, activeKind: nil), "7 条消息 · 12345678…")
        XCTAssertEqual(displaySubtitleForSession(session, activeKind: .running), "7 条消息 · 活跃 · 12345678…")
    }
}
