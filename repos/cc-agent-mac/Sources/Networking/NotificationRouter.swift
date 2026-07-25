import Foundation

struct ConversationEventMeta: Sendable {
    let conversationId: String
    let sessionId: String
    let runtimeId: String
}

struct PermissionRequest: Sendable {
    let conversationId: String
    let requestId: String
    let toolName: String
    let input: JSONValue?
}

struct StreamHandlers {
    var onEvent: (ConversationEventEnvelope, ConversationEventMeta) -> Void
}

private struct Bind {
    let token = UUID()
    var acceptAny: Bool
    var sessionIds: Set<String>
    var handlers: StreamHandlers
}

enum ChatSessionRouting {
    static func shouldReplaceChatUrlFromInit(historySessionId: String?) -> Bool {
        historySessionId == nil
    }

    static func chatNotifyBindOptions(liveSessionId: String?) -> (acceptAny: Bool, sessionIds: [String]) {
        chatNotifyBindOptions(sessionIds: liveSessionId.map { [$0] } ?? [])
    }

    static func chatNotifyBindOptions(sessionIds: [String]) -> (acceptAny: Bool, sessionIds: [String]) {
        let ids = Array(Set(sessionIds.filter { !$0.isEmpty }))
        if ids.isEmpty { return (true, []) }
        return (false, ids)
    }

    static func liveTurnIsBusy(status: String?) -> Bool {
        status == "running" || status == "starting" || status == "spawning" || status == "waiting_permission"
    }

    typealias SessionRunState = String

    static func runStateFromDaemonStatus(_ status: String?) -> String {
        switch status {
        case "running", "starting", "spawning", "waiting_permission", "closing": return "running"
        case "error", "crashed", "failed", "limited": return "error"
        case "interrupted": return "interrupted"
        default: return "completed"
        }
    }
}

@MainActor
final class NotificationRouter {
    private var binds: [Bind] = []

    func install(on client: DaemonClient) {
        client.onNotification { [weak self] method, params in
            Task { @MainActor in
                self?.dispatch(method: method, params: params)
            }
        }
    }

    func bind(acceptAny: Bool = false, sessionIds: [String] = [], handlers: StreamHandlers) -> () -> Void {
        let entry = Bind(
            acceptAny: acceptAny,
            sessionIds: Set(sessionIds.filter { !$0.isEmpty }),
            handlers: handlers
        )
        let unbindToken = entry.token
        binds.append(entry)
        return { [weak self] in
            self?.binds.removeAll { $0.token == unbindToken }
        }
    }

    private func dispatch(method: String, params: JSONValue?) {
        guard method == "conversation/event",
              let params,
              let data = try? JSONEncoder().encode(params),
              let envelope = try? JSONDecoder().decode(ConversationEventEnvelope.self, from: data),
              envelope.version == 1 else { return }

        let meta = ConversationEventMeta(
            conversationId: envelope.conversationId,
            sessionId: envelope.sessionId,
            runtimeId: envelope.runtimeId
        )
        let ids = [meta.conversationId, meta.sessionId, meta.runtimeId].filter { !$0.isEmpty }
        for bind in binds where matches(bind, ids: ids) {
            bind.handlers.onEvent(envelope, meta)
        }
    }

    private func matches(_ bind: Bind, ids: [String]) -> Bool {
        if ids.isEmpty { return bind.acceptAny }
        if bind.acceptAny { return true }
        return ids.contains { bind.sessionIds.contains($0) }
    }
}
