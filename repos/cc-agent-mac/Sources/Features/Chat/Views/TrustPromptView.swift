import SwiftUI

struct TrustPromptView: View {
    let prompt: TrustPrompt
    var onTrust: (String) -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("目录未加入白名单")
                .font(.headline)
            Text("需要信任工作区后才能对话。")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("信任此目录") { onTrust(prompt.path) }
                Button("信任父目录") { onTrust(prompt.parent) }
                Button("取消", role: .cancel, action: onCancel)
            }
        }
        .padding(24)
        .glassCard()
        .frame(maxWidth: 360)
    }
}