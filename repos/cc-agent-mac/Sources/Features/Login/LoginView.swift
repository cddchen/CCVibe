import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var app: AppState
    @State private var host = "127.0.0.1"
    @State private var port = "4733"
    @State private var useTLS = false
    @State private var token = ""
    @State private var showToken = false
    @State private var connecting = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.xlarge) {
                Text("CC Agent")
                    .font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    labeled("域名 / 主机或 WS 地址") {
                        TextField("me.ts.example.com 或 ws://host:4733", text: $host)
                            .textFieldStyle(.roundedBorder)
                    }
                    HStack {
                        labeled("端口") {
                            TextField("4733", text: $port)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 100)
                        }
                        Toggle("TLS (wss)", isOn: $useTLS)
                    }
                    Text("Web 开发页是 5174；daemon 默认 4733。远程若 Vite 已代理 /ws，两者都可。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    labeled("Token") {
                        HStack {
                            if showToken {
                                TextField("daemon --token", text: $token)
                                    .textFieldStyle(.roundedBorder)
                            } else {
                                SecureField("daemon --token", text: $token)
                                    .textFieldStyle(.roundedBorder)
                            }
                            Button(showToken ? "隐藏" : "显示") { showToken.toggle() }
                        }
                    }
                    if let err = app.connectionError {
                        Text("连接失败：\(err)")
                            .foregroundStyle(.red)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                    Picker("主题", selection: Binding(get: { app.theme }, set: { app.setTheme($0) })) {
                        Text("系统").tag(AppTheme.system)
                        Text("浅色").tag(AppTheme.light)
                        Text("深色").tag(AppTheme.dark)
                    }
                    .pickerStyle(.segmented)
                    Button(action: submit) {
                        HStack(spacing: 8) {
                            if connecting || app.client.phase == .connecting {
                                ProgressView().controlSize(.small)
                                Text("校验中…")
                            } else {
                                Text("连接并进入")
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(connecting || host.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(24)
                .frame(maxWidth: 420)
                .background(Theme.controlBackground, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous)
                        .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.08), radius: 16, y: 8)
            }
            .padding(24)
        }
        .onAppear {
            loadSaved()
            if !app.isSessionUnlocked {
                app.connectionError = nil
            }
        }
    }

    private func labeled<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }

    private func loadSaved() {
        if let cfg = CredentialStore.wsConfig {
            host = cfg.host
            port = String(cfg.port)
            useTLS = cfg.useTLS
        }
        let saved = CredentialStore.token
        if !saved.isEmpty { token = saved }
    }

    private func submit() {
        guard let config = WSUrl.resolveLoginInput(hostOrUrl: host, portField: port, useTLS: useTLS) else {
            app.connectionError = "无法解析连接地址"
            return
        }
        port = String(config.port)
        useTLS = config.useTLS
        host = config.host
        connecting = true
        app.connectionError = nil
        Task {
            await app.connect(
                host: config.host,
                port: config.port,
                useTLS: config.useTLS,
                token: token
            )
            connecting = false
        }
    }
}
