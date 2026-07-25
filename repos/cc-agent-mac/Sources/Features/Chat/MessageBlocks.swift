import Foundation

enum MessageBlock: Equatable, Sendable {
    case text(String)
    case thinking(String)
    case toolUse(id: String, name: String, input: [String: JSONValue])
}

struct ToolResultState: Equatable, Sendable {
    enum Status: Sendable { case pending, completed, error }
    var status: Status
    var content: String?
    var isError: Bool
}

struct TokenUsage: Codable, Equatable, Sendable {
    var input: Int?
    var output: Int?
    var total: Int?
}

struct MessageMetrics: Codable, Equatable, Sendable {
    var usage: TokenUsage?
    var elapsedSeconds: Double?
}

struct ChatMessage: Identifiable, Equatable, Sendable {
    let id: String
    let role: String
    var content: MessageContent
    var streaming: Bool
    var model: String?
    var metrics: MessageMetrics?

    enum MessageContent: Equatable, Sendable {
        case plain(String)
        case blocks([MessageBlock])
    }

    init(
        id: String,
        role: String,
        content: MessageContent,
        streaming: Bool,
        model: String? = nil,
        metrics: MessageMetrics? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.streaming = streaming
        self.model = model
        self.metrics = metrics
    }
}

struct PendingTurnFeedback: Equatable, Sendable {
    let clientMessageId: String
    let content: String
    let turnId: String?
}

enum MessageBlocksEngine {
    /// UI consumes daemon-owned domain snapshots only; Claude SDK events never cross this boundary.
    static func conversationMessagesToChatMessages(
        _ messages: [ConversationMessage],
        pendingTurn: PendingTurnFeedback? = nil
    ) -> [ChatMessage] {
        var out: [ChatMessage] = []
        var agentBubbleIndexByTurn: [String: Int] = [:]
        for message in messages {
            switch message.type {
            case "user_message":
                let text: String
                if let value = message.content?.stringValue {
                    text = value
                } else {
                    text = message.content?.arrayValue?.compactMap { $0["text"]?.stringValue }.joined(separator: "\n") ?? ""
                }
                if !text.isEmpty {
                    out.append(ChatMessage(id: message.id, role: "user", content: .plain(text), streaming: false))
                }
            case "agent_message":
                let blocks = agentBlocks(message.content)
                if !blocks.isEmpty || message.status == "streaming" {
                    let turnKey = message.turnId ?? message.id
                    if let index = agentBubbleIndexByTurn[turnKey] {
                        if case .blocks(let currentBlocks) = out[index].content {
                            out[index].content = .blocks(currentBlocks + blocks)
                        }
                        out[index].streaming = message.status == "streaming"
                        out[index].model = message.model ?? out[index].model
                        out[index].metrics = mergeTurnMetrics(out[index].metrics, message.metrics)
                    } else {
                        agentBubbleIndexByTurn[turnKey] = out.count
                        out.append(ChatMessage(
                            id: message.id,
                            role: "assistant",
                            content: .blocks(blocks),
                            streaming: message.status == "streaming",
                            model: message.model,
                            metrics: message.metrics
                        ))
                    }
                }
            case "model_changed":
                out.append(ChatMessage(id: message.id, role: "system", content: .plain("模型已切换为 \(message.modelId ?? "")"), streaming: false))
            case "effort_changed":
                out.append(ChatMessage(id: message.id, role: "system", content: .plain("思考强度已切换为 \(message.effort?.rawValue ?? "")"), streaming: false))
            case "permission_mode_changed":
                out.append(ChatMessage(id: message.id, role: "system", content: .plain("权限模式已切换为 \(message.mode?.rawValue ?? "")"), streaming: false))
            case "system_message":
                if let text = message.content?.stringValue, !text.isEmpty {
                    out.append(ChatMessage(id: message.id, role: "system", content: .plain(text), streaming: false))
                }
            default:
                break
            }
        }
        if let pendingTurn {
            let hasUser = pendingTurn.turnId.map { turnId in
                messages.contains { $0.type == "user_message" && $0.turnId == turnId }
            } ?? false
            let hasAgent = pendingTurn.turnId.map { turnId in
                messages.contains { $0.type == "agent_message" && $0.turnId == turnId }
            } ?? false
            if !hasUser {
                out.append(ChatMessage(
                    id: "pending-user:\(pendingTurn.clientMessageId)",
                    role: "user",
                    content: .plain(pendingTurn.content),
                    streaming: false
                ))
            }
            if !hasAgent {
                out.append(ChatMessage(
                    id: "pending-agent:\(pendingTurn.clientMessageId)",
                    role: "assistant",
                    content: .blocks([]),
                    streaming: true
                ))
            }
        }
        return out
    }

