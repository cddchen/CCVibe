import Foundation

struct StreamEventMeta: Sendable {
    let sessionId: String
    let runtimeId: String
    let sdkSessionId: String
}

struct PermissionRequest: Sendable {
    let sessionId: String
    let requestId: String
    let toolName: String
    let input: JSONValue?
}

struct InitInfo: Sendable {
    let sessionId: String?
    let model: String?
    let cwd: String?
}

struct StreamHandlers {
    var onSdkEvent: (JSONValue, StreamEventMeta) -> Void
    var onStatus: (String, String?, StreamEventMeta) -> Void
    var onPermission: (PermissionRequest) -> Void
    var onInit: ((InitInfo, StreamEventMeta) -> Void)?
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
        if let liveSessionId, !liveSessionId.isEmpty {
            return (false, [liveSessionId])
        }
        return (true, [])
    }

    static func liveTurnIsBusy(status: String?) -> Bool {
        status == "running" || status == "starting"
    }

    typealias SessionRunState = String

    static func runStateFromDaemonStatus(_ status: String?) -> String {
        switch status {
        case "running", "starting": return "running"
        case "error": return "error"
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
        guard let p = params?.objectValue else { return }
        let evSid = p["sessionId"]?.stringValue ?? ""
        let runtimeId = p["runtimeId"]?.stringValue ?? ""
        let msg = p["message"]
        let msgObj = msg?.objectValue
        let sdkSessionId = msgObj?["session_id"]?.stringValue ?? ""
        let meta = StreamEventMeta(sessionId: evSid, runtimeId: runtimeId, sdkSessionId: sdkSessionId)
        let ids = [evSid, runtimeId, sdkSessionId].filter { !$0.isEmpty }

        for bind in binds where matches(bind, ids: ids) {
            switch method {
            case "permission/request":
                let reqId = p["requestId"]?.stringValue ?? String(describing: p["requestId"])
                bind.handlers.onPermission(PermissionRequest(
                    sessionId: evSid,
                    requestId: reqId,
                    toolName: p["toolName"]?.stringValue ?? "",
                    input: p["input"]
                ))
            case "session/event":
                if let msg {
                    bind.handlers.onSdkEvent(msg, meta)
                }
                if msgObj?["type"]?.stringValue == "system",
                   msgObj?["subtype"]?.stringValue == "init" {
                    bind.handlers.onInit?(InitInfo(
                        sessionId: msgObj?["session_id"]?.stringValue,
                        model: msgObj?["model"]?.stringValue,
                        cwd: msgObj?["cwd"]?.stringValue
                    ), meta)
                }
            case "session/status":
                bind.handlers.onStatus(
                    p["status"]?.stringValue ?? "",
                    p["error"]?.stringValue,
                    meta
                )
            default:
                break
            }
        }
    }

    private func matches(_ bind: Bind, ids: [String]) -> Bool {
        if ids.isEmpty { return bind.acceptAny }
        if bind.acceptAny { return true }
        return ids.contains { bind.sessionIds.contains($0) }
    }
}