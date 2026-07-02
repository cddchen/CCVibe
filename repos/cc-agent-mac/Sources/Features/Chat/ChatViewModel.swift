import Foundation

struct TrustPrompt: Identifiable {
    let id = UUID()
    let path: String
    let parent: String
}

struct PendingPermission: Identifiable {
    let id: String
    let sessionId: String
    let requestId: String
    let toolName: String
    let input: JSONValue?
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var trusted = false
    @Published var trustPrompt: TrustPrompt?
    @Published var statusText = ""
    @Published var busy = false
    @Published var model = DaemonConstants.modelOptions[0].id
    @Published var effort = EffortLevel.high
    @Published var permissionMode = PermissionMode.acceptEdits
    @Published var pendingPermission: PendingPermission?
    @Published var toolResults: [String: ToolResultState] = [:]

    let workspacePath: String
    let historySessionId: String?
    let turnStream = TurnStream()

    private weak var app: AppState?
    private var liveSessionId: String?
    private var unbind: (() -> Void)?
    private var modelOptions = DaemonConstants.modelOptions

    init(workspacePath: String, historySessionId: String?) {
        self.workspacePath = workspacePath
        self.historySessionId = historySessionId
        liveSessionId = historySessionId
        turnStream.onPatch = { [weak self] id, blocks, metrics, model, streaming in
            self?.patchAssistant(id: id, blocks: blocks, metrics: metrics, model: model, streaming: streaming)
        }
    }

    func attach(app: AppState) {
        self.app = app
        let opts = ChatSessionRouting.chatNotifyBindOptions(liveSessionId: liveSessionId)
        unbind = app.router.bind(
            acceptAny: opts.acceptAny,
            sessionIds: opts.sessionIds,
            handlers: StreamHandlers(
                onSdkEvent: { [weak self] msg, meta in
                    self?.handleSdk(msg, meta: meta)
                },
                onStatus: { [weak self] st, err, meta in
                    self?.handleStatus(st, err: err, meta: meta)
                },
                onPermission: { [weak self] p in
                    self?.pendingPermission = PendingPermission(
                        id: p.requestId,
                        sessionId: p.sessionId,
                        requestId: p.requestId,
                        toolName: p.toolName,
                        input: p.input
                    )
                },
                onInit: { [weak self] info, meta in
                    self?.handleInit(info, meta: meta)
                }
            )
        )
        Task { await bootstrap() }
    }

    func detach() {
        unbind?()
        unbind = nil
        turnStream.reset()
    }

    private func bootstrap() async {
        guard let client = app?.client else { return }
        await checkTrust(client: client)
        guard trusted else { return }
        await loadSettings(client: client)
        await loadHistory(client: client)
        if let sid = historySessionId {
            struct Attach: Decodable { let attached: Bool; let sessionId: String?; let status: String? }
            if let r = try? await client.callDecodable(Attach.self, method: "session.attachIfLive", params: ["sessionId": sid]),
               r.attached {
                liveSessionId = r.sessionId ?? sid
                if ChatSessionRouting.liveTurnIsBusy(status: r.status) {
                    busy = true
                    _ = turnStream.beginTurn()
                }
            }
        }
    }

    private func loadSettings(client: DaemonClient) async {
        struct Wrap: Decodable { let settings: DaemonSettings }
        if let w = try? await client.callDecodable(Wrap.self, method: "settings.get", params: [:]) {
            modelOptions = DaemonConstants.modelOptions(from: w.settings)
            if let m = w.settings.models.default { model = m }
            if let e = w.settings.effortLevel { effort = e }
            if let pm = w.settings.permissions.defaultMode { permissionMode = pm }
        }
    }

    private func loadHistory(client: DaemonClient) async {
        struct Wrap: Decodable { let messages: [JSONValue] }
        guard let sid = historySessionId else { return }
        guard let w = try? await client.callDecodable(
            Wrap.self,
            method: "history.loadSession",
            params: ["sessionId": sid, "workspacePath": workspacePath]
        ) else { return }
        // Simplified: show user/assistant text from entries
        for entry in w.messages {
            guard let o = entry.objectValue, let type = o["type"]?.stringValue else { continue }
            if type == "user", let text = userText(from: o) {
                messages.append(ChatMessage(
                    id: o["uuid"]?.stringValue ?? UUID().uuidString,
                    role: "user",
                    content: .plain(text),
                    streaming: false
                ))
            }
        }
    }

    private func userText(from o: [String: JSONValue]) -> String? {
        guard let msg = o["message"]?.objectValue else { return nil }
        if let s = msg["content"]?.stringValue { return s }
        if let arr = msg["content"]?.arrayValue {
            return arr.compactMap { $0.objectValue?["text"]?.stringValue }.joined()
        }
        return nil
    }

    func checkTrust(client: DaemonClient) async {
        struct Wrap: Decodable { let trusted: Bool; let path: String; let parent: String }
        if let w = try? await client.callDecodable(Wrap.self, method: "workspace.checkTrust", params: ["path": workspacePath]) {
            trusted = w.trusted
            if !w.trusted {
                trustPrompt = TrustPrompt(path: w.path, parent: w.parent)
            }
        }
    }

