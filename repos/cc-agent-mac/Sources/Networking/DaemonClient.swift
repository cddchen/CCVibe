import Foundation
import Network

enum ConnectionPhase: Sendable {
    case connecting
    case connected
    case disconnected
}

typealias NotificationHandler = @Sendable (String, JSONValue?) -> Void

/// WebSocket + JSON-RPC client using Network.framework.
/// Avoids `URLSessionWebSocketTask`, which still enforces ATS on plaintext `ws://`
/// even when Info.plist allows arbitrary loads (observed on macOS 26).
@MainActor
final class DaemonClient: ObservableObject {
    @Published private(set) var phase: ConnectionPhase = .disconnected

    var onReconnect: (() -> Void)?
    /// 非主动断开且重连失败等导致会话不可用时回调（应回到首页重新登录）。
    var onSessionLost: (() -> Void)?

    private var token: String
    private var wsConfig: WSConnectionConfig
    private var connection: NWConnection?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var intentionalClose = false
    private var reconnectAttempts = 0
    private var reconnectTask: Task<Void, Never>?
    private var onNotify: NotificationHandler?
    private var hasConnectedOnce = false
    private var openContinuation: CheckedContinuation<Void, Error>?
    private var openTimeoutTask: Task<Void, Never>?
    private let queue = DispatchQueue(label: "com.ccagent.mac.ws")

    init(token: String = CredentialStore.token, config: WSConnectionConfig? = CredentialStore.wsConfig) {
        self.token = token
        self.wsConfig = config
            ?? WSConnectionConfig(host: "127.0.0.1", port: WSConnectionConfig.defaultPort, useTLS: false)
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
        do {
            try await openSocket(isReconnect: false)
            hasConnectedOnce = true
            phase = .connected
        } catch {
            phase = .disconnected
            throw error
        }
    }

    func close() {
        intentionalClose = true
        reconnectTask?.cancel()
        openTimeoutTask?.cancel()
        failOpenContinuation(JSONRPCClientError.connectionClosed)
        connection?.cancel()
        connection = nil
        failPending(JSONRPCClientError.connectionClosed)
        phase = .disconnected
    }

    func call(method: String, params: [String: Any] = [:]) async throws -> JSONValue {
        guard let connection, connection.state == .ready else {
            throw JSONRPCClientError.notConnected
        }
        let id = nextId
        nextId += 1
        let req = JSONRPCRequest(id: id, method: method, params: params)
        let data = try JSONEncoder().encode(req)
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "jsonrpc-\(id)", metadata: [metadata])

        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            connection.send(
                content: data,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { [weak self] error in
                    guard let error else { return }
                    Task { @MainActor in
                        self?.pending.removeValue(forKey: id)?
                            .resume(throwing: JSONRPCClientError.transport(error.localizedDescription))
                    }
                }
            )
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
        openTimeoutTask?.cancel()
        connection?.cancel()
        connection = nil
        failOpenContinuation(JSONRPCClientError.connectionClosed)
        failPending(JSONRPCClientError.connectionClosed)

        guard let url = WSUrl.build(config: wsConfig, token: token) else {
            throw JSONRPCClientError.invalidURL
        }

        #if DEBUG
        let redacted = token.isEmpty ? url.absoluteString : url.absoluteString.replacingOccurrences(of: token, with: "***")
        print("[DaemonClient] NW connecting \(redacted)")
        #endif

