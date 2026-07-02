import Foundation

enum DirectoryExpansionStore {
    static let homeExpandedKey = "cc_web_home_expanded_dirs"

    static func read() -> [String: Bool] {
        guard let data = UserDefaults.standard.string(forKey: homeExpandedKey)?.data(using: .utf8),
              let parsed = try? JSONDecoder().decode([String: Bool].self, from: data) else {
            if let raw = UserDefaults.standard.string(forKey: homeExpandedKey),
               let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] {
                return Dictionary(uniqueKeysWithValues: obj.compactMap { k, v in
                    guard let b = v as? Bool else { return nil }
                    return (k, b)
                })
            }
            return [:]
        }
        return parsed
    }

    static func write(_ value: [String: Bool]) {
        if let data = try? JSONEncoder().encode(value),
           let s = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(s, forKey: homeExpandedKey)
        }
    }

    static func isExpanded(path: String, prefs: [String: Bool]) -> Bool {
        prefs[path] ?? true
    }
}