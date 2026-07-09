import Foundation

struct HistorySession: Codable, Identifiable, Hashable, Sendable {
    var id: String { sessionId }
    let sessionId: String
    let messageCount: Int
    let lastTimestamp: String?
    /// Present in daemon summaries; ignored for UI.
    let filePath: String?
    let firstTimestamp: String?

    init(sessionId: String, messageCount: Int, lastTimestamp: String?, filePath: String? = nil, firstTimestamp: String? = nil) {
        self.sessionId = sessionId
        self.messageCount = messageCount
        self.lastTimestamp = lastTimestamp
        self.filePath = filePath
        self.firstTimestamp = firstTimestamp
    }
}

struct Workspace: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let path: String
    let createdAt: String
}

enum PermissionMode: String, Codable, CaseIterable, Sendable {
    case `default`
    case acceptEdits
    case bypassPermissions
    case plan
    case dontAsk
    case auto
}

enum EffortLevel: String, Codable, CaseIterable, Sendable {
    case low, medium, high, xhigh, max
}

struct DaemonSettings: Codable, Sendable {
    struct Models: Codable, Sendable {
        var `default`: String?
        var opus: String?
        var sonnet: String?
        var haiku: String?
        var advisor: String?
    }

    struct Permissions: Codable, Sendable {
        var allow: [String]
        var deny: [String]
        var defaultMode: PermissionMode?
        var additionalDirectories: [String]
    }

    var models: Models
    var permissions: Permissions
    var effortLevel: EffortLevel?
}

struct ModelOption: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
}

enum SessionRunState: String, Sendable {
    case running
    case completed
    case interrupted
    case error
}

enum DaemonConstants {
    static let modelOptions: [ModelOption] = [
        .init(id: "claude-sonnet-4-6", label: "Sonnet 4.6"),
        .init(id: "claude-opus-4-7", label: "Opus 4.7"),
        .init(id: "claude-haiku-4-5-20251001", label: "Haiku 4.5"),
    ]

    static let effortOptions: [(id: EffortLevel, label: String)] = [
        (.low, "低"),
        (.medium, "中"),
        (.high, "高"),
        (.xhigh, "极高"),
        (.max, "最高"),
    ]

    static let permissionModeOptions: [(id: PermissionMode, label: String)] = [
        (.default, "Default"),
        (.acceptEdits, "Accept Edits"),
        (.plan, "Plan Mode"),
        (.auto, "Auto Mode"),
        (.bypassPermissions, "Bypass Permissions"),
        (.dontAsk, "Don't Ask"),
    ]

    static func modelOptions(from settings: DaemonSettings) -> [ModelOption] {
        [
            .init(id: settings.models.sonnet ?? "claude-sonnet-4-6", label: "Sonnet"),
            .init(id: settings.models.opus ?? "claude-opus-4-7", label: "Opus"),
            .init(id: settings.models.haiku ?? "claude-haiku-4-5-20251001", label: "Haiku"),
        ]
    }
}

struct SessionListData: Sendable {
    var workspaces: [Workspace]
    var sessionsByPath: [String: [HistorySession]]
}

struct SessionGroup: Identifiable, Sendable {
    var id: String { workspace.path }
    let workspace: Workspace
    let sessions: [HistorySession]
    let latestAt: String
}

struct TrustInfo: Sendable {
    let trusted: Bool
    let path: String
    let parent: String
}

enum ActiveKind: Sendable {
    case running
    case starting
    case attachable
}

struct ActiveSessionRow: Decodable, Sendable {
    let sessionId: String
    let cwd: String
    let status: String
    let subscriberCount: Int
}

func reconnectDelayMs(attempt: Int) -> Int {
    min(1000 * Int(pow(2.0, Double(attempt))), 30_000)
}

func sessionGroups(from data: SessionListData) -> [SessionGroup] {
    var groups = data.workspaces.map { workspace -> SessionGroup in
        let sessions = (data.sessionsByPath[workspace.path] ?? []).sorted {
            ($0.lastTimestamp ?? "").compare($1.lastTimestamp ?? "") == .orderedDescending
        }
        return SessionGroup(
            workspace: workspace,
            sessions: sessions,
            latestAt: sessions.first?.lastTimestamp ?? workspace.createdAt
        )
    }
    groups.sort { $0.latestAt.compare($1.latestAt) == .orderedDescending }
    return groups
}

func mapActiveSessions(_ rows: [ActiveSessionRow]) -> [String: ActiveKind] {
    var out: [String: ActiveKind] = [:]
    for row in rows {
        switch row.status {
        case "running":
            out[row.sessionId] = .running
        case "starting":
            out[row.sessionId] = .starting
        default:
            out[row.sessionId] = .attachable
        }
    }
    return out
}

func runStateFromDaemonStatus(_ status: String?) -> SessionRunState {
    switch status {
    case "running", "starting":
        return .running
    case "error":
        return .error
    case "interrupted":
        return .interrupted
    default:
        return .completed
    }
}

func displayNameForWorkspacePath(_ path: String) -> String {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "工作区" }
    let name = (trimmed as NSString).lastPathComponent
    return name.isEmpty || name == "/" ? trimmed : name
}

func displayTitleForSession(_ session: HistorySession, workspacePath: String) -> String {
    let workspaceName = displayNameForWorkspacePath(workspacePath)
    guard !workspaceName.isEmpty else {
        return "会话 \(String(session.sessionId.prefix(8)))…"
    }
    return workspaceName
}

func displaySubtitleForSession(_ session: HistorySession, activeKind: ActiveKind?) -> String {
    var parts = ["\(session.messageCount) 条消息"]
    if activeKind != nil {
        parts.append("活跃")
    }
    parts.append(String(session.sessionId.prefix(8)) + "…")
    return parts.joined(separator: " · ")
}