        let parameters: NWParameters = wsConfig.useTLS
            ? NWParameters(tls: NWProtocolTLS.Options(), tcp: NWProtocolTCP.Options())
            : .tcp
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        // Use URL endpoint so the HTTP upgrade hits `/ws?token=...` instead of `/`.
        let conn = NWConnection(to: .url(url), using: parameters)
        connection = conn

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            openContinuation = cont
            conn.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    self?.handleStateUpdate(state)
                }
            }
            conn.start(queue: queue)
            openTimeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, !Task.isCancelled else { return }
                self.failOpenContinuation(JSONRPCClientError.connectTimeout)
            }
        }

        startReceive(conn)

        if token.isEmpty {
            throw JSONRPCClientError.unauthorized
        }

        do {
            _ = try await call(method: "auth", params: ["token": token])
        } catch let error as JSONRPCClientError {
            throw mapAuthError(error)
        }

        if isReconnect {
            onReconnect?()
        }
    }

    private func handleStateUpdate(_ state: NWConnection.State) {
        switch state {
        case .ready:
            #if DEBUG
            print("[DaemonClient] NW ready")
            #endif
            completeOpenContinuation()
        case .failed(let error):
            #if DEBUG
            print("[DaemonClient] NW failed: \(error)")
            #endif
            let message = String(describing: error)
            if message.lowercased().contains("unauthorized") {
                failOpenContinuation(JSONRPCClientError.unauthorized)
            } else {
                failOpenContinuation(JSONRPCClientError.transport(error.localizedDescription))
            }
            handleDisconnect()
        case .cancelled:
            failOpenContinuation(JSONRPCClientError.connectionClosed)
            // intentional cancel path is handled by close(); still clear hangers
            if !intentionalClose {
                handleDisconnect()
            }
        case .waiting(let error):
            #if DEBUG
            print("[DaemonClient] NW waiting: \(error)")
            #endif
            // Surface hard failures (e.g. DNS / refused) instead of hanging until timeout.
            let ns = error as NWError
            switch ns {
            case .dns, .posix:
                failOpenContinuation(JSONRPCClientError.transport(error.localizedDescription))
                handleDisconnect()
            default:
                break
            }
        default:
            break
        }
    }

    private func startReceive(_ conn: NWConnection) {
        conn.receiveMessage { [weak self] content, contentContext, _isComplete, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    #if DEBUG
                    print("[DaemonClient] receive error: \(error)")
                    #endif
                    self.handleDisconnect()
                    return
                }
                if let content, !content.isEmpty {
                    self.handlePayload(content, context: contentContext)
                } else if contentContext?.isFinal == true {
                    // Empty final message can signal peer close.
                    self.handleDisconnect()
                    return
                }
                if self.connection === conn {
                    self.startReceive(conn)
                }
            }
        }
    }

    private func handlePayload(_ data: Data, context: NWConnection.ContentContext?) {
        if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
            if metadata.opcode == .close {
                handleDisconnect()
                return
            }
        }
        guard let wire = try? JSONDecoder().decode(JSONRPCResponse.self, from: data) else {
            #if DEBUG
            let preview = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes>"
            print("[DaemonClient] non-json frame: \(preview.prefix(300))")
            #endif
            return
        }

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

    private func mapAuthError(_ error: JSONRPCClientError) -> JSONRPCClientError {
        switch error {
        case .rpc(_, let message):
            let lower = message.lowercased()
            if lower.contains("unauthorized") || lower.contains("invalid token") || lower.contains("token") {
                return .unauthorized
            }
            return error
        case .notConnected, .connectionClosed:
            return .unauthorized
        default:
            return error
        }
    }

    private func handleDisconnect() {
        failPending(JSONRPCClientError.connectionClosed)
        failOpenContinuation(JSONRPCClientError.connectionClosed)
        let current = connection
        connection = nil
        current?.cancel()
        guard !intentionalClose else {
            phase = .disconnected
            return
        }
        phase = .connecting
        if hasConnectedOnce {
            scheduleReconnect()
        } else {
            phase = .disconnected
            onSessionLost?()
        }
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

    private func failOpenContinuation(_ error: Error) {
        openTimeoutTask?.cancel()
        openTimeoutTask = nil
        openContinuation?.resume(throwing: error)
        openContinuation = nil
    }

    private func completeOpenContinuation() {
        openTimeoutTask?.cancel()
        openTimeoutTask = nil
        openContinuation?.resume(returning: ())
        openContinuation = nil
    }
}
