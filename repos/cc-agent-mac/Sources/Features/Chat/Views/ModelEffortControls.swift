import SwiftUI

struct ModelEffortControls: View {
    @Binding var model: String
    @Binding var effort: EffortLevel
    @Binding var permissionMode: PermissionMode
    var onModelChange: (String) -> Void
    var onEffortChange: (EffortLevel) -> Void
    var onPermissionChange: (PermissionMode) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Picker("模型", selection: $model) {
                ForEach(DaemonConstants.modelOptions, id: \.id) { opt in
                    Text(opt.label).tag(opt.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 160)
            .onChange(of: model) { _, v in onModelChange(v) }

            Picker("强度", selection: $effort) {
                ForEach(DaemonConstants.effortOptions, id: \.id) { opt in
                    Text(opt.label).tag(opt.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 100)
            .onChange(of: effort) { _, v in onEffortChange(v) }

            Picker("权限", selection: $permissionMode) {
                ForEach(DaemonConstants.permissionModeOptions, id: \.id) { opt in
                    Text(opt.label).tag(opt.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 140)
            .onChange(of: permissionMode) { _, v in onPermissionChange(v) }
        }
        .font(.caption)
    }
}