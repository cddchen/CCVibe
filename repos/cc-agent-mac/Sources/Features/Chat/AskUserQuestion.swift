import Foundation

struct AskOption: Equatable, Sendable {
    let label: String
    let description: String?
}

struct AskQuestion: Equatable, Sendable {
    let question: String
    let header: String?
    let multiSelect: Bool
    let options: [AskOption]
}

struct AskUserQuestionPayload: Equatable, Sendable {
    let questions: [AskQuestion]
    let raw: [String: JSONValue]
}

enum AskUserQuestionEngine {
    static func parse(_ input: JSONValue?) -> AskUserQuestionPayload? {
        guard let raw = input?.objectValue,
              let rawQuestions = raw["questions"]?.arrayValue,
              !rawQuestions.isEmpty else { return nil }

        var questions: [AskQuestion] = []
        for item in rawQuestions {
            guard let object = item.objectValue,
                  let question = object["question"]?.stringValue,
                  !question.isEmpty,
                  let rawOptions = object["options"]?.arrayValue else {
                return nil
            }

            let options = rawOptions.compactMap { option -> AskOption? in
                guard let optionObject = option.objectValue,
                      let label = optionObject["label"]?.stringValue,
                      !label.isEmpty else {
                    return nil
                }
                return AskOption(label: label, description: optionObject["description"]?.stringValue)
            }
            if options.isEmpty { return nil }

            questions.append(AskQuestion(
                question: question,
                header: object["header"]?.stringValue,
                multiSelect: object["multiSelect"]?.boolValue == true,
                options: options
            ))
        }
        return AskUserQuestionPayload(questions: questions, raw: raw)
    }

    static func toggleSelection(
        selections: [[String]],
        questionIndex: Int,
        label: String,
        multiSelect: Bool
    ) -> [[String]] {
        var next = selections
        while next.count <= questionIndex {
            next.append([])
        }
        if multiSelect {
            if let at = next[questionIndex].firstIndex(of: label) {
                next[questionIndex].remove(at: at)
            } else {
                next[questionIndex].append(label)
            }
        } else {
            next[questionIndex] = [label]
        }
        return next
    }

    static func allQuestionsAnswered(_ ask: AskUserQuestionPayload, selections: [[String]]) -> Bool {
        ask.questions.indices.allSatisfy { index in
            (selections.indices.contains(index) ? selections[index].count : 0) > 0
        }
    }

    static func buildUpdatedInput(_ ask: AskUserQuestionPayload, selections: [[String]]) -> [String: JSONValue] {
        var answers: [String: JSONValue] = [:]
        for (index, question) in ask.questions.enumerated() {
            answers[question.question] = .string((selections.indices.contains(index) ? selections[index] : []).joined(separator: ","))
        }
        var out = ask.raw
        out["answers"] = .object(answers)
        return out
    }
}
