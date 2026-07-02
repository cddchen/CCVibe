import SwiftUI

struct PermissionPromptView: View {
    let permission: PendingPermission
    var onAllow: () -> Void
    var onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("工具权限请求")
                .font(.headline)
            Text(permission.toolName)
                .font(.system(.body, design: .monospaced))
            HStack {
                Button("允许", role: .none, action: onAllow)
                    .buttonStyle(.borderedProminent)
                Button("拒绝", role: .destructive, action: onDeny)
            }
        }
        .padding(20)
        .glassCard()
    }
}