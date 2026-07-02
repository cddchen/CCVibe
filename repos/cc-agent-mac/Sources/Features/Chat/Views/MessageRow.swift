import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    let toolResults: [String: ToolResultState]

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 60) }
            VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
                content
                if let footer = metricsFooter {
                    Text(footer)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(bubbleColor, in: RoundedRectangle(cornerRadius: 10))
            if message.role != "user" { Spacer(minLength: 60) }
        }
        .padding(.horizontal)
    }

    @ViewBuilder
    private var content: some View {
        switch message.content {
        case .plain(let t):
            Text(t)
                .textSelection(.enabled)
        case .blocks(let blocks):
            AssistantMessageBody(blocks: blocks, toolResults: toolResults, streaming: message.streaming)
        }
    }

    private var bubbleColor: Color {
        message.role == "user" ? Theme.accent.opacity(0.15) : Color.primary.opacity(0.05)
    }

    private var metricsFooter: String? {
        var parts: [String] = []
        if let m = message.model { parts.append(m) }
        if let u = message.metrics?.usage {
            if let i = u.input { parts.append("in \(i)") }
            if let o = u.output { parts.append("out \(o)") }
            if let t = u.total { parts.append("total \(t)") }
        }
        if let e = message.metrics?.elapsedSeconds {
            parts.append(String(format: "%.1fs", e))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}