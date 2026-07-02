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
                HStack {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(statusLabel)
                        .font(.caption2)
                    Text(name)
                        .font(.caption.weight(.semibold))
                    Text(MessageBlocksEngine.summarizeToolInput(name: name, input: input))
                        .font(.caption2)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if let data = try? JSONEncoder().encode(JSONValue.object(input)),
                   let s = String(data: data, encoding: .utf8) {
                    Text(s)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                }
                if let content = result?.content {
                    Text(content)
                        .font(.caption)
                        .foregroundStyle(result?.isError == true ? .red : .primary)
                }
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
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