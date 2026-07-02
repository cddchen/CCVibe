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
        kind == .running ? "对话中" : "活跃"
    }

    private var color: Color {
        kind == .running ? Theme.runningBadge : Theme.aliveBadge
    }
}