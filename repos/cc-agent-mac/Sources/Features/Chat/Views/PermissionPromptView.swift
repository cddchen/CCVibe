import SwiftUI

struct PermissionPromptView: View {
    let permission: PendingPermission
    @Binding var updatedInput: String
    @Binding var denyMessage: String
    let errorText: String?
    var onAllow: () -> Void
    var onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("工具权限请求")
                .font(.headline)
            Text(permission.toolName)
                .font(.system(.body, design: .monospaced))
            Text("允许时可编辑 updatedInput，拒绝时可填写原因。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("updatedInput")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $updatedInput)
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: 160, maxHeight: 220)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
            TextField("拒绝原因", text: $denyMessage)
                .textFieldStyle(.roundedBorder)
            if let errorText, !errorText.isEmpty {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("允许", role: .none, action: onAllow)
                    .buttonStyle(.borderedProminent)
                Button("拒绝", role: .destructive, action: onDeny)
            }
        }
        .padding(20)
        .frame(minWidth: 460)
        .background(Theme.controlBackground)
    }
}
