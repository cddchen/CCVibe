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

struct TokenUsage: Equatable, Sendable {
    var input: Int?
    var output: Int?
    var total: Int?
}

struct MessageMetrics: Equatable, Sendable {
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
}

enum MessageBlocksEngine {
    static func isTurnDone(_ msg: JSONValue) -> Bool {
        guard msg["type"]?.stringValue == "result" else { return false }
        let sub = msg["subtype"]?.stringValue ?? ""
        return sub != "error_during_execution" && sub != "error"
    }

    static func applySdkMessage(
        blocks: [MessageBlock],
        toolResults: [String: ToolResultState],
        msg: JSONValue
    ) -> (blocks: [MessageBlock], toolResults: [String: ToolResultState], metrics: MessageMetrics?, model: String?) {
        var nextBlocks = blocks
        var nextTools = toolResults
        let type = msg["type"]?.stringValue

        if type == "stream_event", let ev = msg["event"]?.objectValue {
            let delta = ev["delta"]?.objectValue
            if let thinking = delta?["thinking"]?.stringValue {
                nextBlocks = appendThinkingDelta(nextBlocks, thinking)
            } else if delta?["type"]?.stringValue == "thinking_delta", let t = delta?["thinking"]?.stringValue {
                nextBlocks = appendThinkingDelta(nextBlocks, t)
            } else if delta?["type"]?.stringValue == "text_delta", let t = delta?["text"]?.stringValue {
                nextBlocks = appendTextDelta(nextBlocks, t)
            } else if ev["type"]?.stringValue == "content_block_delta", let t = delta?["text"]?.stringValue {
                nextBlocks = appendTextDelta(nextBlocks, t)
            } else if ev["type"]?.stringValue == "content_block_start",
                      ev["content_block"]?.objectValue?["type"]?.stringValue == "tool_use" {
                let cb = ev["content_block"]?.objectValue ?? [:]
                if let id = cb["id"]?.stringValue, let name = cb["name"]?.stringValue {
                    let input = (cb["input"]?.objectValue) ?? [:]
                    nextBlocks.append(.toolUse(id: id, name: name, input: input))
                    nextTools[id] = ToolResultState(status: .pending, content: nil, isError: false)
                }
            }
            var metrics: MessageMetrics?
            var model: String?
            if ev["type"]?.stringValue == "message_start", let message = ev["message"]?.objectValue {
                model = message["model"]?.stringValue
                if let usage = usageFromStream(message["usage"]) {
                    metrics = MessageMetrics(usage: usage, elapsedSeconds: nil)
                }
            } else if ev["type"]?.stringValue == "message_delta" {
                if let usage = usageFromStream(ev["usage"]) {
                    metrics = MessageMetrics(usage: usage, elapsedSeconds: nil)
                }
            }
            return (nextBlocks, nextTools, metrics, model)
        }

        if type == "assistant" {
            let raw = msg["message"]?.objectValue?["content"] ?? msg["content"]
            let parsed = asBlocks(raw)
            if !parsed.isEmpty {
                nextBlocks = mergeLiveAssistantSnapshot(nextBlocks, parsed)
                for b in nextBlocks {
                    if case .toolUse(let id, _, _) = b, nextTools[id] == nil {
                        nextTools[id] = ToolResultState(status: .pending, content: nil, isError: false)
                    }
                }
            }
            return (nextBlocks, nextTools, metricsFromObject(msg), msg["message"]?.objectValue?["model"]?.stringValue)
        }

        if type == "user" {
            let raw = msg["message"]?.objectValue?["content"] ?? msg["content"]
            if let arr = raw?.arrayValue {
                for item in arr {
                    guard let o = item.objectValue, o["type"]?.stringValue == "tool_result",
                          let id = o["tool_use_id"]?.stringValue else { continue }
                    nextTools[id] = ToolResultState(
                        status: o["is_error"]?.boolValue == true ? .error : .completed,
                        content: toolResultContent(o["content"]),
                        isError: o["is_error"]?.boolValue == true
                    )
                }
            }
            return (nextBlocks, nextTools, nil, nil)
        }

        if type == "result" {
            return (nextBlocks, nextTools, metricsFromObject(msg), nil)
        }

        return (nextBlocks, nextTools, nil, nil)
    }

