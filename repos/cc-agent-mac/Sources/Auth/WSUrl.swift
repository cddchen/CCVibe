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
        guard let url = URL(string: trimmed), let host = url.host else { return nil }
        let port = url.port ?? defaultPort
        let useTLS = url.scheme?.lowercased() == "wss"
        return WSConnectionConfig(host: host, port: port, useTLS: useTLS)
    }
}

enum WSUrl {
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