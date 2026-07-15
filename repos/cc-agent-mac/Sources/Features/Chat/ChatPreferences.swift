import Foundation

enum ChatPreferences {
    static let chatSidebarOpenKey = "cc_web_chat_sidebar_open"

    static func readBool(_ key: String, fallback: Bool) -> Bool {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: key) != nil else { return fallback }
        return defaults.bool(forKey: key)
    }

    static func writeBool(_ key: String, value: Bool) {
        UserDefaults.standard.set(value, forKey: key)
    }
}
