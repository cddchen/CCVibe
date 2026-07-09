import Foundation
import SwiftUI

enum AppRoute: Hashable {
    /// Connected home: sidebar visible, no conversation selected.
    case home
    case chat(workspacePath: String, sessionId: String?)
}

@MainActor
final class AppState: ObservableObject {
    @Published var client = DaemonClient()
    @Published var router = NotificationRouter()
    @Published var route: AppRoute = .home
    @Published var reconnectNonce = 0
    @Published var connectionError: String?
    @Published var theme: AppTheme = Theme.readTheme()
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
                self?.handleUnexpectedDisconnect()
            }
        }
    }

    /// 连接并校验（WS 打开 + auth + ping），成功则进入会话列表。
    func connect(host: String, port: Int, useTLS: Bool, token: String) async {
        connectionError = nil
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else {
            isSessionUnlocked = false
            connectionError = "请填写 Token（daemon 启动时的 --token）"
            return
        }
        let config = WSConnectionConfig(host: host, port: port, useTLS: useTLS)
        client.setCredentials(token: trimmedToken, config: config)
        do {
            try await client.connect()
            try await validateSession(client: client)
            isSessionUnlocked = true
            route = .home
        } catch {
            isSessionUnlocked = false
            client.close()
            connectionError = friendlyConnectionError(error)
        }
    }

    private func friendlyConnectionError(_ error: Error) -> String {
        if let rpc = error as? JSONRPCClientError {
            return rpc.localizedDescription
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorTimedOut:
                return "连接超时：请确认主机端口可达"
            case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost:
                return "无法连接主机：请检查 IP/域名、端口，以及 TLS 开关"
            case NSURLErrorNotConnectedToInternet:
                return "无网络连接"
            default:
                return "网络错误：\(error.localizedDescription)"
            }
        }
        return error.localizedDescription
    }

    func disconnect() {
        logout(showError: nil)
    }

    private func handleUnexpectedDisconnect() {
        if isSessionUnlocked {
            connectionError = "连接已断开，正在重连"
            return
        }
        logout(showError: "连接已断开")
    }

    private func logout(showError: String?) {
        isSessionUnlocked = false
        route = .home
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
        route = .home
    }

    func setTheme(_ theme: AppTheme) {
        self.theme = theme
        Theme.writeTheme(theme)
    }
}
