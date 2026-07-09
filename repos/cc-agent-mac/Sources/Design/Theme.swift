import SwiftUI

enum AppTheme: String, CaseIterable, Codable {
    case system
    case light
    case dark
}

enum Theme {
    static let themeKey = "cc_mac_theme"
    static let accent = Color.accentColor
    /// Brand purple `#7C5CFF`
    static let brand = Color(red: 0.49, green: 0.36, blue: 1.0)
    static let brandBubble = brand
    static let bubbleUserText = Color.white
    static let runningBadge = Color(red: 0.55, green: 0.35, blue: 0.95)
    static let aliveBadge = Color.secondary
    static let background = Color(nsColor: .windowBackgroundColor)
    static let controlBackground = Color(nsColor: .controlBackgroundColor)
    static let secondaryFill = Color(nsColor: .quaternarySystemFill)
    static let separator = Color(nsColor: .separatorColor)

    /// Purple → deeper purple for send button / assistant avatar.
    static var brandGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.55, green: 0.42, blue: 1.0),
                Color(red: 0.42, green: 0.28, blue: 0.92),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// Soft lavender wash for the chat detail background.
    static var windowGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.78, green: 0.72, blue: 1.0).opacity(0.22),
                Color.clear,
                Color.clear,
            ],
            startPoint: .topTrailing,
            endPoint: .bottomLeading
        )
    }

    enum Spacing {
        static let xsmall: CGFloat = 4
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let large: CGFloat = 16
        static let xlarge: CGFloat = 20
    }

    enum Radius {
        static let small: CGFloat = 6
        static let medium: CGFloat = 8
        static let large: CGFloat = 12
        static let xlarge: CGFloat = 16
    }

    static func readTheme() -> AppTheme {
        guard let raw = UserDefaults.standard.string(forKey: themeKey),
              let theme = AppTheme(rawValue: raw) else {
            return .system
        }
        return theme
    }

    static func writeTheme(_ theme: AppTheme) {
        UserDefaults.standard.set(theme.rawValue, forKey: themeKey)
    }

    static func colorScheme(_ theme: AppTheme) -> ColorScheme? {
        switch theme {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }
}
