import SwiftUI

@main
struct CCAgentApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .frame(minWidth: 900, minHeight: 600)
                .preferredColorScheme(Theme.colorScheme(app.theme))
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Group {
            if app.isSessionUnlocked && app.client.phase != .disconnected {
                // One stable shell after login: sidebar never remounts when opening/switching sessions.
                ChatView()
            } else {
                LoginView()
            }
        }
    }
}
