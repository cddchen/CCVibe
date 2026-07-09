import Foundation
import SwiftUI

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
    @Published private(set) var allMessages: [ChatMessage] = []
    @Published var visibleMessages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var trusted = false
    @Published var trustPrompt: TrustPrompt?
    @Published var statusText = ""
    @Published var runState: SessionRunState = .completed
    @Published var model = DaemonConstants.modelOptions[0].id
    @Published var customModel = ""
    @Published var sidebarOpen = ChatPreferences.readBool(ChatPreferences.chatSidebarOpenKey, fallback: true)
    @Published var followOutput = ChatPreferences.readBool(ChatPreferences.chatFollowOutputKey, fallback: true)
    @Published var effort = EffortLevel.high
    @Published var permissionMode = PermissionMode.acceptEdits
    @Published var pendingPermission: PendingPermission?
    @Published var permissionUpdatedInput = "{}"
    @Published var permissionDenyMessage = ""
    @Published var permissionError: String?
    @Published var askSelections: [[String]] = []
    @Published var toolResults: [String: ToolResultState] = [:]
    @Published var sessionGroups: [SessionGroup] = []
    @Published var sidebarExpanded: [String: Bool] = DirectoryExpansionStore.read()
    @Published var activeMap: [String: ActiveKind] = [:]
    @Published var liveSessionId: String?

    /// Empty when route is home (no conversation selected).
    @Published private(set) var workspacePath: String = ""
    @Published private(set) var historySessionId: String?
    /// True only after user opens a session or starts a new chat from a workspace.
    @Published private(set) var hasActiveConversation = false
    let turnStream = TurnStream()

    private weak var app: AppState?
    private var unbind: (() -> Void)?
    private var modelOptions = DaemonConstants.modelOptions
    private var historyToolResults: [String: ToolResultState] = [:]
    private var aliasIds: Set<String> = []
    private var hydratedSessionId: String?
    private var switchGeneration = 0
    private let pageSize = 80

    init() {
        turnStream.onPatch = { [weak self] id, blocks, metrics, model, streaming in
            self?.patchAssistant(id: id, blocks: blocks, metrics: metrics, model: model, streaming: streaming)
        }
    }

    /// Apply app route without remounting the chat shell.
    func applyRoute(_ route: AppRoute) {
        switch route {
        case .home:
            clearToHome()
        case .chat(let path, let sessionId):
            switchTo(workspacePath: path, sessionId: sessionId)
        }
    }

    /// In-place session/workspace switch without remounting the chat shell (sidebar/input stay mounted).
    func switchTo(workspacePath: String, sessionId: String?) {
        let path = workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            clearToHome()
            return
        }

        let sameWorkspace = self.workspacePath == path
        if sameWorkspace && hasActiveConversation {
            if sessionId == historySessionId {
                // Same explicit selection (including both-nil "new chat" for this workspace).
                if sessionId != nil || liveSessionId == nil {
                    return
                }
            }
            // Route sync after create/resume: keep the in-flight transcript.
            if let sessionId, sessionId == liveSessionId || aliasIds.contains(sessionId) {
                if historySessionId != sessionId {
                    historySessionId = sessionId
                }
                return
            }
            if sessionId == nil, historySessionId == nil, liveSessionId == nil {
                return
            }
        }

        prepareConversationSwitch(workspacePath: path, sessionId: sessionId)
        guard let app else { return }
        bindNotifications(app: app)
        let generation = switchGeneration
        Task { await self.loadAfterSwitch(generation: generation) }
    }

    func clearToHome() {
        guard hasActiveConversation || !workspacePath.isEmpty || historySessionId != nil || liveSessionId != nil || !allMessages.isEmpty else {
            return
        }
        prepareConversationSwitch(workspacePath: "", sessionId: nil)
        hasActiveConversation = false
        trusted = false
        trustPrompt = nil
        unbind?()
        unbind = nil
    }

    var busy: Bool {
        runState == .running
    }

    var availableModelOptions: [ModelOption] {
        let base = modelOptions
        if customModel.isEmpty || base.contains(where: { $0.id == customModel }) {
            return base
        }
        return base + [ModelOption(id: customModel, label: customModel)]
    }

    var askQuestion: AskUserQuestionPayload? {
        pendingPermission?.toolName == "AskUserQuestion" ? AskUserQuestionEngine.parse(pendingPermission?.input) : nil
    }

    func attach(app: AppState) {
        self.app = app
        Task { await bootstrapShell() }
    }

    func detach() {
        unbind?()
        unbind = nil
        turnStream.reset()
    }

    func refreshAfterReconnect() {
        guard let client = app?.client, client.phase == .connected else { return }
        Task {
            await refreshSessionList(client: client)
            await refreshActiveSessions(client: client)
            if hasActiveConversation, let historySessionId {
                await syncLiveAttach(client: client, diskSessionId: historySessionId)
            }
        }
    }

    func loadMoreHistory() {
        guard visibleMessages.count < allMessages.count else { return }
        let nextCount = min(allMessages.count, visibleMessages.count + pageSize)
        visibleMessages = Array(allMessages.suffix(nextCount))
    }

    func toggleSidebar() {
        sidebarOpen.toggle()
        ChatPreferences.writeBool(ChatPreferences.chatSidebarOpenKey, value: sidebarOpen)
    }

    func setSidebarOpen(_ open: Bool) {
        sidebarOpen = open
        ChatPreferences.writeBool(ChatPreferences.chatSidebarOpenKey, value: open)
    }

    func toggleFollowOutput() {
        followOutput.toggle()
        ChatPreferences.writeBool(ChatPreferences.chatFollowOutputKey, value: followOutput)
    }

    func toggleSidebarGroup(path: String) {
        let open = DirectoryExpansionStore.isExpanded(path: path, prefs: sidebarExpanded)
        sidebarExpanded[path] = !open
        DirectoryExpansionStore.write(sidebarExpanded)
    }

    func checkTrust(client: DaemonClient) async {
        guard hasActiveConversation, !workspacePath.isEmpty else {
            trusted = false
            trustPrompt = nil
            return
        }
        struct Wrap: Decodable { let trusted: Bool; let path: String; let parent: String }
        do {
            let trust = try await client.callDecodable(Wrap.self, method: "workspace.checkTrust", params: ["path": workspacePath])
            trusted = trust.trusted
            trustPrompt = trust.trusted ? nil : TrustPrompt(path: trust.path, parent: trust.parent)
        } catch {
            statusText = error.localizedDescription
        }
    }

    func trust(path: String) async {
        guard let client = app?.client else { return }
        do {
            _ = try await client.call(method: "workspace.add", params: ["path": path])
            SessionListService.clearCache()
            trusted = true
            trustPrompt = nil
            await refreshSessionList(client: client)
            await loadSettings(client: client)
            await loadHistory(client: client)
            if let historySessionId {
                await syncLiveAttach(client: client, diskSessionId: historySessionId)
            }
        } catch {
            statusText = error.localizedDescription
        }
    }

    func send() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hasActiveConversation, trusted, !text.isEmpty, let client = app?.client, client.phase == .connected, !busy else { return }

        inputText = ""
        statusText = "running"
        runState = .running
        _ = turnStream.beginTurn()
        appendMessage(ChatMessage(id: "u-\(Int(Date().timeIntervalSince1970 * 1000))", role: "user", content: .plain(text), streaming: false))

        do {
            var sid = try await ensureSession(client: client)
            do {
                _ = try await client.call(method: "session.sendMessage", params: ["sessionId": sid, "content": text])
            } catch {
                let msg = error.localizedDescription
                if !msg.contains("unknown session") || historySessionId == nil {
                    throw error
                }
                sid = try await resumeLive(sessionId: historySessionId!, model: nil, effort: nil)
                _ = try await client.call(method: "session.sendMessage", params: ["sessionId": sid, "content": text])
            }
        } catch {
            statusText = error.localizedDescription
            runState = .error
            turnStream.endTurn()
        }
    }

    func stop() async {
        guard let client = app?.client, let sid = liveSessionId else { return }
        do {
            _ = try await client.call(method: "session.interrupt", params: ["sessionId": sid])
            turnStream.endTurn()
            runState = .interrupted
            statusText = "已停止"
        } catch {
            statusText = error.localizedDescription
        }
    }

    func respondPermissionAllow() async {
        guard let client = app?.client, let permission = pendingPermission else { return }
        do {
            let params = try PermissionResponses.buildPermissionRespondParams(
                request: permission,
                behavior: "allow",
                updatedInputText: permissionUpdatedInput,
                denyMessage: permissionDenyMessage
            )
            _ = try await client.call(method: "permission.respond", params: params)
            clearPermissionState()
        } catch {
            permissionError = error.localizedDescription
        }
    }

    func respondPermissionDeny() async {
        guard let client = app?.client, let permission = pendingPermission else { return }
        do {
            let params = try PermissionResponses.buildPermissionRespondParams(
                request: permission,
                behavior: "deny",
                updatedInputText: permissionUpdatedInput,
                denyMessage: permissionDenyMessage
            )
            _ = try await client.call(method: "permission.respond", params: params)
            clearPermissionState()
        } catch {
            permissionError = error.localizedDescription
        }
    }

    func toggleAskSelection(questionIndex: Int, label: String, multiSelect: Bool) {
        askSelections = AskUserQuestionEngine.toggleSelection(
            selections: askSelections,
            questionIndex: questionIndex,
            label: label,
            multiSelect: multiSelect
        )
    }

    func respondAskAllow() async {
        guard let client = app?.client,
              let permission = pendingPermission,
              let ask = askQuestion,
              AskUserQuestionEngine.allQuestionsAnswered(ask, selections: askSelections) else { return }
        do {
            let updatedInput = AskUserQuestionEngine.buildUpdatedInput(ask, selections: askSelections)
            _ = try await client.call(method: "permission.respond", params: [
                "sessionId": permission.sessionId,
                "requestId": permission.requestId,
                "behavior": "allow",
                "updatedInput": updatedInput.mapValues { $0.toFoundationValue() },
            ])
            clearPermissionState()
        } catch {
            permissionError = error.localizedDescription
        }
    }

    func respondAskDeny() async {
        guard let client = app?.client, let permission = pendingPermission else { return }
        do {
            _ = try await client.call(method: "permission.respond", params: [
                "sessionId": permission.sessionId,
                "requestId": permission.requestId,
                "behavior": "deny",
                "message": "用户取消了问题",
            ])
            clearPermissionState()
        } catch {
            permissionError = error.localizedDescription
        }
    }

    func setPermissionMode(_ next: PermissionMode) async {
        permissionMode = next
        guard let client = app?.client, let sid = liveSessionId else { return }
        do {
            _ = try await client.call(method: "session.setPermissionMode", params: ["sessionId": sid, "mode": next.rawValue])
        } catch {
            statusText = error.localizedDescription
        }
    }

    func applyModel(_ next: String) async {
        model = next
        if let historySessionId, !busy {
            do {
                _ = try await resumeLive(sessionId: historySessionId, model: next, effort: nil)
            } catch {
                statusText = error.localizedDescription
            }
        }
    }

    func applyEffort(_ next: EffortLevel) async {
        effort = next
        if let historySessionId, !busy {
            do {
                _ = try await resumeLive(sessionId: historySessionId, model: nil, effort: next)
            } catch {
                statusText = error.localizedDescription
            }
        }
    }

    func openSession(workspacePath: String, sessionId: String?) {
        // Switch locally first so the transcript updates immediately; then sync app route.
        switchTo(workspacePath: workspacePath, sessionId: sessionId)
        app?.openChat(workspacePath: workspacePath, sessionId: sessionId)
    }

    private func prepareConversationSwitch(workspacePath: String, sessionId: String?) {
        switchGeneration += 1
        unbind?()
        unbind = nil
        turnStream.reset()

        allMessages = []
        visibleMessages = []
        toolResults = [:]
        historyToolResults = [:]
        pendingPermission = nil
        permissionUpdatedInput = "{}"
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
        statusText = ""
        runState = .completed
        liveSessionId = sessionId
        hydratedSessionId = nil
        aliasIds.removeAll()
        if let sessionId {
            aliasIds.insert(sessionId)
        }

        self.workspacePath = workspacePath
        self.historySessionId = sessionId
        hasActiveConversation = !workspacePath.isEmpty
        trusted = false
        trustPrompt = nil
        // Intentional session changes clear the composer for a clean context.
        inputText = ""
    }

    private func loadAfterSwitch(generation: Int) async {
        guard let client = app?.client, generation == switchGeneration else { return }
        await loadSettings(client: client)
        guard generation == switchGeneration else { return }
        await checkTrust(client: client)
        guard generation == switchGeneration, trusted else { return }
        await loadHistory(client: client)
        guard generation == switchGeneration else { return }
        if let historySessionId {
            await syncLiveAttach(client: client, diskSessionId: historySessionId)
        }
    }

    private func bootstrapShell() async {
        guard let client = app?.client else { return }
        await refreshSessionList(client: client)
        await refreshActiveSessions(client: client)
        await loadSettings(client: client)
        // Apply current route after shell data is ready (home = empty detail).
        if let route = app?.route {
            applyRoute(route)
        }
    }

    private func bindNotifications(app: AppState) {
        guard hasActiveConversation else {
            unbind?()
            unbind = nil
            return
        }
        let opts = ChatSessionRouting.chatNotifyBindOptions(liveSessionId: liveSessionId)
        unbind = app.router.bind(
            acceptAny: opts.acceptAny,
            sessionIds: opts.sessionIds,
            handlers: StreamHandlers(
                onSdkEvent: { [weak self] msg, meta in self?.handleSdk(msg, meta: meta) },
                onStatus: { [weak self] status, err, meta in self?.handleStatus(status, err: err, meta: meta) },
                onPermission: { [weak self] permission in self?.handlePermission(permission) },
                onInit: { [weak self] info, meta in self?.handleInit(info, meta: meta) }
            )
        )
    }

    private func loadSettings(client: DaemonClient) async {
        struct Wrap: Decodable { let settings: DaemonSettings }
        do {
            let wrap = try await client.callDecodable(Wrap.self, method: "settings.get", params: [:])
            modelOptions = DaemonConstants.modelOptions(from: wrap.settings)
            if let model = wrap.settings.models.default {
                self.model = model
                if !modelOptions.contains(where: { $0.id == model }) {
                    customModel = model
                }
            }
            if let effort = wrap.settings.effortLevel {
                self.effort = effort
            }
            if let mode = wrap.settings.permissions.defaultMode {
                permissionMode = mode
            }
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func loadHistory(client: DaemonClient) async {
        guard hasActiveConversation, let historySessionId, hydratedSessionId != historySessionId else { return }
        struct Wrap: Decodable { let messages: [HistoryJsonlEntry] }
        do {
            statusText = "加载会话…"
            let wrap = try await client.callDecodable(
                Wrap.self,
                method: "history.loadSession",
                params: ["sessionId": historySessionId, "workspacePath": workspacePath]
            )
            historyToolResults = MessageBlocksEngine.buildToolResultsFromHistory(wrap.messages)
            toolResults = historyToolResults
            allMessages = MessageBlocksEngine.historyEntriesToChatMessages(wrap.messages)
            visibleMessages = Array(allMessages.suffix(pageSize))
            hydratedSessionId = historySessionId
            statusText = ""

            if let lastAssistant = allMessages.last(where: { $0.role == "assistant" }),
               let lastModel = lastAssistant.model,
               !modelOptions.contains(where: { $0.id == lastModel }) {
                customModel = lastModel
                model = lastModel
            }
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func syncLiveAttach(client: DaemonClient, diskSessionId: String) async {
        struct Attach: Decodable { let attached: Bool; let sessionId: String?; let status: String? }
        do {
            let result = try await client.callDecodable(Attach.self, method: "session.attachIfLive", params: ["sessionId": diskSessionId])
            if result.attached, let sessionId = result.sessionId {
                liveSessionId = sessionId
                registerAliases([diskSessionId, sessionId])
                runState = runStateFromDaemonStatus(result.status)
            } else {
                runState = .completed
            }
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func refreshSessionList(client: DaemonClient) async {
        do {
            let data = try await SessionListService.load(client: client, force: true)
            sessionGroups = CCAgent.sessionGroups(from: data)
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func refreshActiveSessions(client: DaemonClient) async {
        struct ActiveListResponse: Decodable { let sessions: [ActiveSessionRow] }
        do {
            let result = try await client.callDecodable(ActiveListResponse.self, method: "session.listActive", params: [:])
            activeMap = mapActiveSessions(result.sessions)
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func ensureSession(client: DaemonClient) async throws -> String {
        let diskId = liveSessionId ?? historySessionId
        if let diskId {
            do {
                _ = try await client.call(method: "session.attach", params: ["sessionId": diskId])
                registerAliases([diskId])
                return diskId
            } catch {
                if let historySessionId {
                    return try await resumeLive(sessionId: historySessionId, model: nil, effort: nil)
                }
                throw error
            }
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
        hydratedSessionId = created.sessionId
        registerAliases([created.sessionId])
        app?.openChat(workspacePath: workspacePath, sessionId: created.sessionId)
        _ = try await client.call(method: "session.attach", params: ["sessionId": created.sessionId])
        return created.sessionId
    }

    private func resumeLive(sessionId: String, model: String?, effort: EffortLevel?) async throws -> String {
        guard let client = app?.client else { throw JSONRPCClientError.notConnected }
        var params: [String: Any] = [
            "sessionId": sessionId,
            "cwd": workspacePath,
            "permissionMode": permissionMode.rawValue,
        ]
        if let model { params["model"] = model }
        if let effort { params["effort"] = effort.rawValue }
        struct Resume: Decodable { let sessionId: String }
        let resumed = try await client.callDecodable(Resume.self, method: "session.resume", params: params)
        liveSessionId = resumed.sessionId
        registerAliases([sessionId, resumed.sessionId])
        _ = try await client.call(method: "session.attach", params: ["sessionId": resumed.sessionId])
        return resumed.sessionId
    }

    private func handlePermission(_ permission: PermissionRequest) {
        guard matches(meta: StreamEventMeta(sessionId: permission.sessionId, runtimeId: "", sdkSessionId: "")) else { return }
        let pending = PendingPermission(
            id: permission.requestId,
            sessionId: permission.sessionId,
            requestId: permission.requestId,
            toolName: permission.toolName,
            input: permission.input
        )
        pendingPermission = pending
        permissionUpdatedInput = PermissionResponses.permissionInputText(permission.input)
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
    }

    private func clearPermissionState() {
        pendingPermission = nil
        permissionUpdatedInput = "{}"
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
    }

    private func handleSdk(_ msg: JSONValue, meta: StreamEventMeta) {
        guard matches(meta: meta) else { return }
        turnStream.onSdkEvent(msg)
        toolResults = historyToolResults.merging(turnStream.toolResults) { _, new in new }
    }

    private func handleStatus(_ status: String, err: String?, meta: StreamEventMeta) {
        guard matches(meta: meta) else { return }
        statusText = err ?? status
        runState = runStateFromDaemonStatus(status)
        if runState != .running {
            turnStream.endTurn()
            Task { [weak self] in
                guard let self, let client = self.app?.client else { return }
                await self.refreshSessionList(client: client)
                await self.refreshActiveSessions(client: client)
            }
        }
    }

    private func handleInit(_ info: InitInfo, meta: StreamEventMeta) {
        if let sessionId = info.sessionId {
            liveSessionId = sessionId
            registerAliases([sessionId, meta.sessionId, meta.runtimeId, meta.sdkSessionId])
        }
        if let model = info.model {
            self.model = model
        }
    }

    private func matches(meta: StreamEventMeta) -> Bool {
        let ids = [meta.sessionId, meta.runtimeId, meta.sdkSessionId].filter { !$0.isEmpty }
        if ids.isEmpty { return liveSessionId == nil }
        if aliasIds.isEmpty { return true }
        return ids.contains(where: { aliasIds.contains($0) })
    }

    private func registerAliases(_ ids: [String]) {
        for id in ids where !id.isEmpty {
            aliasIds.insert(id)
        }
    }

    private func patchAssistant(id: String, blocks: [MessageBlock], metrics: MessageMetrics?, model: String?, streaming: Bool) {
        let mergedToolResults = historyToolResults.merging(turnStream.toolResults) { _, new in new }
        if let index = allMessages.firstIndex(where: { $0.id == id }) {
            allMessages[index].content = .blocks(blocks)
            allMessages[index].streaming = streaming
            allMessages[index].metrics = metrics
            allMessages[index].model = model
        } else {
            allMessages.append(ChatMessage(
                id: id,
                role: "assistant",
                content: .blocks(blocks),
                streaming: streaming,
                model: model,
                metrics: metrics
            ))
        }
        visibleMessages = Array(allMessages.suffix(max(pageSize, visibleMessages.count)))
        toolResults = mergedToolResults
    }

    private func appendMessage(_ message: ChatMessage) {
        allMessages.append(message)
        visibleMessages = Array(allMessages.suffix(max(pageSize, visibleMessages.count)))
    }
}
