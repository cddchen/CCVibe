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
            LinearGradient(colors: [.blue.opacity(0.15), .purple.opacity(0.1)], startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
            VStack(spacing: 20) {
                Text("CC Agent")
                    .font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: 12) {
                    labeled("域名 / 主机") {
                        TextField("127.0.0.1", text: $host)
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
                    labeled("Token") {
                        HStack {
                            if showToken {
                                TextField("token", text: $token)
                                    .textFieldStyle(.roundedBorder)
                            } else {
                                SecureField("token", text: $token)
                                    .textFieldStyle(.roundedBorder)
                            }
                            Button(showToken ? "隐藏" : "显示") { showToken.toggle() }
                        }
                    }
                    if let err = app.connectionError {
                        Text("连接失败：\(err)")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
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
                .glassCard()
            }
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
        guard let portNum = Int(port) else { return }
        connecting = true
        app.connectionError = nil
        Task {
            await app.connect(
                host: host.trimmingCharacters(in: .whitespaces),
                port: portNum,
                useTLS: useTLS,
                token: token
            )
            connecting = false
        }
    }
}