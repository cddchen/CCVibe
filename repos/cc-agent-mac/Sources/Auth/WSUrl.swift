import Foundation

struct WSConnectionConfig: Codable, Equatable, Sendable {
    var host: String
    var port: Int
    var useTLS: Bool

    static let defaultPort = 4733

    var baseURLString: String {
        let scheme = useTLS ? "wss" : "ws"
        return "\(scheme)://\(host):\(port)"
    }

    static func parse(stored: String) -> WSConnectionConfig? {
        let trimmed = stored.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = WSUrl.parseWebSocketURL(trimmed), let host = url.host else { return nil }
        let port = url.port ?? defaultPort
        let useTLS = url.scheme?.lowercased() == "wss"
        return WSConnectionConfig(host: host, port: port, useTLS: useTLS)
    }
}

enum WSUrl {
    /// 登录页「主机」可填域名，也可粘贴与 Web 相同的完整基址（`ws://host:5174`）；容错 `ws//` 少冒号。
    static func resolveLoginInput(hostOrUrl: String, portField: String, useTLS: Bool) -> WSConnectionConfig? {
        let raw = hostOrUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }

        if let url = parseWebSocketURL(raw), let host = url.host, !host.isEmpty {
            let port = url.port ?? Int(portField.trimmingCharacters(in: .whitespaces)) ?? WSConnectionConfig.defaultPort
            let scheme = url.scheme?.lowercased()
            let tls: Bool
            if scheme == "wss" { tls = true }
            else if scheme == "ws" { tls = false }
            else { tls = useTLS }
            return WSConnectionConfig(host: host, port: port, useTLS: tls)
        }

        let hostOnly = stripWebSocketPrefix(from: raw)
        guard !hostOnly.isEmpty else { return nil }
        let port = Int(portField.trimmingCharacters(in: .whitespaces)) ?? WSConnectionConfig.defaultPort
        return WSConnectionConfig(host: hostOnly, port: port, useTLS: useTLS)
    }

    static func parseWebSocketURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("ws://") || lower.hasPrefix("wss://") {
            return URL(string: trimmed)
        }
        if lower.hasPrefix("ws//") {
            return URL(string: "ws://" + String(trimmed.dropFirst(4)))
        }
        if lower.hasPrefix("wss//") {
            return URL(string: "wss://" + String(trimmed.dropFirst(5)))
        }
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            return URL(string: trimmed)
        }
        return nil
    }

    private static func stripWebSocketPrefix(from host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = h.lowercased()
        if lower.hasPrefix("wss://") {
            h = String(h.dropFirst(6))
        } else if lower.hasPrefix("ws://") {
            h = String(h.dropFirst(5))
        } else if lower.hasPrefix("wss//") {
            h = String(h.dropFirst(5))
        } else if lower.hasPrefix("ws//") {
            h = String(h.dropFirst(4))
        }
        if let slash = h.firstIndex(of: "/") {
            h = String(h[..<slash])
        }
        if let colon = h.lastIndex(of: ":"), colon != h.startIndex {
            let after = h.index(after: colon)
            if h[after...].allSatisfy(\.isNumber) {
                h = String(h[..<colon])
            }
        }
        return h.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func build(base: String, token: String) -> URL? {
        var trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        var path = trimmed
        if !path.contains("/ws") {
            path += "/ws"
        }
        var components = URLComponents(string: path)
        if !token.isEmpty {
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "/+&=?")
            let encoded = token.addingPercentEncoding(withAllowedCharacters: allowed) ?? token
            components?.percentEncodedQuery = "token=\(encoded)"
        }
        return components?.url
    }

    static func build(config: WSConnectionConfig, token: String) -> URL? {
        build(base: config.baseURLString, token: token)
    }
}