    static func buildToolResultsFromConversationMessages(_ messages: [ConversationMessage]) -> [String: ToolResultState] {
        var out: [String: ToolResultState] = [:]
        for message in messages {
            if message.type == "agent_message" {
                for item in message.content?.arrayValue ?? [] {
                    guard item["type"]?.stringValue == "tool_call",
                          let id = item["toolCallId"]?.stringValue else { continue }
                    let status = item["status"]?.stringValue
                    let isError = status == "failed" || status == "denied"
                    out[id] = ToolResultState(
                        status: isError ? .error : status == "completed" ? .completed : .pending,
                        content: nil,
                        isError: isError
                    )
                }
            } else if message.type == "tool_result", let id = message.toolCallId {
                let isError = message.isError == true
                out[id] = ToolResultState(
                    status: isError ? .error : .completed,
                    content: message.content?.stringValue,
                    isError: isError
                )
            }
        }
        return out
    }

    static func upsertConversationMessage(_ messages: [ConversationMessage], _ message: ConversationMessage) -> [ConversationMessage] {
        var next = messages
        if let index = next.firstIndex(where: { $0.id == message.id }) {
            next[index] = message
        } else {
            next.append(message)
        }
        return next
    }

    static func summarizeToolInput(name: String, input: [String: JSONValue]) -> String {
        switch name {
        case "Read", "Edit", "Write", "MultiEdit":
            return input["file_path"]?.stringValue ?? ""
        case "Bash":
            return input["command"]?.stringValue ?? ""
        case "Grep", "Glob":
            return input["pattern"]?.stringValue ?? ""
        default:
            guard let data = try? JSONEncoder().encode(JSONValue.object(input)),
                  let text = String(data: data, encoding: .utf8) else { return "" }
            return String(text.prefix(120))
        }
    }

    private static func agentBlocks(_ raw: JSONValue?) -> [MessageBlock] {
        (raw?.arrayValue ?? []).compactMap { item in
            switch item["type"]?.stringValue {
            case "text":
                return item["text"]?.stringValue.map(MessageBlock.text)
            case "thinking":
                return item["thinking"]?.stringValue.map(MessageBlock.thinking)
            case "tool_call":
                guard let id = item["toolCallId"]?.stringValue,
                      let name = item["toolName"]?.stringValue else { return nil }
                return .toolUse(id: id, name: name, input: item["input"]?.objectValue ?? [:])
            default:
                return nil
            }
        }
    }

    private static func mergeTurnMetrics(_ current: MessageMetrics?, _ next: MessageMetrics?) -> MessageMetrics? {
        guard let next else { return current }
        guard let current else { return next }

        func sum(_ lhs: Int?, _ rhs: Int?) -> Int? {
            guard lhs != nil || rhs != nil else { return nil }
            return (lhs ?? 0) + (rhs ?? 0)
        }

        let input = sum(current.usage?.input, next.usage?.input)
        let output = sum(current.usage?.output, next.usage?.output)
        let explicitTotal = sum(current.usage?.total, next.usage?.total)
        let total = input != nil || output != nil ? (input ?? 0) + (output ?? 0) : explicitTotal
        let usage = input != nil || output != nil || total != nil
            ? TokenUsage(input: input, output: output, total: total)
            : nil
        return MessageMetrics(
            usage: usage,
            elapsedSeconds: next.elapsedSeconds ?? current.elapsedSeconds
        )
    }
}
