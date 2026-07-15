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
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    MarkdownBlock(text: text, hugging: hugging)
                    if streaming { StreamingCursor() }
                case .process(let processBlocks):
                    ProcessSection(
                        blocks: processBlocks,
                        toolResults: toolResults,
                        streaming: streaming,
                        hugging: hugging
                    )
                }
            }
        }
        .fixedSize(horizontal: hugging, vertical: true)
    }

    private enum Segment {
        case text(String)
        case process([MessageBlock])
    }

    /// Group consecutive thinking/tool blocks into one collapsible process section.
    private var segments: [Segment] {
        var out: [Segment] = []
        var process: [MessageBlock] = []

        func flushProcess() {
            guard !process.isEmpty else { return }
            out.append(.process(process))
            process = []
        }

        for block in blocks {
            switch block {
            case .text(let t):
                flushProcess()
                if !t.isEmpty { out.append(.text(t)) }
            case .thinking, .toolUse:
                process.append(block)
            }
        }
        flushProcess()
        return out
    }
}

/// Collapsible wrapper for thinking + tool_use. Open while streaming; auto-collapses when done.
private struct ProcessSection: View {
    let blocks: [MessageBlock]
    let toolResults: [String: ToolResultState]
    let streaming: Bool
    var hugging: Bool = false

    /// nil = follow default (open while streaming); user toggle pins explicit state.
    @State private var userExpanded: Bool?

    private var isExpanded: Bool { userExpanded ?? streaming }

    private var thinkingCount: Int {
        blocks.reduce(0) { acc, b in
            if case .thinking = b { return acc + 1 }
            return acc
        }
    }

    private var toolCount: Int {
        blocks.reduce(0) { acc, b in
            if case .toolUse = b { return acc + 1 }
            return acc
        }
    }

    private var hasPendingTool: Bool {
        // Finished turns (history / endTurn) must not stay "进行中" if a result was dropped.
        guard streaming else { return false }
        return blocks.contains { block in
            guard case .toolUse(let id, _, _) = block else { return false }
            guard let r = toolResults[id] else { return true }
            return r.status == .pending
        }
    }

    private var active: Bool { streaming || hasPendingTool }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                userExpanded = !isExpanded
            } label: {
                HStack(spacing: Theme.Spacing.small) {
                    if active {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 8, height: 8)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    }

                    Text(headerTitle)
                        .font(.caption.weight(.medium))

                    Text(headerSubtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        switch block {
                        case .thinking(let t):
                            ThinkingCard(text: t, streaming: streaming, hugging: hugging)
                        case .toolUse(let id, let name, let input):
                            ToolUseCard(
                                name: name,
                                input: input,
                                result: toolResults[id],
                                streaming: streaming
                            )
                        case .text:
                            EmptyView()
                        }
                    }
                }
                .padding(.top, Theme.Spacing.small)
            }
        }
        .padding(Theme.Spacing.small)
        .background(Theme.controlBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
        }
        .onChange(of: streaming) { _, live in
            // Auto-collapse when the turn finishes; clear override so history stays collapsed.
            if !live { userExpanded = nil }
        }
    }

    private var headerTitle: String {
        if active { return "过程 · 进行中" }
        return "过程"
    }

    private var headerSubtitle: String {
        var parts: [String] = []
        if thinkingCount > 0 { parts.append("\(thinkingCount) 思考") }
        if toolCount > 0 { parts.append("\(toolCount) 工具") }
        if parts.isEmpty { return active ? "生成中" : "已完成" }
        return parts.joined(separator: " · ")
    }
}

/// Original thinking fold card — open while streaming, user can expand/collapse.
private struct ThinkingCard: View {
    let text: String
    let streaming: Bool
    var hugging: Bool = false

    @State private var userExpanded: Bool?

    private var isExpanded: Bool { userExpanded ?? streaming }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                userExpanded = !isExpanded
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
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .font(.caption.weight(.medium))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                MarkdownBlock(text: text, hugging: hugging)
                    .padding(.top, Theme.Spacing.xsmall)
            }
        }
        .font(.caption)
        .padding(Theme.Spacing.small)
        .background(Theme.controlBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
        }
        .onChange(of: streaming) { _, live in
            if !live { userExpanded = nil }
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
