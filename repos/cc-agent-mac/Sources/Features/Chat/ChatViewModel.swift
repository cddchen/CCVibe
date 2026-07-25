import Foundation
import SwiftUI

struct TrustPrompt: Identifiable {
    let id = UUID()
    let path: String
    let parent: String
}

struct PendingPermission: Identifiable {
    let id: String
    let conversationId: String
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
    @Published private(set) var streamTick = 0
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
    @Published private(set) var workspacePath = ""
    @Published private(set) var historySessionId: String?
    @Published private(set) var hasActiveConversation = false

    private weak var app: AppState?
    private var unbind: (() -> Void)?
    private var modelOptions = DaemonConstants.modelOptions
    private var conversationMessages: [ConversationMessage] = []
    private var aliasIds: Set<String> = []
    private var hydratedKey: String?
    private var switchGeneration = 0
    private var lastSequence = 0
    private var sequenceRuntimeId: String?
    private let pageSize = 80
    private var parkedPermissions: [String: PendingPermission] = [:]
    private var parkedPermissionUpdatedInput: [String: String] = [:]
    private var pendingTurn: PendingTurnFeedback?

    func applyRoute(_ route: AppRoute) {
        switch route {
        case .home:
            clearToHome()
        case .chat(let path, let sessionId):
            switchTo(workspacePath: path, sessionId: sessionId)
        }
    }

    func switchTo(workspacePath: String, sessionId: String?) {
        let path = workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { clearToHome(); return }
        if self.workspacePath == path, hasActiveConversation {
            if sessionId == historySessionId { return }
            if let sessionId, sessionId == liveSessionId || aliasIds.contains(sessionId) {
                historySessionId = sessionId
                return
            }
        }

        let previous = liveSessionId
        prepareConversationSwitch(workspacePath: path, sessionId: sessionId)
        guard let app else { return }
        bindNotifications(app: app)
        let generation = switchGeneration
        Task {
            await detachConversation(client: app.client, conversationId: previous)
            guard generation == self.switchGeneration else { return }
            await self.loadAfterSwitch(generation: generation)
        }
    }

    func clearToHome() {
        let previous = liveSessionId
        prepareConversationSwitch(workspacePath: "", sessionId: nil)
        hasActiveConversation = false
        trusted = false
        trustPrompt = nil
        if let app { bindNotifications(app: app) }
        if let client = app?.client { Task { await self.detachConversation(client: client, conversationId: previous) } }
    }

    var busy: Bool { runState == .running }

    var availableModelOptions: [ModelOption] {
        if customModel.isEmpty || modelOptions.contains(where: { $0.id == customModel }) { return modelOptions }
        return modelOptions + [ModelOption(id: customModel, label: customModel)]
    }

    var askQuestion: AskUserQuestionPayload? {
        pendingPermission?.toolName == "AskUserQuestion" ? AskUserQuestionEngine.parse(pendingPermission?.input) : nil
    }

    func attach(app: AppState) {
        self.app = app
        Task { await bootstrapShell() }
    }

    func detach() {
        let previous = liveSessionId
        unbind?()
        unbind = nil
        if let client = app?.client { Task { await self.detachConversation(client: client, conversationId: previous) } }
    }

    func refreshAfterReconnect() {
        guard let client = app?.client, client.phase == .connected else { return }
        hydratedKey = nil
        Task {
            await refreshSessionList(client: client)
            await refreshActiveSessions(client: client)
            if hasActiveConversation, trusted { _ = try? await openConversation(client: client) }
        }
    }

    func loadMoreHistory() {
        guard visibleMessages.count < allMessages.count else { return }
        visibleMessages = Array(allMessages.suffix(min(allMessages.count, visibleMessages.count + pageSize)))
    }

    func toggleSidebar() {
        sidebarOpen.toggle()
        ChatPreferences.writeBool(ChatPreferences.chatSidebarOpenKey, value: sidebarOpen)
    }

    func setSidebarOpen(_ open: Bool) {
        sidebarOpen = open
        ChatPreferences.writeBool(ChatPreferences.chatSidebarOpenKey, value: open)
    }

    func toggleSidebarGroup(path: String) {
        let open = DirectoryExpansionStore.isExpanded(path: path, prefs: sidebarExpanded)
        sidebarExpanded[path] = !open
        DirectoryExpansionStore.write(sidebarExpanded)
    }

