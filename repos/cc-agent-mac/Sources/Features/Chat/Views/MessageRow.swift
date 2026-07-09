import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    let toolResults: [String: ToolResultState]

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            if isUser {
                Spacer(minLength: 60)
            } else {
                assistantAvatar
            }

            // Prefer content-hugging width; if it exceeds the space left by Spacers,
            // fall back to the width-constrained (wrapping) variant — same max-width as before.
            ViewThatFits(in: .horizontal) {
                bubble(hugging: true)
                bubble(hugging: false)
            }

            if !isUser {
                Spacer(minLength: 60)
            }
        }
        .padding(.horizontal, Theme.Spacing.large)
    }

    private func bubble(hugging: Bool) -> some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: Theme.Spacing.xsmall) {
            content(hugging: hugging)
                .foregroundStyle(isUser ? Theme.bubbleUserText : .primary)
            if let footer = metricsFooter {
                Text(footer)
                    .font(.caption2)
                    .foregroundStyle(isUser ? Theme.bubbleUserText.opacity(0.75) : .secondary)
                    .fixedSize(horizontal: hugging, vertical: true)
            }
        }
        .padding(Theme.Spacing.medium)
        .background(bubbleColor, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
        .fixedSize(horizontal: hugging, vertical: true)
    }

    private var assistantAvatar: some View {
        ZStack {
            Circle()
                .fill(Theme.brandGradient)
            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func content(hugging: Bool) -> some View {
        switch message.content {
        case .plain(let t):
            Text(t)
                .textSelection(.enabled)
                .multilineTextAlignment(isUser ? .trailing : .leading)
                .fixedSize(horizontal: hugging, vertical: true)
        case .blocks(let blocks):
            AssistantMessageBody(
                blocks: blocks,
                toolResults: toolResults,
                streaming: message.streaming,
                hugging: hugging
            )
        }
    }

    private var bubbleColor: Color {
        isUser ? Theme.brandBubble : Theme.secondaryFill
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
