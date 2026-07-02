import Foundation

enum ConnectionPhase: Sendable {
    case connecting
    case connected
    case disconnected
}

typealias NotificationHandler = @Sendable (String, JSONValue?) -> Void

@MainActor
final class DaemonClient: ObservableObject {
    @Published private(set) var phase: ConnectionPhase = .disconnected

    var onReconnect: (() -> Void)?
    /// 非主动断开且重连失败等导致会话不可用时回调（应回到首页重新登录）。
    var onSessionLost: (() -> Void)?

    private var token: String
    private var wsConfig: WSConnectionConfig
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var intentionalClose = false
    private var reconnectAttempts = 0
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var onNotify: NotificationHandler?

    init(token: String = CredentialStore.token, config: WSConnectionConfig? = CredentialStore.wsConfig) {
        self.token = token
        self.wsConfig = config ?? WSConnectionConfig(host: "127.0.0.1", port: WSConnectionConfig.defaultPort, useTLS: false)
        self.session = URLSession(configuration: .default)
    }

    func setCredentials(token: String, config: WSConnectionConfig) {
        self.token = token
        self.wsConfig = config
        CredentialStore.token = token
        CredentialStore.wsConfig = config
    }

    func onNotification(_ handler: @escaping NotificationHandler) {
        onNotify = handler
    }

    func connect() async throws {
        intentionalClose = false
        reconnectAttempts = 0
        reconnectTask?.cancel()
        phase = .connecting
        try await openSocket(isReconnect: false)
        phase = .connected
    }

    func close() {
        intentionalClose = true
        reconnectTask?.cancel()
        receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failPending(JSONRPCClientError.connectionClosed)
        phase = .disconnected
    }

    func call(method: String, params: [String: Any] = [:]) async throws -> JSONValue {
        guard let task, task.state == .running else {
            throw JSONRPCClientError.notConnected
        }
        let id = nextId
        nextId += 1
        let req = JSONRPCRequest(id: id, method: method, params: params)
        let data = try JSONEncoder().encode(req)
        let text = String(data: data, encoding: .utf8) ?? "{}"
        try await task.send(.string(text))

        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
        }
    }

    func callDecodable<T: Decodable>(_ type: T.Type, method: String, params: [String: Any] = [:]) async throws -> T {
        let result = try await call(method: method, params: params)
        let data = try JSONEncoder().encode(result)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
            if let raw = String(data: data, encoding: .utf8) {
                print("[DaemonClient] decode \(method) failed: \(error)\nraw: \(raw.prefix(2000))")
            }
            #endif
            throw error
        }
    }

    private func openSocket(isReconnect: Bool) async throws {
        receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        failPending(JSONRPCClientError.connectionClosed)

        guard let url = WSUrl.build(config: wsConfig, token: token) else {
            throw JSONRPCClientError.notConnected
        }
        let ws = session.webSocketTask(with: url)
        task = ws
        ws.resume()
        startReceiveLoop(ws)
        // Let the receive loop start before the first RPC (auth / history.*).
        try await Task.sleep(nanoseconds: 50_000_000)

        if !token.isEmpty {
            _ = try await call(method: "auth", params: ["token": token])
        }
        if isReconnect {
            onReconnect?()
        }
    }

    private func startReceiveLoop(_ ws: URLSessionWebSocketTask) {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let message = try await ws.receive()
                    await self.handle(message)
                } catch {
                    await self.handleDisconnect()
                    break
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let s): text = s
        case .data(let d): text = String(data: d, encoding: .utf8) ?? ""
        @unknown default: return
        }
        guard let data = text.data(using: .utf8),
              let wire = try? JSONDecoder().decode(JSONRPCResponse.self, from: data) else { return }

        if let id = wire.id, wire.method == nil {
            if let err = wire.error {
                pending.removeValue(forKey: id)?.resume(throwing: JSONRPCClientError.rpc(err.code, err.message))
            } else if let result = wire.result {
                pending.removeValue(forKey: id)?.resume(returning: result)
            }
            return
        }
        if let method = wire.method {
            onNotify?(method, wire.params)
        }
    }

    private func handleDisconnect() {
        failPending(JSONRPCClientError.connectionClosed)
        task = nil
        guard !intentionalClose else {
            phase = .disconnected
            return
        }
        phase = .disconnected
        onSessionLost?()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = reconnectDelayMs(attempt: reconnectAttempts)
        reconnectAttempts += 1
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            guard let self, !Task.isCancelled, !self.intentionalClose else { return }
            do {
                try await self.openSocket(isReconnect: true)
                self.reconnectAttempts = 0
                self.phase = .connected
            } catch {
                self.scheduleReconnect()
            }
        }
    }

    private func failPending(_ error: Error) {
        for (_, cont) in pending {
            cont.resume(throwing: error)
        }
        pending.removeAll()
    }
}