    static func mergeMetrics(_ current: MessageMetrics?, _ next: MessageMetrics?) -> MessageMetrics? {
        guard let next else { return current }
        let input = next.usage?.input ?? current?.usage?.input
        let output = next.usage?.output ?? current?.usage?.output
        var usage: TokenUsage?
        if input != nil || output != nil {
            usage = TokenUsage(input: input, output: output, total: (input ?? 0) + (output ?? 0))
        } else {
            let total = next.usage?.total ?? current?.usage?.total
            if total != nil { usage = TokenUsage(input: nil, output: nil, total: total) }
        }
        return MessageMetrics(usage: usage, elapsedSeconds: next.elapsedSeconds ?? current?.elapsedSeconds)
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
            if let data = try? JSONEncoder().encode(JSONValue.object(input)),
               let s = String(data: data, encoding: .utf8) {
                return String(s.prefix(120))
            }
            return ""
        }
    }

    private static func asBlocks(_ raw: JSONValue?) -> [MessageBlock] {
        guard let arr = raw?.arrayValue else { return [] }
        var out: [MessageBlock] = []
        for b in arr {
            guard let o = b.objectValue else { continue }
            switch o["type"]?.stringValue {
            case "text":
                if let t = o["text"]?.stringValue { out.append(.text(t)) }
            case "thinking":
                if let t = o["thinking"]?.stringValue, !t.isEmpty { out.append(.thinking(t)) }
            case "tool_use":
                if let id = o["id"]?.stringValue, let name = o["name"]?.stringValue {
                    out.append(.toolUse(id: id, name: name, input: o["input"]?.objectValue ?? [:]))
                }
            default: break
            }
        }
        return out
    }

    private static func appendTextDelta(_ blocks: [MessageBlock], _ delta: String) -> [MessageBlock] {
        var copy = blocks
        if case .text(let last)? = copy.last {
            copy[copy.count - 1] = .text(last + delta)
        } else {
            copy.append(.text(delta))
        }
        return copy
    }

    private static func appendThinkingDelta(_ blocks: [MessageBlock], _ delta: String) -> [MessageBlock] {
        var copy = blocks
        if case .thinking(let last)? = copy.last {
            copy[copy.count - 1] = .thinking(last + delta)
        } else {
            copy.append(.thinking(delta))
        }
        return copy
    }

    private static func mergeLiveAssistantSnapshot(_ current: [MessageBlock], _ snapshot: [MessageBlock]) -> [MessageBlock] {
        if snapshot.isEmpty { return current }
        if current.isEmpty { return snapshot }
        let hasStructure = snapshot.contains { if case .text = $0 { return false }; return true }
        if !hasStructure {
            var lastStructured = -1
            for (i, b) in current.enumerated() {
                if case .text = b {} else { lastStructured = i }
            }
            if lastStructured == -1 { return snapshot }
            return Array(current.prefix(lastStructured + 1)) + snapshot
        }
        return mergeBlockLists(current, snapshot)
    }

    private static func mergeBlockLists(_ acc: [MessageBlock], _ next: [MessageBlock]) -> [MessageBlock] {
        var out = acc
        for b in next {
            if case .thinking(let t) = b, case .thinking(let last)? = out.last {
                out[out.count - 1] = .thinking(last + t)
            } else if case .text(let t) = b, case .text(let last)? = out.last {
                out[out.count - 1] = .text(last + t)
            } else {
                out.append(b)
            }
        }
        return out
    }

    private static func toolResultContent(_ c: JSONValue?) -> String {
        if let s = c?.stringValue { return s }
        if let arr = c?.arrayValue {
            return arr.compactMap { item -> String? in
                item.objectValue?["text"]?.stringValue
            }.joined(separator: "\n")
        }
        return ""
    }

    private static func usageFromStream(_ raw: JSONValue?) -> TokenUsage? {
        guard let o = raw?.objectValue else { return nil }
        let input = asInt(o["input_tokens"])
        let output = asInt(o["output_tokens"])
        if input == nil && output == nil { return nil }
        return TokenUsage(input: input, output: output, total: (input ?? 0) + (output ?? 0))
    }

    private static func metricsFromObject(_ msg: JSONValue) -> MessageMetrics? {
        var usage: TokenUsage?
        if let u = msg["usage"] { usage = usageFromObject(u) }
        if usage == nil, let message = msg["message"]?.objectValue {
            usage = usageFromObject(message["usage"])
        }
        let elapsed = elapsedFromObject(msg)
        if usage == nil && elapsed == nil { return nil }
        return MessageMetrics(usage: usage, elapsedSeconds: elapsed)
    }

    private static func usageFromObject(_ raw: JSONValue?) -> TokenUsage? {
        guard let o = raw?.objectValue else { return nil }
        let input = asInt(o["input_tokens"] ?? o["inputTokenCount"] ?? o["input"])
        let output = asInt(o["output_tokens"] ?? o["outputTokenCount"] ?? o["output"])
        let derived = (input != nil || output != nil) ? (input ?? 0) + (output ?? 0) : nil
        let total = asInt(o["total_tokens"] ?? o["totalTokenCount"] ?? o["total"]) ?? derived
        if input == nil && output == nil && total == nil { return nil }
        return TokenUsage(input: input, output: output, total: total)
    }

    private static func elapsedFromObject(_ raw: JSONValue) -> Double? {
        if let o = raw.objectValue {
            if let s = asDouble(o["elapsed_seconds"] ?? o["elapsedSeconds"] ?? o["duration_seconds"]) {
                return s
            }
            if let ms = asDouble(o["duration_ms"] ?? o["durationMs"]) {
                return round(ms / 100.0) / 10.0
            }
        }
        return nil
    }

    private static func asInt(_ v: JSONValue?) -> Int? {
        switch v {
        case .number(let n): return Int(n)
        case .string(let s): return Int(s)
        default: return nil
        }
    }

    private static func asDouble(_ v: JSONValue?) -> Double? {
        switch v {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }
}

private extension JSONValue {
    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}