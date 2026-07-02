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

    var errorDescription: String? {
        switch self {
        case .notConnected: return "not connected"
        case .unauthorized: return "invalid token"
        case .rpc(_, let m): return m
        case .decode: return "decode error"
        case .connectionClosed: return "connection closed"
        }
    }
}