import Foundation

enum SessionListService {
    private static var cached: SessionListData?
    private static var pending: Task<SessionListData, Error>?

    static func getCached() -> SessionListData? { cached }

    static func clearCache() {
        cached = nil
        pending = nil
    }

    static func load(client: DaemonClient, force: Bool = false) async throws -> SessionListData {
        if !force, let cached { return cached }
        if !force, let pending { return try await pending.value }

        let task = Task {
            try await fetch(client: client)
        }
        pending = task
        do {
            let result = try await task.value
            cached = result
            pending = nil
            return result
        } catch {
            pending = nil
            throw error
        }
    }

    private static func fetch(client: DaemonClient) async throws -> SessionListData {
        struct ProjectsResult: Decodable {
            struct Project: Decodable {
                let workspacePath: String
                let sessions: [HistorySession]
            }
            let projects: [Project]
        }
        struct WorkspacesResult: Decodable {
            let workspaces: [Workspace]
        }
        struct SessionsResult: Decodable {
            let sessions: [HistorySession]
        }

        let projects = try await client.callDecodable(ProjectsResult.self, method: "history.listAllLocal", params: [:])
        var sessionsByPath: [String: [HistorySession]] = [:]
        var workspaces: [Workspace] = []

        for p in projects.projects {
            sessionsByPath[p.workspacePath] = p.sessions
            workspaces.append(Workspace(
                id: p.workspacePath,
                path: p.workspacePath,
                createdAt: p.sessions.first?.lastTimestamp ?? ISO8601DateFormatter().string(from: Date())
            ))
        }

        let manual = try await client.callDecodable(WorkspacesResult.self, method: "workspace.list", params: [:])
        for w in manual.workspaces {
            var shouldShow = sessionsByPath[w.path] != nil
            if sessionsByPath[w.path] == nil || sessionsByPath[w.path]?.isEmpty == true {
                do {
                    let hist = try await client.callDecodable(
                        SessionsResult.self,
                        method: "history.listSessions",
                        params: ["workspacePath": w.path]
                    )
                    sessionsByPath[w.path] = hist.sessions
                    shouldShow = true
                } catch {
                    shouldShow = false
                }
            }
            if shouldShow, !workspaces.contains(where: { $0.path == w.path }) {
                workspaces.append(w)
            }
        }

        return SessionListData(workspaces: workspaces, sessionsByPath: sessionsByPath)
    }
}