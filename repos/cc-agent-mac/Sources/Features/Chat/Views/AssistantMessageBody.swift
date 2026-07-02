import SwiftUI

struct AssistantMessageBody: View {
    let blocks: [MessageBlock]
    let toolResults: [String: ToolResultState]
    let streaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if blocks.isEmpty, streaming {
                Text("思考中…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let t):
                    MarkdownBlock(text: t)
                    if streaming { StreamingCursor() }
                case .thinking(let t):
                    DisclosureGroup("Thinking") {
                        MarkdownBlock(text: t)
                    }
                    .font(.caption)
                case .toolUse(let id, let name, let input):
                    ToolUseCard(
                        name: name,
                        input: input,
                        result: toolResults[id],
                        streaming: streaming
                    )
                }
            }
        }
    }
}

struct StreamingCursor: View {
    var body: some View {
        Rectangle()
            .fill(Theme.accent)
            .frame(width: 2, height: 14)
            .opacity(0.8)
    }
}