    func trust(path: String) async {
        guard let client = app?.client else { return }
        _ = try? await client.call(method: "workspace.add", params: ["path": path])
        SessionListService.clearCache()
        trusted = true
        trustPrompt = nil
    }

    func send() async {
        guard trusted, !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let client = app?.client, client.phase == .connected, !busy else { return }
        let text = inputText
        inputText = ""
        busy = true
        statusText = "running"
        let turnMsgId = turnStream.beginTurn()
        messages.append(ChatMessage(id: "u-\(Int(Date().timeIntervalSince1970 * 1000))", role: "user", content: .plain(text), streaming: false))
        _ = turnMsgId
        do {
            let sid = try await ensureSession(client: client)
            _ = try await client.call(method: "session.sendMessage", params: ["sessionId": sid, "content": text])
        } catch {
            statusText = error.localizedDescription
            busy = false
            turnStream.endTurn()
        }
    }

    func stop() async {
        guard let client = app?.client, let sid = liveSessionId else { return }
        _ = try? await client.call(method: "session.interrupt", params: ["sessionId": sid])
        turnStream.endTurn()
        busy = false
        statusText = "已停止"
    }

    func respondPermission(allow: Bool) async {
        guard let client = app?.client, let p = pendingPermission else { return }
        let behavior = allow ? "allow" : "deny"
        _ = try? await client.call(method: "permission.respond", params: [
            "sessionId": p.sessionId,
            "requestId": p.requestId,
            "behavior": behavior,
        ])
        pendingPermission = nil
    }

    func setPermissionMode(_ mode: PermissionMode) async {
        permissionMode = mode
        guard let client = app?.client, let sid = liveSessionId else { return }
        _ = try? await client.call(method: "session.setPermissionMode", params: ["sessionId": sid, "mode": mode.rawValue])
    }

    func applyModel(_ next: String) async {
        model = next
        if let disk = historySessionId, !busy {
            await resumeLive(sessionId: disk, model: next, effort: nil)
        }
    }

    func applyEffort(_ next: EffortLevel) async {
        effort = next
        if let disk = historySessionId, !busy {
            await resumeLive(sessionId: disk, model: nil, effort: next)
        }
    }

    private func ensureSession(client: DaemonClient) async throws -> String {
        if let sid = liveSessionId {
            _ = try? await client.call(method: "session.attach", params: ["sessionId": sid])
            return sid
        }
        struct Create: Decodable { let sessionId: String }
        let created = try await client.callDecodable(
            Create.self,
            method: "session.create",
            params: [
                "cwd": workspacePath,
                "model": model,
                "effort": effort.rawValue,
                "permissionMode": permissionMode.rawValue,
                "settingSources": ["user", "project"],
            ]
        )
        liveSessionId = created.sessionId
        if ChatSessionRouting.shouldReplaceChatUrlFromInit(historySessionId: historySessionId) {
            // URL canonicalization N/A in native; keep live id
        }
        _ = try await client.call(method: "session.attach", params: ["sessionId": created.sessionId])
        return created.sessionId
    }

    private func resumeLive(sessionId: String, model: String?, effort: EffortLevel?) async {
        guard let client = app?.client else { return }
        var params: [String: Any] = [
            "sessionId": sessionId,
            "cwd": workspacePath,
            "permissionMode": permissionMode.rawValue,
        ]
        if let model { params["model"] = model }
        if let effort { params["effort"] = effort.rawValue }
        struct Resume: Decodable { let sessionId: String }
        if let r = try? await client.callDecodable(Resume.self, method: "session.resume", params: params) {
            liveSessionId = r.sessionId
            _ = try? await client.call(method: "session.attach", params: ["sessionId": r.sessionId])
        }
    }

    private func handleSdk(_ msg: JSONValue, meta: StreamEventMeta) {
        guard matches(meta) else { return }
        turnStream.onSdkEvent(msg)
        toolResults = turnStream.toolResults
    }

    private func handleStatus(_ st: String, err: String?, meta: StreamEventMeta) {
        guard matches(meta) else { return }
        statusText = err ?? st
        if st == "completed" || st == "error" {
            busy = false
            turnStream.endTurn()
        }
        if st == "running" { busy = true }
    }

    private func handleInit(_ info: InitInfo, meta: StreamEventMeta) {
        if let sid = info.sessionId {
            liveSessionId = sid
        }
        if let m = info.model { model = m }
    }

    private func matches(_ meta: StreamEventMeta) -> Bool {
        let ids = [meta.sessionId, meta.runtimeId, meta.sdkSessionId, liveSessionId ?? ""].filter { !$0.isEmpty }
        if liveSessionId == nil { return true }
        return ids.contains(where: { $0 == liveSessionId })
    }

    private func patchAssistant(id: String, blocks: [MessageBlock], metrics: MessageMetrics?, model: String?, streaming: Bool) {
        if let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].content = .blocks(blocks)
            messages[idx].streaming = streaming
            messages[idx].metrics = metrics
            messages[idx].model = model
        } else {
            messages.append(ChatMessage(
                id: id,
                role: "assistant",
                content: .blocks(blocks),
                streaming: streaming,
                model: model,
                metrics: metrics
            ))
        }
        toolResults = turnStream.toolResults
    }
}