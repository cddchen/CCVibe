import SwiftUI

private enum ChatSidebarSelection: Hashable {
    case new(String)
    case session(String, String)
}

private struct ChatBottomAnchorKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct ChatView: View {
    @EnvironmentObject private var app: AppState

    @StateObject private var vm = ChatViewModel()
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var isAtBottom = true

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationTitle("会话")
                .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
        } detail: {
            if vm.hasActiveConversation {
                conversationDetail
            } else {
                homeDetail
            }
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
        .sheet(item: $vm.pendingPermission) { permission in
            if let ask = vm.askQuestion {
                AskUserQuestionView(
                    ask: ask,
                    selections: vm.askSelections,
                    onToggle: { questionIndex, label, multiSelect in
                        vm.toggleAskSelection(questionIndex: questionIndex, label: label, multiSelect: multiSelect)
                    },
                    onSubmit: { Task { await vm.respondAskAllow() } },
                    onCancel: { Task { await vm.respondAskDeny() } }
                )
            } else {
                PermissionPromptView(
                    permission: permission,
                    updatedInput: $vm.permissionUpdatedInput,
                    denyMessage: $vm.permissionDenyMessage,
                    errorText: vm.permissionError,
                    onAllow: { Task { await vm.respondPermissionAllow() } },
                    onDeny: { Task { await vm.respondPermissionDeny() } }
                )
            }
        }
        .onAppear {
            columnVisibility = vm.sidebarOpen ? .all : .detailOnly
            vm.attach(app: app)
            vm.applyRoute(app.route)
        }
        .onDisappear { vm.detach() }
        .onChange(of: app.reconnectNonce) { _, _ in
            vm.refreshAfterReconnect()
        }
        .onChange(of: app.route) { _, newRoute in
            vm.applyRoute(newRoute)
        }
    }

    private var homeDetail: some View {
        ContentUnavailableView(
            "选择或新建会话",
            systemImage: "bubble.left.and.bubble.right",
            description: Text("从侧栏选择历史会话，或在工作区中新建对话。")
        )
        .background(Theme.background)
        .navigationTitle("会话")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                homeToolbarActions
            }
        }
    }

    private var conversationDetail: some View {
        VStack(spacing: 0) {
            workspacePathBar
            messagesArea
            if !vm.statusText.isEmpty {
                Text(vm.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                    .padding(.top, 4)
            }
        }
        .background(Theme.background)
        .navigationTitle(title)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    app.goHome()
                } label: {
                    Label("返回会话", systemImage: "chevron.left")
                }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                homeToolbarActions
            }
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
    }

    @ViewBuilder
    private var homeToolbarActions: some View {
        Menu {
            Picker("主题", selection: Binding(get: { app.theme }, set: { app.setTheme($0) })) {
                Text("系统").tag(AppTheme.system)
                Text("浅色").tag(AppTheme.light)
                Text("深色").tag(AppTheme.dark)
            }
            Divider()
            Button("断开连接", role: .destructive) { app.disconnect() }
        } label: {
            Label("设置", systemImage: "gearshape")
        }
    }

    private var workspacePathBar: some View {
        HStack {
            Text(vm.workspacePath)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.large)
        .padding(.top, Theme.Spacing.small)
        .padding(.bottom, Theme.Spacing.xsmall)
    }

    private var sidebar: some View {
        List(selection: sidebarSelection) {
            ForEach(vm.sessionGroups) { group in
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { DirectoryExpansionStore.isExpanded(path: group.workspace.path, prefs: vm.sidebarExpanded) },
                        set: { value in
                            vm.sidebarExpanded[group.workspace.path] = value
                            DirectoryExpansionStore.write(vm.sidebarExpanded)
                        }
                    ),
                    content: {
                        Label("新对话", systemImage: "square.and.pencil")
                            .tag(ChatSidebarSelection.new(group.workspace.path))
                        ForEach(group.sessions) { session in
                            chatSidebarRow(session, in: group)
                                .tag(ChatSidebarSelection.session(group.workspace.path, session.sessionId))
                                .help(session.sessionId)
                                .accessibilityLabel("\(displayTitleForSession(session, workspacePath: group.workspace.path))，\(displaySubtitleForSession(session, activeKind: vm.activeMap[session.sessionId]))")
                        }
                    },
                    label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayNameForWorkspacePath(group.workspace.path))
                                    .lineLimit(1)
                                Text(group.workspace.path)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        } icon: {
                            Image(systemName: "folder")
                        }
                    }
                )
            }
        }
        .listStyle(.sidebar)
    }

    private var sidebarSelection: Binding<ChatSidebarSelection?> {
        Binding(
            get: {
                guard vm.hasActiveConversation else { return nil }
                let path = vm.workspacePath
                if let historySessionId = vm.historySessionId {
                    return .session(path, historySessionId)
                }
                if let liveSessionId = vm.liveSessionId {
                    return .session(path, liveSessionId)
                }
                return .new(path)
            },
            set: { selection in
                guard let selection else {
                    app.goHome()
                    return
                }
                switch selection {
                case .new(let path):
                    vm.openSession(workspacePath: path, sessionId: nil)
                case .session(let path, let sessionId):
                    vm.openSession(workspacePath: path, sessionId: sessionId)
                }
            }
        )
    }

    private func chatSidebarRow(_ session: HistorySession, in group: SessionGroup) -> some View {
        HStack(alignment: .center, spacing: Theme.Spacing.small) {
            Image(systemName: "text.bubble")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.xsmall) {
                    Text(sessionTitle(session, in: group))
                        .lineLimit(1)
                    if let kind = vm.activeMap[session.sessionId] {
                        ActiveBadge(kind: kind)
                    }
                }
                Text(displaySubtitleForSession(session, activeKind: vm.activeMap[session.sessionId]))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }

    private var messagesArea: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if vm.visibleMessages.count < vm.allMessages.count {
                            Button("加载更早消息") {
                                vm.loadMoreHistory()
                            }
                            .buttonStyle(.bordered)
                            .padding(.top, 8)
                        }

                        ForEach(vm.visibleMessages) { message in
                            MessageRow(message: message, toolResults: vm.toolResults)
                                .id(message.id)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id("chat-bottom")
                            .background {
                                GeometryReader { anchor in
                                    Color.clear.preference(
                                        key: ChatBottomAnchorKey.self,
                                        value: anchor.frame(in: .named("chat-scroll")).maxY
                                    )
                                }
                            }
                    }
                    .padding(.vertical, 8)
                }
                .coordinateSpace(name: "chat-scroll")
                .onPreferenceChange(ChatBottomAnchorKey.self) { bottomY in
                    guard bottomY > 0 else { return }
                    isAtBottom = bottomY <= viewport.size.height + 40
                }
                .onAppear {
                    DispatchQueue.main.async {
                        proxy.scrollTo("chat-bottom", anchor: .bottom)
                    }
                }
                .onChange(of: vm.historySessionId) { _, _ in
                    isAtBottom = true
                    DispatchQueue.main.async {
                        proxy.scrollTo("chat-bottom", anchor: .bottom)
                    }
                }
                .onChange(of: vm.visibleMessages.count) { _, _ in
                    guard isAtBottom else { return }
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("chat-bottom", anchor: .bottom)
                    }
                }
                .onChange(of: vm.streamTick) { _, _ in
                    guard isAtBottom else { return }
                    proxy.scrollTo("chat-bottom", anchor: .bottom)
                }
            }
        }
    }

    private var inputBar: some View {
        VStack(spacing: 0) {
            inputComposer
                .padding(.horizontal, Theme.Spacing.large)
                .padding(.vertical, Theme.Spacing.medium)
        }
        .background(.ultraThinMaterial)
    }

    private var inputComposer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            TextField("输入消息，⌘↵ 发送", text: $vm.inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .onSubmit { Task { await vm.send() } }

            HStack(spacing: Theme.Spacing.small) {
                ModelEffortControls(
                    model: $vm.model,
                    availableModels: vm.availableModelOptions,
                    customModel: $vm.customModel,
                    effort: $vm.effort,
                    permissionMode: $vm.permissionMode,
                    onModelChange: { next in Task { await vm.applyModel(next) } },
                    onEffortChange: { next in Task { await vm.applyEffort(next) } },
                    onPermissionChange: { next in Task { await vm.setPermissionMode(next) } },
                    layout: .compact
                )

                Spacer(minLength: Theme.Spacing.small)

                sendButton
            }
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.controlBackground, in: RoundedRectangle(cornerRadius: Theme.Radius.xlarge, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.xlarge, style: .continuous)
                .stroke(Theme.separator.opacity(0.5), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
    }

    @ViewBuilder
    private var sendButton: some View {
        if vm.busy {
            Button {
                Task { await vm.stop() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "stop.fill")
                    Text("停止")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Theme.secondaryFill, in: Capsule())
            }
            .buttonStyle(.plain)
        } else {
            Button {
                Task { await vm.send() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "paperplane.fill")
                    Text("发送")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Theme.brandGradient, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!vm.trusted || vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(!vm.trusted || vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
        }
    }

    private var title: String {
        if let historySessionId = vm.historySessionId {
            return "会话 \(String(historySessionId.prefix(8)))…"
        }
        if let liveSessionId = vm.liveSessionId {
            return "会话 \(String(liveSessionId.prefix(8)))…"
        }
        return "新对话"
    }

    private func sessionTitle(_ session: HistorySession, in group: SessionGroup) -> String {
        displayTitleForSession(session, workspacePath: group.workspace.path)
    }
}

extension PendingPermission: Hashable {
    static func == (lhs: PendingPermission, rhs: PendingPermission) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct AskUserQuestionView: View {
    let ask: AskUserQuestionPayload
    let selections: [[String]]
    let onToggle: (Int, String, Bool) -> Void
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("需要用户回答")
                .font(.headline)
            ForEach(Array(ask.questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    if let header = question.header, !header.isEmpty {
                        Text(header)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(question.question)
                        .font(.body)
                    ForEach(question.options, id: \.label) { option in
                        Button {
                            onToggle(index, option.label, question.multiSelect)
                        } label: {
                            HStack(alignment: .top) {
                                Image(systemName: isSelected(index: index, label: option.label) ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label)
                                    if let description = option.description, !description.isEmpty {
                                        Text(description)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            HStack {
                Button("取消", role: .cancel, action: onCancel)
                Spacer()
                Button("提交", action: onSubmit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!AskUserQuestionEngine.allQuestionsAnswered(ask, selections: selections))
            }
        }
        .padding(20)
        .frame(minWidth: 420)
        .background(Theme.controlBackground)
    }

    private func isSelected(index: Int, label: String) -> Bool {
        selections.indices.contains(index) && selections[index].contains(label)
    }
}