    func checkTrust(client: DaemonClient) async {
        guard hasActiveConversation, !workspacePath.isEmpty else { trusted = false; trustPrompt = nil; return }
        struct Wrap: Decodable { let trusted: Bool; let path: String; let parent: String }
        do {
            let trust = try await client.callDecodable(Wrap.self, method: "workspace.checkTrust", params: ["path": workspacePath])
            trusted = trust.trusted
            trustPrompt = trust.trusted ? nil : TrustPrompt(path: trust.path, parent: trust.parent)
        } catch { statusText = error.localizedDescription }
    }

    func trust(path: String) async {
        guard let client = app?.client else { return }
        do {
            _ = try await client.call(method: "workspace.add", params: ["path": path])
            SessionListService.clearCache()
            trusted = true
            trustPrompt = nil
            await refreshSessionList(client: client)
            _ = try await openConversation(client: client)
        } catch { statusText = error.localizedDescription }
    }

    func send() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hasActiveConversation, trusted, !text.isEmpty, let client = app?.client, client.phase == .connected, !busy else { return }
        let clientMessageId = UUID().uuidString
        inputText = ""
        statusText = "running"
        runState = .running
        pendingTurn = PendingTurnFeedback(clientMessageId: clientMessageId, content: text, turnId: nil)
        rebuildTranscript()
        do {
            let conversationId = try await ensureConversation(client: client)
            struct SendReceipt: Decodable { let turnId: String }
            let receipt = try await client.callDecodable(SendReceipt.self, method: "conversation.send", params: [
                "conversationId": conversationId,
                "content": text,
                "clientMessageId": clientMessageId,
            ])
            if let current = pendingTurn, current.clientMessageId == clientMessageId {
                pendingTurn = PendingTurnFeedback(clientMessageId: current.clientMessageId, content: current.content, turnId: receipt.turnId)
                rebuildTranscript()
            }
        } catch {
            pendingTurn = nil
            statusText = error.localizedDescription
            runState = .error
            rebuildTranscript()
        }
    }

    func stop() async {
        guard let client = app?.client, let conversationId = liveSessionId else { return }
        do {
            _ = try await client.call(method: "conversation.interrupt", params: ["conversationId": conversationId])
            runState = .interrupted
            statusText = "已停止"
        } catch { statusText = error.localizedDescription }
    }

    func respondPermissionAllow() async { await respondPermission(behavior: "allow") }
    func respondPermissionDeny() async { await respondPermission(behavior: "deny") }

    private func respondPermission(behavior: String) async {
        guard let client = app?.client, let permission = pendingPermission else { return }
        do {
            let params = try PermissionResponses.buildPermissionRespondParams(
                request: permission,
                behavior: behavior,
                updatedInputText: permissionUpdatedInput,
                denyMessage: permissionDenyMessage
            )
            _ = try await client.call(method: "permission.respond", params: params)
            clearPermissionState(ifMatching: permission)
        } catch {
            if pendingPermission?.id == permission.id { permissionError = error.localizedDescription }
        }
    }

    func toggleAskSelection(questionIndex: Int, label: String, multiSelect: Bool) {
        askSelections = AskUserQuestionEngine.toggleSelection(selections: askSelections, questionIndex: questionIndex, label: label, multiSelect: multiSelect)
    }

    func respondAskAllow() async {
        guard let client = app?.client, let permission = pendingPermission, let ask = askQuestion,
              AskUserQuestionEngine.allQuestionsAnswered(ask, selections: askSelections) else { return }
        do {
            let updatedInput = AskUserQuestionEngine.buildUpdatedInput(ask, selections: askSelections)
            _ = try await client.call(method: "permission.respond", params: [
                "conversationId": permission.conversationId,
                "requestId": permission.requestId,
                "behavior": "allow",
                "updatedInput": updatedInput.mapValues { $0.toFoundationValue() },
            ])
            clearPermissionState(ifMatching: permission)
        } catch {
            if pendingPermission?.id == permission.id { permissionError = error.localizedDescription }
        }
    }

    func respondAskDeny() async {
        guard let client = app?.client, let permission = pendingPermission else { return }
        do {
            _ = try await client.call(method: "permission.respond", params: [
                "conversationId": permission.conversationId,
                "requestId": permission.requestId,
                "behavior": "deny",
                "message": "用户取消了问题",
            ])
            clearPermissionState(ifMatching: permission)
        } catch {
            if pendingPermission?.id == permission.id { permissionError = error.localizedDescription }
        }
    }

    func setPermissionMode(_ next: PermissionMode) async {
        permissionMode = next
        guard let client = app?.client, !busy else { return }
        do {
            let id = try await ensureConversation(client: client)
            _ = try await client.call(method: "conversation.setPermissionMode", params: ["conversationId": id, "mode": next.rawValue])
        } catch { statusText = error.localizedDescription }
    }

    func applyModel(_ next: String) async {
        model = next
        guard let client = app?.client, !busy else { return }
        do {
            let id = try await ensureConversation(client: client)
            _ = try await client.call(method: "conversation.setModel", params: ["conversationId": id, "model": next])
        } catch { statusText = error.localizedDescription }
    }

    func applyEffort(_ next: EffortLevel) async {
        effort = next
        guard let client = app?.client, !busy else { return }
        do {
            let id = try await ensureConversation(client: client)
            _ = try await client.call(method: "conversation.setEffort", params: ["conversationId": id, "effort": next.rawValue])
        } catch { statusText = error.localizedDescription }
    }

    func openSession(workspacePath: String, sessionId: String?) {
        switchTo(workspacePath: workspacePath, sessionId: sessionId)
        app?.openChat(workspacePath: workspacePath, sessionId: sessionId)
    }

    private func prepareConversationSwitch(workspacePath: String, sessionId: String?) {
        switchGeneration += 1
        parkCurrentPermissionIfNeeded()
        unbind?()
        unbind = nil
        conversationMessages = []
        allMessages = []
        visibleMessages = []
        toolResults = [:]
        pendingTurn = nil
        pendingPermission = nil
        permissionUpdatedInput = "{}"
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
        statusText = ""
        runState = .completed
        liveSessionId = sessionId
        hydratedKey = nil
        lastSequence = 0
        sequenceRuntimeId = nil
        aliasIds = Set(sessionId.map { [$0] } ?? [])
        self.workspacePath = workspacePath
        historySessionId = sessionId
        hasActiveConversation = !workspacePath.isEmpty
        trusted = false
        trustPrompt = nil
        inputText = ""
        presentParkedPermissionIfNeeded()
    }

    private func loadAfterSwitch(generation: Int) async {
        guard let client = app?.client, generation == switchGeneration else { return }
        await loadSettings(client: client)
        guard generation == switchGeneration else { return }
        await checkTrust(client: client)
        guard generation == switchGeneration, trusted else { return }
        do { _ = try await openConversation(client: client) }
        catch { statusText = error.localizedDescription }
    }

    private func bootstrapShell() async {
        guard let client = app?.client else { return }
        await refreshSessionList(client: client)
        await refreshActiveSessions(client: client)
        await loadSettings(client: client)
        if let route = app?.route { applyRoute(route) }
    }

    private func bindNotifications(app: AppState) {
        unbind?()
        guard hasActiveConversation else {
            unbind = nil
            return
        }
        let opts = ChatSessionRouting.chatNotifyBindOptions(sessionIds: Array(aliasIds))
        unbind = app.router.bind(acceptAny: opts.acceptAny, sessionIds: opts.sessionIds, handlers: StreamHandlers(
            onEvent: { [weak self] envelope, meta in self?.handleEvent(envelope, meta: meta) }
        ))
    }

    private func rebindNotificationsIfNeeded() {
        guard let app else { return }
        bindNotifications(app: app)
    }

    private func detachConversation(client: DaemonClient?, conversationId: String?) async {
        guard let client, let conversationId, !conversationId.isEmpty else { return }
        _ = try? await client.call(method: "conversation.detach", params: ["conversationId": conversationId])
    }

    private func loadSettings(client: DaemonClient) async {
        struct Wrap: Decodable { let settings: DaemonSettings }
        do {
            let wrap = try await client.callDecodable(Wrap.self, method: "settings.get", params: [:])
            modelOptions = DaemonConstants.modelOptions(from: wrap.settings)
            if let value = wrap.settings.models.default {
                model = value
                if !modelOptions.contains(where: { $0.id == value }) { customModel = value }
            }
            if let value = wrap.settings.effortLevel { effort = value }
            if let value = wrap.settings.permissions.defaultMode { permissionMode = value }
        } catch { statusText = error.localizedDescription }
    }

    @discardableResult
    private func openConversation(client: DaemonClient) async throws -> String {
        let key = historySessionId ?? "new:\(workspacePath)"
        if hydratedKey == key, let liveSessionId { return liveSessionId }
        statusText = historySessionId == nil ? "准备会话…" : "加载会话…"
        var params: [String: Any] = ["workspacePath": workspacePath, "subscribe": true]
        if let historySessionId { params["conversationId"] = historySessionId }
        let snapshot = try await client.callDecodable(ConversationSnapshot.self, method: "conversation.open", params: params)
        let conversationId = snapshot.conversation.id
        hydratedKey = key
        liveSessionId = conversationId
        sequenceRuntimeId = snapshot.runtime.runtimeId
        if lastSequence <= snapshot.revision {
            lastSequence = snapshot.revision
            conversationMessages = snapshot.messages
        } else {
            for message in snapshot.messages where !conversationMessages.contains(where: { $0.id == message.id }) {
                conversationMessages.append(message)
            }
        }
        registerAliases([conversationId, snapshot.conversation.sdkSessionId ?? "", snapshot.runtime.runtimeId ?? "", historySessionId ?? ""])
        runState = runStateFromDaemonStatus(snapshot.runtime.state)
        model = snapshot.config.model.requestedId
        if !modelOptions.contains(where: { $0.id == model }) { customModel = model }
        effort = snapshot.config.effort.requested
        permissionMode = snapshot.config.permissionMode
        rebuildTranscript()
        if historySessionId != conversationId {
            historySessionId = conversationId
            upsertSidebarSession(sessionId: conversationId)
            app?.openChat(workspacePath: workspacePath, sessionId: conversationId)
        }
        statusText = ""
        presentParkedPermissionIfNeeded()
        return conversationId
    }

    private func ensureConversation(client: DaemonClient) async throws -> String {
        if let liveSessionId { return liveSessionId }
        return try await openConversation(client: client)
    }

    private func refreshSessionList(client: DaemonClient) async {
        do { sessionGroups = CCAgent.sessionGroups(from: try await SessionListService.load(client: client, force: true)) }
        catch { statusText = error.localizedDescription }
    }

    private func refreshActiveSessions(client: DaemonClient) async {
        struct ActiveListResponse: Decodable { let sessions: [ActiveSessionRow] }
        do {
            let result = try await client.callDecodable(ActiveListResponse.self, method: "conversation.listActive", params: [:])
            activeMap = mapActiveSessions(result.sessions)
        } catch { statusText = error.localizedDescription }
    }

    private func handleEvent(_ envelope: ConversationEventEnvelope, meta: ConversationEventMeta) {
        guard matches(meta: meta) else { return }
        if sequenceRuntimeId != envelope.runtimeId {
            sequenceRuntimeId = envelope.runtimeId
            lastSequence = 0
        }
        guard envelope.sequence > lastSequence else { return }
        lastSequence = envelope.sequence
        let event = envelope.event
        switch event.type {
        case "message_start", "message_update", "message_end":
            if let message = event.message {
                conversationMessages = MessageBlocksEngine.upsertConversationMessage(conversationMessages, message)
                rebuildTranscript()
            }
        case "conversation_status":
            handleStatus(event.status, error: event.error)
        case "runtime_status":
            if event.status == "crashed" { handleStatus("crashed", error: event.error) }
        case "turn_status":
            if let turnId = event.turnId, let current = pendingTurn, current.turnId == nil,
               event.status == "queued" || event.status == "running" {
                pendingTurn = PendingTurnFeedback(clientMessageId: current.clientMessageId, content: current.content, turnId: turnId)
            }
            if ["completed", "failed", "limited", "interrupted"].contains(event.status ?? "") {
                pendingTurn = nil
                rebuildTranscript()
                runState = runStateFromDaemonStatus(event.status)
                Task { [weak self] in
                    guard let self, let client = self.app?.client else { return }
                    await self.refreshSessionList(client: client)
                    await self.refreshActiveSessions(client: client)
                }
            }
        case "permission_request":
            let requestId = event.requestId?.stringValue ?? event.requestId?.numberValue.map { String($0) } ?? ""
            handlePermission(PermissionRequest(
                conversationId: envelope.conversationId,
                requestId: requestId,
                toolName: event.toolName ?? "",
                input: event.input
            ))
        case "permission_resolved":
            let requestId = event.requestId?.stringValue ?? event.requestId?.numberValue.map { String($0) } ?? ""
            clearResolvedPermission(conversationId: envelope.conversationId, requestId: requestId)
        case "runtime_initialized":
            registerAliases([meta.conversationId, meta.sessionId, meta.runtimeId, event.sdkSessionId ?? ""])
            if let value = event.model { model = value }
        default:
            break
        }
    }

    private func handleStatus(_ status: String?, error: String?) {
        runState = runStateFromDaemonStatus(status)
        statusText = error ?? (status == "waiting_permission" ? "等待授权…" : status ?? "")
        if runState == .completed { statusText = "" }
    }

    private func handlePermission(_ permission: PermissionRequest) {
        let key = permissionKey(conversationId: permission.conversationId, requestId: permission.requestId)
        let pending = PendingPermission(
            id: key,
            conversationId: permission.conversationId,
            requestId: permission.requestId,
            toolName: permission.toolName,
            input: permission.input
        )
        let updatedInput = PermissionResponses.permissionInputText(permission.input)
        parkedPermissions[key] = pending
        parkedPermissionUpdatedInput[key] = updatedInput
        if isForegroundConversation(permission.conversationId) {
            if pendingPermission?.id == key {
                presentPermission(pending, updatedInput: updatedInput)
            } else if pendingPermission == nil {
                presentPermission(pending, updatedInput: updatedInput)
            }
        }
    }

    private func clearResolvedPermission(conversationId: String, requestId: String) {
        let key = permissionKey(conversationId: conversationId, requestId: requestId)
        parkedPermissions.removeValue(forKey: key)
        parkedPermissionUpdatedInput.removeValue(forKey: key)
        if pendingPermission?.conversationId == conversationId,
           pendingPermission?.requestId == requestId {
            resetPresentedPermission()
            presentParkedPermissionIfNeeded()
        }
    }

    private func permissionKey(conversationId: String, requestId: String) -> String {
        "\(conversationId)\u{0}\(requestId)"
    }

    private func isForegroundConversation(_ id: String) -> Bool {
        id.isEmpty || aliasIds.contains(id) || liveSessionId == id || historySessionId == id
    }

    private func parkCurrentPermissionIfNeeded() {
        guard let pending = pendingPermission else { return }
        parkedPermissions[pending.id] = pending
        parkedPermissionUpdatedInput[pending.id] = permissionUpdatedInput
    }

    private func presentParkedPermissionIfNeeded() {
        let ids = Set([liveSessionId, historySessionId].compactMap({ $0 }) + Array(aliasIds))
        if let pending = parkedPermissions.values.first(where: { ids.contains($0.conversationId) }) {
            presentPermission(pending, updatedInput: parkedPermissionUpdatedInput[pending.id] ?? "{}")
        }
    }

    private func presentPermission(_ permission: PendingPermission, updatedInput: String) {
        pendingPermission = permission
        permissionUpdatedInput = updatedInput
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
        parkedPermissions[permission.id] = permission
        parkedPermissionUpdatedInput[permission.id] = updatedInput
    }

    private func clearPermissionState(ifMatching permission: PendingPermission) {
        parkedPermissions.removeValue(forKey: permission.id)
        parkedPermissionUpdatedInput.removeValue(forKey: permission.id)
        guard pendingPermission?.id == permission.id else { return }
        resetPresentedPermission()
        presentParkedPermissionIfNeeded()
    }

    private func resetPresentedPermission() {
        pendingPermission = nil
        permissionUpdatedInput = "{}"
        permissionDenyMessage = ""
        permissionError = nil
        askSelections = []
    }

    private func rebuildTranscript() {
        let messages = MessageBlocksEngine.conversationMessagesToChatMessages(
            conversationMessages,
            pendingTurn: pendingTurn
        )
        allMessages = messages
        visibleMessages = Array(messages.suffix(max(pageSize, visibleMessages.count)))
        toolResults = MessageBlocksEngine.buildToolResultsFromConversationMessages(conversationMessages)
        streamTick &+= 1
    }

    private func registerAliases(_ ids: [String]) {
        var changed = false
        for id in ids where !id.isEmpty { if aliasIds.insert(id).inserted { changed = true } }
        if changed { rebindNotificationsIfNeeded() }
    }

    private func matches(meta: ConversationEventMeta) -> Bool {
        let ids = [meta.conversationId, meta.sessionId, meta.runtimeId].filter { !$0.isEmpty }
        if aliasIds.isEmpty { return liveSessionId == nil }
        return ids.contains { aliasIds.contains($0) }
    }

    private func upsertSidebarSession(sessionId: String) {
        guard !workspacePath.isEmpty, !sessionId.isEmpty else { return }
        let now = ISO8601DateFormatter().string(from: Date())
        var groups = sessionGroups
        if let index = groups.firstIndex(where: { $0.workspace.path == workspacePath }) {
            var sessions = groups[index].sessions.filter { $0.sessionId != sessionId }
            sessions.insert(HistorySession(sessionId: sessionId, messageCount: 1, lastTimestamp: now), at: 0)
            groups[index] = SessionGroup(workspace: groups[index].workspace, sessions: sessions, latestAt: now)
        } else {
            let workspace = Workspace(id: workspacePath, path: workspacePath, createdAt: now)
            groups.insert(SessionGroup(workspace: workspace, sessions: [HistorySession(sessionId: sessionId, messageCount: 1, lastTimestamp: now)], latestAt: now), at: 0)
        }
        sessionGroups = groups.sorted { $0.latestAt > $1.latestAt }
    }
}
