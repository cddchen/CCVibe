import SwiftUI

struct AssistantMessageBody: View {
    let blocks: [MessageBlock]
    let toolResults: [String: ToolResultState]
    let streaming: Bool
    /// When true, measure at ideal (content) width — used by ViewThatFits hug pass.
    var hugging: Bool = false

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
                    MarkdownBlock(text: t, hugging: hugging)
                    if streaming { StreamingCursor() }
                case .thinking(let t):
                    thinkingCard(text: t)
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
        .fixedSize(horizontal: hugging, vertical: true)
    }

    private func thinkingCard(text: String) -> some View {
        DisclosureGroup {
            MarkdownBlock(text: text, hugging: hugging)
                .padding(.top, Theme.Spacing.xsmall)
        } label: {
            HStack(spacing: Theme.Spacing.small) {
                if streaming {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 8, height: 8)
                    Text("思考过程 · 进行中")
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                    Text("思考过程")
                }
                Spacer(minLength: 0)
            }
            .font(.caption.weight(.medium))
        }
        .font(.caption)
        .padding(Theme.Spacing.small)
        .background(Theme.controlBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
        }
    }
}

struct StreamingCursor: View {
    var body: some View {
        Rectangle()
            .fill(Theme.brand)
            .frame(width: 2, height: 14)
            .opacity(0.8)
    }
}
