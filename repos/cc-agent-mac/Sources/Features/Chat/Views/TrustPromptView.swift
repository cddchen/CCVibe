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
        .background(Theme.controlBackground, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous)
                .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
        .frame(maxWidth: 360)
    }
}
