import SwiftUI

@main
struct CCAgentApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .frame(minWidth: 900, minHeight: 600)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Group {
            if app.isSessionUnlocked && app.isConnected {
                switch app.route {
                case .sessionList:
                    SessionListView()
                case .chat(let path, let sid):
                    ChatView(workspacePath: path, historySessionId: sid)
                }
            } else {
                LoginView()
            }
        }
    }
}