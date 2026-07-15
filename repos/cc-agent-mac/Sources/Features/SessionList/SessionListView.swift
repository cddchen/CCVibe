import SwiftUI

@MainActor
final class SessionListViewModel: ObservableObject {
    @Published var groups: [SessionGroup] = []
    @Published var expanded: [String: Bool] = DirectoryExpansionStore.read()
    @Published var activeMap: [String: ActiveKind] = [:]
    @Published var loading = false
    @Published var loadError: String?
    @Published var newPath = ""
    @Published private(set) var activePhase: ConnectionPhase = .disconnected

    private var activePollTask: Task<Void, Never>?

    var connectionStatusText: String {
        switch activePhase {
        case .connected:
            return "已连接"
        case .connecting:
            return "重连中"
        case .disconnected:
            return "未连接"
        }
    }

    func onConnected(client: DaemonClient) {
        activePhase = client.phase
        activePollTask?.cancel()
        Task { await load(client: client, force: true) }
        activePollTask = Task {
            await pollActive(client: client)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled else { break }
                await pollActive(client: client)
            }
        }
    }

    func onConnecting() {
        activePhase = .connecting
    }

    func onDisconnected() {
        activePhase = .disconnected
        activePollTask?.cancel()
        activePollTask = nil
        activeMap = [:]
    }

    func stop() {
        activePollTask?.cancel()
        activePollTask = nil
    }

    func load(client: DaemonClient, force: Bool) async {
        guard client.phase == .connected else {
            loadError = "未连接"
            return
        }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            if force {
                SessionListService.clearCache()
            }
            let data = try await SessionListService.load(client: client, force: force)
            groups = sessionGroups(from: data)
            applyDefaultExpansion()
            if groups.isEmpty {
                loadError = "暂无会话。请确认 daemon 所在机器存在 ~/.claude/projects 历史，或手动添加工作区路径。"
            }
        } catch {
            loadError = error.localizedDescription
            #if DEBUG
            print("[SessionList] load failed: \(error)")
            #endif
        }
    }

    private func applyDefaultExpansion() {
        var next = expanded
        for group in groups {
            guard next[group.workspace.path] == nil else { continue }
            let hasRecent = !group.sessions.isEmpty
            let hasActive = group.sessions.contains { activeMap[$0.sessionId] != nil }
            next[group.workspace.path] = hasActive || hasRecent
        }
        if next != expanded {
            expanded = next
            DirectoryExpansionStore.write(next)
        }
    }

    func toggleExpanded(path: String) {
        let open = DirectoryExpansionStore.isExpanded(path: path, prefs: expanded)
        expanded[path] = !open
        DirectoryExpansionStore.write(expanded)
    }

    func addWorkspace(client: DaemonClient) async {
        let path = newPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        struct WorkspaceAddResponse: Decodable { let workspace: Workspace }
        do {
            _ = try await client.callDecodable(WorkspaceAddResponse.self, method: "workspace.add", params: ["path": path])
            SessionListService.clearCache()
            newPath = ""
            await load(client: client, force: true)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func pollActive(client: DaemonClient) async {
        struct ActiveListResponse: Decodable { let sessions: [ActiveSessionRow] }
        guard client.phase == .connected else { return }
        guard let r = try? await client.callDecodable(ActiveListResponse.self, method: "session.listActive", params: [:]) else { return }
        activeMap = mapActiveSessions(r.sessions)
        applyDefaultExpansion()
    }
}

struct SessionListView: View {
    @EnvironmentObject private var app: AppState
    @StateObject private var vm = SessionListViewModel()
    @State private var searchText = ""
    @State private var showingAddWorkspace = false

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("会话")
                .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
        } detail: {
            ContentUnavailableView(
                "选择或新建会话",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("从侧栏选择历史会话，或在工作区中新建对话。")
            )
        }
        .searchable(text: $searchText, prompt: "搜索会话")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await vm.load(client: app.client, force: true) }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                Button {
                    showingAddWorkspace = true
                } label: {
                    Label("添加工作区", systemImage: "folder.badge.plus")
                }
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
        }
        .sheet(isPresented: $showingAddWorkspace) {
            addWorkspaceSheet
        }
        .onAppear {
            if app.isConnected {
                vm.onConnected(client: app.client)
            }
        }
        .onDisappear { vm.stop() }
        .onChange(of: app.client.phase) { _, phase in
            switch phase {
            case .connected:
                vm.onConnected(client: app.client)
            case .connecting:
                vm.onConnecting()
            case .disconnected:
                vm.onDisconnected()
            }
        }
        .onChange(of: app.reconnectNonce) { _, _ in
            if app.isConnected {
                Task { await vm.load(client: app.client, force: true) }
            }
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            if vm.loading && vm.groups.isEmpty {
                ProgressView("加载中…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filteredGroups.isEmpty {
                ContentUnavailableView(
                    searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "没有会话" : "没有结果",
                    systemImage: "folder",
                    description: Text(emptyDescription)
                )
            } else {
                List {
                    statusRow
                    ForEach(filteredGroups) { group in
                        DisclosureGroup(
                            isExpanded: Binding(
                                get: { DirectoryExpansionStore.isExpanded(path: group.workspace.path, prefs: vm.expanded) },
                                set: { newValue in
                                    vm.expanded[group.workspace.path] = newValue
                                    DirectoryExpansionStore.write(vm.expanded)
                                }
                            ),
                            content: {
                                Button {
                                    app.openChat(workspacePath: group.workspace.path, sessionId: nil)
                                } label: {
                                    Label("新对话", systemImage: "square.and.pencil")
                                }
                                ForEach(group.sessions) { session in
                                    Button {
                                        app.openChat(workspacePath: group.workspace.path, sessionId: session.sessionId)
                                    } label: {
                                        sessionRow(session, in: group)
                                    }
                                    .buttonStyle(.plain)
                                    .help(session.sessionId)
                                    .accessibilityLabel("\(displayTitleForSession(session, workspacePath: group.workspace.path))，\(displaySubtitleForSession(session, activeKind: vm.activeMap[session.sessionId]))")
                                }
                            },
                            label: {
                                groupLabel(group)
                            }
                        )
                    }
                }
                .listStyle(.sidebar)
            }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        if let err = vm.loadError {
            Label(err, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
        } else {
            Label(vm.connectionStatusText, systemImage: vm.activePhase == .connected ? "checkmark.circle" : "bolt.horizontal.circle")
                .font(.caption)
                .foregroundStyle(vm.activePhase == .connected ? .green : .secondary)
        }
    }

    private func groupLabel(_ group: SessionGroup) -> some View {
        HStack(alignment: .center, spacing: Theme.Spacing.small) {
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
            Spacer()
            Text(relative(group.latestAt))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func sessionRow(_ session: HistorySession, in group: SessionGroup) -> some View {
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

    private var addWorkspaceSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.large) {
            Text("添加工作区")
                .font(.headline)
            TextField("工作区路径", text: $vm.newPath)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 420)
                .onSubmit { addWorkspaceAndClose() }
            if let err = vm.loadError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel) {
                    showingAddWorkspace = false
                }
                Button("添加") {
                    addWorkspaceAndClose()
                }
                .buttonStyle(.borderedProminent)
                .disabled(vm.newPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.xlarge)
        .background(Theme.controlBackground)
    }

    private func addWorkspaceAndClose() {
        Task {
            await vm.addWorkspace(client: app.client)
            if vm.loadError == nil {
                showingAddWorkspace = false
            }
        }
    }

    private var filteredGroups: [SessionGroup] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return vm.groups }
        return vm.groups.compactMap { group in
            let groupMatches = group.workspace.path.localizedCaseInsensitiveContains(query)
                || displayNameForWorkspacePath(group.workspace.path).localizedCaseInsensitiveContains(query)
            let sessions = group.sessions.filter { session in
                groupMatches
                    || session.sessionId.localizedCaseInsensitiveContains(query)
                    || displayTitleForSession(session, workspacePath: group.workspace.path).localizedCaseInsensitiveContains(query)
            }
            guard groupMatches || !sessions.isEmpty else { return nil }
            return SessionGroup(workspace: group.workspace, sessions: groupMatches ? group.sessions : sessions, latestAt: group.latestAt)
        }
    }

    private var emptyDescription: String {
        if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "连接正常但列表为空时，请添加项目路径，或检查 daemon 主机上的 Claude 历史目录。"
        }
        return "请尝试搜索工作区名称、路径或会话 ID。"
    }

    private func sessionTitle(_ session: HistorySession, in group: SessionGroup) -> String {
        displayTitleForSession(session, workspacePath: group.workspace.path)
    }

    private func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let d = f.date(from: iso) else { return iso }
        let r = RelativeDateTimeFormatter()
        return r.localizedString(for: d, relativeTo: Date())
    }

    private func groupSummary(_ group: SessionGroup) -> String {
        let count = "\(group.sessions.count) 个会话"
        if group.sessions.contains(where: { vm.activeMap[$0.sessionId] != nil }) {
            return "\(count) · 有活跃会话"
        }
        return count
    }
}
