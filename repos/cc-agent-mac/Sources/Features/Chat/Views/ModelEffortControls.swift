import SwiftUI

struct ModelEffortControls: View {
    enum Layout {
        case vertical
        case compact
    }

    @Binding var model: String
    let availableModels: [ModelOption]
    @Binding var customModel: String
    @Binding var effort: EffortLevel
    @Binding var permissionMode: PermissionMode
    var onModelChange: (String) -> Void
    var onEffortChange: (EffortLevel) -> Void
    var onPermissionChange: (PermissionMode) -> Void
    var layout: Layout = .vertical

    var body: some View {
        switch layout {
        case .vertical:
            verticalBody
        case .compact:
            compactBody
        }
    }

    private var verticalBody: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            LabeledContent("模型") {
                modelPicker
                    .frame(maxWidth: 180)
            }

            LabeledContent("自定义") {
                customModelField
                    .frame(maxWidth: 180)
            }

            LabeledContent("强度") {
                effortPicker
                    .frame(maxWidth: 180)
            }

            LabeledContent("权限") {
                permissionPicker
                    .frame(maxWidth: 180)
            }
        }
        .font(.caption)
    }

    private var compactBody: some View {
        HStack(spacing: Theme.Spacing.small) {
            modelPicker
            effortPicker
            permissionPicker
        }
        .font(.caption)
    }

    private var modelPicker: some View {
        Picker("模型", selection: $model) {
            ForEach(availableModels, id: \.id) { opt in
                Text(opt.label).tag(opt.id)
            }
            if isCustomModelSelected {
                Text(customModelLabel).tag(model)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .onChange(of: model) { _, v in onModelChange(v) }
    }

    private var customModelField: some View {
        TextField("模型 ID", text: $customModel)
            .textFieldStyle(.roundedBorder)
            .onSubmit {
                let trimmed = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                model = trimmed
                onModelChange(trimmed)
            }
    }

    private var effortPicker: some View {
        Picker("强度", selection: $effort) {
            ForEach(DaemonConstants.effortOptions, id: \.id) { opt in
                Text(opt.label).tag(opt.id)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .onChange(of: effort) { _, v in onEffortChange(v) }
    }

    private var permissionPicker: some View {
        Picker("权限", selection: $permissionMode) {
            ForEach(DaemonConstants.permissionModeOptions, id: \.id) { opt in
                Text(opt.label).tag(opt.id)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .onChange(of: permissionMode) { _, v in onPermissionChange(v) }
    }

    private var isCustomModelSelected: Bool {
        !availableModels.contains(where: { $0.id == model })
    }

    private var customModelLabel: String {
        let trimmed = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if model.count > 18 {
            return String(model.prefix(18)) + "…"
        }
        return model
    }
}
