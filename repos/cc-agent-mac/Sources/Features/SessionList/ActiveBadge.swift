import SwiftUI

struct ActiveBadge: View {
    let kind: ActiveKind

    var body: some View {
        Text(label)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.2), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch kind {
        case .running:
            return "运行中"
        case .starting:
            return "启动中"
        case .attachable:
            return "可挂接"
        }
    }

    private var color: Color {
        switch kind {
        case .running:
            return Theme.runningBadge
        case .starting:
            return .orange
        case .attachable:
            return Theme.aliveBadge
        }
    }
}
