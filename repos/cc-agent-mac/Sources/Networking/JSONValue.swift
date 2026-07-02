import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .null: try container.encodeNil()
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    static func encodeObject(_ dict: [String: Any]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (k, v) in dict {
            out[k] = encodeAny(v)
        }
        return .object(out)
    }

    static func encodeAny(_ value: Any) -> JSONValue {
        switch value {
        case let s as String: return .string(s)
        case let n as Int: return .number(Double(n))
        case let n as Double: return .number(n)
        case let b as Bool: return .bool(b)
        case is NSNull: return .null
        case let a as [Any]: return .array(a.map { encodeAny($0) })
        case let d as [String: Any]: return encodeObject(d)
        default: return .string(String(describing: value))
        }
    }
}