import XCTest
@testable import CCAgent

final class AskUserQuestionTests: XCTestCase {
    private let sampleInput: JSONValue = .object([
        "questions": .array([
            .object([
                "question": .string("连接成功后是否需要断开入口？"),
                "header": .string("切换连接"),
                "multiSelect": .bool(false),
                "options": .array([
                    .object(["label": .string("需要，加按钮"), "description": .string("首页加按钮")]),
                    .object(["label": .string("不需要"), "description": .string("仅自动连接")]),
                ]),
            ]),
            .object([
                "question": .string("要启用哪些功能？"),
                "header": .string("功能"),
                "multiSelect": .bool(true),
                "options": .array([
                    .object(["label": .string("A")]),
                    .object(["label": .string("B")]),
                ]),
            ]),
        ]),
    ])

    func testParseAskUserQuestion() {
        let parsed = AskUserQuestionEngine.parse(sampleInput)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.questions.count, 2)
        XCTAssertEqual(parsed?.questions[0].header, "切换连接")
        XCTAssertEqual(parsed?.questions[1].multiSelect, true)
    }

    func testToggleSelectionAndBuildAnswers() {
        let ask = AskUserQuestionEngine.parse(sampleInput)!
        var selections: [[String]] = [[], []]
        selections = AskUserQuestionEngine.toggleSelection(selections: selections, questionIndex: 0, label: "不需要", multiSelect: false)
        selections = AskUserQuestionEngine.toggleSelection(selections: selections, questionIndex: 1, label: "A", multiSelect: true)
        selections = AskUserQuestionEngine.toggleSelection(selections: selections, questionIndex: 1, label: "B", multiSelect: true)

        XCTAssertTrue(AskUserQuestionEngine.allQuestionsAnswered(ask, selections: selections))
        let updated = AskUserQuestionEngine.buildUpdatedInput(ask, selections: selections)
        XCTAssertEqual(updated["answers"]?.objectValue?["连接成功后是否需要断开入口？"]?.stringValue, "不需要")
        XCTAssertEqual(updated["answers"]?.objectValue?["要启用哪些功能？"]?.stringValue, "A,B")
    }
}
