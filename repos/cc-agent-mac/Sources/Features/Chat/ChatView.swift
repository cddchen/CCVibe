import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var app: AppState
    let workspacePath: String
    let historySessionId: String?

    @StateObject private var vm: ChatViewModel

    init(workspacePath: String, historySessionId: String?) {
        self.workspacePath = workspacePath
        self.historySessionId = historySessionId
        _vm = StateObject(wrappedValue: ChatViewModel(workspacePath: workspacePath, historySessionId: historySessionId))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(vm.messages) { msg in
                            MessageRow(message: msg, toolResults: vm.toolResults)
                                .id(msg.id)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .onChange(of: vm.messages.count) { _, _ in
                    if let last = vm.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            if !vm.statusText.isEmpty {
                Text(vm.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }
            footer
        }
        .overlay {
            if let trust = vm.trustPrompt {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                TrustPromptView(
                    prompt: trust,
                    onTrust: { path in Task { await vm.trust(path: path) } },
                    onCancel: { app.goHome() }
                )
            }
        }
        .sheet(item: $vm.pendingPermission) { p in
            PermissionPromptView(
                permission: p,
                onAllow: { Task { await vm.respondPermission(allow: true) } },
                onDeny: { Task { await vm.respondPermission(allow: false) } }
            )
        }
        .onAppear {
            vm.attach(app: app)
        }
        .onDisappear {
            vm.detach()
        }
    }

    private var header: some View {
        HStack {
            Button(action: { app.goHome() }) {
                Image(systemName: "chevron.left")
            }
            VStack(alignment: .leading) {
                Text("会话 \(displaySessionId)")
                    .font(.headline)
                Text(workspacePath)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding()
    }

    private var displaySessionId: String {
        let sid = historySessionId ?? "新建"
        return String(sid.prefix(8)) + (sid.count > 8 ? "…" : "")
    }

    private var footer: some View {
        VStack(spacing: 8) {
            ModelEffortControls(
                model: $vm.model,
                effort: $vm.effort,
                permissionMode: $vm.permissionMode,
                onModelChange: { m in Task { await vm.applyModel(m) } },
                onEffortChange: { e in Task { await vm.applyEffort(e) } },
                onPermissionChange: { m in Task { await vm.setPermissionMode(m) } }
            )
            HStack(alignment: .bottom) {
                TextField("输入消息…", text: $vm.inputText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit { Task { await vm.send() } }
                if vm.busy {
                    Button("停止") { Task { await vm.stop() } }
                } else {
                    Button("发送") { Task { await vm.send() } }
                        .disabled(!vm.trusted || vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding()
        .glassCard(cornerRadius: 0)
    }
}

extension PendingPermission: Hashable {
    static func == (lhs: PendingPermission, rhs: PendingPermission) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}