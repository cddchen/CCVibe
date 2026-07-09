import SwiftUI

struct ToolUseCard: View {
    let name: String
    let input: [String: JSONValue]
    let result: ToolResultState?
    let streaming: Bool

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: Theme.Spacing.small) {
                    Image(systemName: toolIcon)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16)

                    Text(name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)

                    statusBadge

                    Text(MessageBlocksEngine.summarizeToolInput(name: name, input: input))
                        .font(.caption2)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 0)

                    Image(systemName: expanded ? "chevron.up" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                if let data = try? JSONEncoder().encode(JSONValue.object(input)),
                   let s = String(data: data, encoding: .utf8) {
                    ScrollView {
                        Text(s)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 160)
                }
                if let content = result?.content {
                    ScrollView {
                        Text(content)
                            .font(.caption)
                            .foregroundStyle(result?.isError == true ? .red : .primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 200)
                }
            }
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.controlBackground.opacity(0.85), in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
        }
    }

    private var statusBadge: some View {
        Text(statusLabel)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.16), in: Capsule())
            .foregroundStyle(statusColor)
    }

    private var toolIcon: String {
        switch name.lowercased() {
        case "grep", "read", "edit", "write", "bash", "shell":
            return "terminal"
        case "glob", "webfetch", "websearch", "fetch":
            return "globe"
        default:
            return "wrench.and.screwdriver"
        }
    }

    private var statusLabel: String {
        guard let r = result else { return streaming ? "执行中" : "执行中" }
        switch r.status {
        case .pending: return "执行中"
        case .completed: return "完成"
        case .error: return "失败"
        }
    }

    private var statusColor: Color {
        guard let r = result else { return .orange }
        switch r.status {
        case .pending: return streaming ? .orange : .gray
        case .completed: return .green
        case .error: return .red
        }
    }
}
