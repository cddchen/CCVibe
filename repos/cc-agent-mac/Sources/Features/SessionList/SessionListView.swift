import SwiftUI

@MainActor
final class SessionListViewModel: ObservableObject {
    @Published var groups: [SessionGroup] = []
    @Published var expanded: [String: Bool] = DirectoryExpansionStore.read()
    @Published var activeMap: [String: ActiveKind] = [:]
    @Published var loading = false
    @Published var loadError: String?
    @Published var newPath = ""

    private var activePollTask: Task<Void, Never>?

    func onConnected(client: DaemonClient) {
        activePollTask?.cancel()
        Task { await load(client: client, force: true) }
        activePollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled else { break }
                await pollActive(client: client)
            }
        }
    }

    func onDisconnected() {
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
    }
}

struct SessionListView: View {
    @EnvironmentObject private var app: AppState
    @StateObject private var vm = SessionListViewModel()

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("会话")
                        .font(.title2.bold())
                    Spacer()
                    Button("刷新") {
                        Task { await vm.load(client: app.client, force: true) }
                    }
                    Button("断开") { app.disconnect() }
                }
                .padding()
                if let err = vm.loadError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }
                if vm.loading && vm.groups.isEmpty {
                    ProgressView("加载中…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.groups.isEmpty {
                    ContentUnavailableView(
                        "没有会话",
                        systemImage: "folder",
                        description: Text("连接正常但列表为空时，请在下方添加本机项目路径，或检查 daemon 主机上的 Claude 历史目录。")
                    )
                } else {
                    List {
                        ForEach(vm.groups) { group in
                            DisclosureGroup(
                                isExpanded: Binding(
                                    get: { DirectoryExpansionStore.isExpanded(path: group.workspace.path, prefs: vm.expanded) },
                                    set: { newValue in
                                        vm.expanded[group.workspace.path] = newValue
                                        DirectoryExpansionStore.write(vm.expanded)
                                    }
                                ),
                                content: {
                                    Button("+ 新对话") {
                                        app.openChat(workspacePath: group.workspace.path, sessionId: nil)
                                    }
                                    ForEach(group.sessions) { session in
                                        Button {
                                            app.openChat(workspacePath: group.workspace.path, sessionId: session.sessionId)
                                        } label: {
                                            HStack {
                                                VStack(alignment: .leading) {
                                                    HStack {
                                                        Text(String(session.sessionId.prefix(8)) + "…")
                                                            .font(.system(.body, design: .monospaced))
                                                        if let kind = vm.activeMap[session.sessionId] {
                                                            ActiveBadge(kind: kind)
                                                        }
                                                    }
                                                    Text("\(session.messageCount) 条消息")
                                                        .font(.caption)
                                                        .foregroundStyle(.secondary)
                                                }
                                                Spacer()
                                                if let ts = session.lastTimestamp {
                                                    Text(relative(ts))
                                                        .font(.caption2)
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                        }
                                        .buttonStyle(.plain)
                                    }
                                },
                                label: {
                                    VStack(alignment: .leading) {
                                        Text(group.workspace.path)
                                            .font(.caption)
                                            .lineLimit(1)
                                        Text("\(group.sessions.count) 个会话")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            )
                        }
                    }
                }
                HStack {
                    TextField("添加工作区路径", text: $vm.newPath)
                        .textFieldStyle(.roundedBorder)
                    Button("添加") {
                        Task { await vm.addWorkspace(client: app.client) }
                    }
                }
                .padding()
            }
        } detail: {
            Text("选择或新建会话")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            case .disconnected:
                vm.onDisconnected()
            case .connecting:
                break
            }
        }
        .onChange(of: app.reconnectNonce) { _, _ in
            if app.isConnected {
                Task { await vm.load(client: app.client, force: true) }
            }
        }
    }

    private func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let d = f.date(from: iso) else { return iso }
        let r = RelativeDateTimeFormatter()
        return r.localizedString(for: d, relativeTo: Date())
    }
}