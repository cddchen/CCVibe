import Foundation

struct JSONRPCRequest: Encodable {
    let id: Int
    let method: String
    let params: JSONValue

    init(id: Int, method: String, params: [String: Any] = [:]) {
        self.id = id
        self.method = method
        self.params = JSONValue.encodeObject(params)
    }
}

struct JSONRPCErrorPayload: Decodable {
    let code: Int
    let message: String
}

struct JSONRPCResponse: Decodable {
    let id: Int?
    let method: String?
    let params: JSONValue?
    let result: JSONValue?
    let error: JSONRPCErrorPayload?
}

enum JSONRPCClientError: Error, LocalizedError {
    case notConnected
    case unauthorized
    case rpc(Int, String)
    case decode
    case connectionClosed
    case invalidURL
    case connectTimeout
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "未连接：WebSocket 尚未就绪或已断开"
        case .unauthorized:
            return "认证失败：Token 无效或未填写"
        case .rpc(_, let m):
            return m
        case .decode:
            return "响应解析失败"
        case .connectionClosed:
            return "连接已关闭"
        case .invalidURL:
            return "WebSocket 地址无效"
        case .connectTimeout:
            return "连接超时：请检查主机/端口/TLS，以及 daemon 是否可达"
        case .transport(let message):
            return "网络错误：\(message)"
        }
    }
}
