import Foundation

enum PermissionResponseError: LocalizedError {
    case invalidUpdatedInput

    var errorDescription: String? {
        switch self {
        case .invalidUpdatedInput:
            return "updatedInput 必须是 JSON object"
        }
    }
}

enum PermissionResponses {
    static func permissionInputText(_ input: JSONValue?) -> String {
        guard let input else { return "{}" }
        guard let data = try? JSONEncoder().encode(input),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    static func parseUpdatedInput(_ text: String) throws -> [String: JSONValue]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let data = trimmed.data(using: .utf8) else {
            throw PermissionResponseError.invalidUpdatedInput
        }
        let parsed = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let object = parsed.objectValue else {
            throw PermissionResponseError.invalidUpdatedInput
        }
        return object
    }

    static func buildPermissionRespondParams(
        request: PendingPermission,
        behavior: String,
        updatedInputText: String = "",
        denyMessage: String = ""
    ) throws -> [String: Any] {
        var base: [String: Any] = [
            "sessionId": request.sessionId,
            "requestId": request.requestId,
            "behavior": behavior,
        ]

        if behavior == "deny" {
            base["message"] = denyMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "用户拒绝" : denyMessage
            return base
        }

        if let updatedInput = try parseUpdatedInput(updatedInputText) {
            base["updatedInput"] = updatedInput.mapValues { $0.toFoundationValue() }
        }
        return base
    }
}
