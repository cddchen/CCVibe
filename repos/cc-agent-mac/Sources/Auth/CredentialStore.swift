import Foundation
import Security

enum CredentialStore {
    static let tokenKey = "cc_daemon_token"
    static let wsURLKey = "cc_daemon_ws_url"
    private static let service = "com.ccagent.mac"

    static var token: String {
        get { readKeychain(account: tokenKey) ?? "" }
        set {
            if newValue.isEmpty {
                deleteKeychain(account: tokenKey)
            } else {
                writeKeychain(account: tokenKey, value: newValue)
            }
        }
    }

    static var wsConfig: WSConnectionConfig? {
        get {
            guard let raw = UserDefaults.standard.string(forKey: wsURLKey) else { return nil }
            return WSConnectionConfig.parse(stored: raw)
        }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue.baseURLString, forKey: wsURLKey)
            } else {
                UserDefaults.standard.removeObject(forKey: wsURLKey)
            }
        }
    }

    private static func readKeychain(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func writeKeychain(account: String, value: String) {
        deleteKeychain(account: account)
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func deleteKeychain(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}