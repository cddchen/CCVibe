import Foundation
import SwiftUI

enum AppRoute: Hashable {
    case sessionList
    case chat(workspacePath: String, sessionId: String?)
}

@MainActor
final class AppState: ObservableObject {
    @Published var client = DaemonClient()
    @Published var router = NotificationRouter()
    @Published var route: AppRoute = .sessionList
    @Published var reconnectNonce = 0
    @Published var connectionError: String?
    /// 首页连接 + token 校验通过后才为 true，才展示会话列表。
    @Published private(set) var isSessionUnlocked = false

    var isConnected: Bool { client.phase == .connected }

    init() {
        router.install(on: client)
        client.onReconnect = { [weak self] in
            Task { @MainActor in
                self?.reconnectNonce += 1
            }
        }
        client.onSessionLost = { [weak self] in
            Task { @MainActor in
                self?.logout(showError: "连接已断开")
            }
        }
    }

    /// 连接并校验（WS 打开 + auth + ping），成功则进入会话列表。
    func connect(host: String, port: Int, useTLS: Bool, token: String) async {
        connectionError = nil
        let config = WSConnectionConfig(host: host, port: port, useTLS: useTLS)
        client.setCredentials(token: token, config: config)
        do {
            try await client.connect()
            try await validateSession(client: client)
            isSessionUnlocked = true
            route = .sessionList
        } catch {
            isSessionUnlocked = false
            client.close()
            connectionError = error.localizedDescription
        }
    }

    func disconnect() {
        logout(showError: nil)
    }

    private func logout(showError: String?) {
        isSessionUnlocked = false
        route = .sessionList
        client.close()
        if let showError {
            connectionError = showError
        }
    }

    private func validateSession(client: DaemonClient) async throws {
        struct Ping: Decodable { let ok: Bool }
        let pong = try await client.callDecodable(Ping.self, method: "ping", params: [:])
        guard pong.ok else {
            throw JSONRPCClientError.rpc(-1, "ping failed")
        }
    }

    func openChat(workspacePath: String, sessionId: String? = nil) {
        route = .chat(workspacePath: workspacePath, sessionId: sessionId)
    }

    func goHome() {
        route = .sessionList
    }
}