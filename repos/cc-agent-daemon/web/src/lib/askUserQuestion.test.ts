import { describe, expect, it } from "vitest";
import {
  allQuestionsAnswered,
  buildAnswersUpdatedInput,
  parseAskUserQuestion,
  toggleSelection,
} from "./askUserQuestion";

const sampleInput = {
  questions: [
    {
      question: "连接成功后是否需要断开入口？",
      header: "切换连接",
      multiSelect: false,
      options: [
        { label: "需要，加按钮", description: "首页加按钮" },
        { label: "不需要", description: "仅自动连接" },
      ],
    },
    {
      question: "要启用哪些功能？",
      header: "功能",
      multiSelect: true,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
        { label: "C", description: "" },
      ],
    },
  ],
};

describe("parseAskUserQuestion", () => {
  it("parses a valid AskUserQuestion input", () => {
    const parsed = parseAskUserQuestion(sampleInput);
    expect(parsed).not.toBeNull();
    expect(parsed!.questions).toHaveLength(2);
    expect(parsed!.questions[0].header).toBe("切换连接");
    expect(parsed!.questions[1].multiSelect).toBe(true);
    expect(parsed!.questions[0].options[0].label).toBe("需要，加按钮");
  });

  it("returns null for non-object / missing questions", () => {
    expect(parseAskUserQuestion(null)).toBeNull();
    expect(parseAskUserQuestion("x")).toBeNull();
    expect(parseAskUserQuestion({})).toBeNull();
    expect(parseAskUserQuestion({ questions: [] })).toBeNull();
  });

  it("returns null when a question has no options", () => {
    expect(parseAskUserQuestion({ questions: [{ question: "q", options: [] }] })).toBeNull();
  });

  it("returns null when a question is missing its text", () => {
    expect(parseAskUserQuestion({ questions: [{ options: [{ label: "a" }] }] })).toBeNull();
  });
});

describe("toggleSelection", () => {
  it("single-select replaces the prior choice", () => {
    let sel: string[][] = [[], []];
    sel = toggleSelection(sel, 0, "需要，加按钮", false);
    expect(sel[0]).toEqual(["需要，加按钮"]);
    sel = toggleSelection(sel, 0, "不需要", false);
    expect(sel[0]).toEqual(["不需要"]);
  });

  it("multi-select adds and removes (toggle)", () => {
    let sel: string[][] = [[], []];
    sel = toggleSelection(sel, 1, "A", true);
    sel = toggleSelection(sel, 1, "B", true);
    expect(sel[1]).toEqual(["A", "B"]);
    sel = toggleSelection(sel, 1, "A", true);
    expect(sel[1]).toEqual(["B"]);
  });

  it("does not mutate the input array", () => {
    const sel: string[][] = [[], []];
    const next = toggleSelection(sel, 0, "x", false);
    expect(sel[0]).toEqual([]);
    expect(next[0]).toEqual(["x"]);
  });
});

describe("allQuestionsAnswered", () => {
  it("is false until every question has a selection", () => {
    const ask = parseAskUserQuestion(sampleInput)!;
    expect(allQuestionsAnswered(ask, [["需要，加按钮"], []])).toBe(false);
    expect(allQuestionsAnswered(ask, [["需要，加按钮"], ["A"]])).toBe(true);
  });
});

describe("buildAnswersUpdatedInput", () => {
  it("echoes the original input and adds comma-joined answers keyed by question text", () => {
    const ask = parseAskUserQuestion(sampleInput)!;
    const updated = buildAnswersUpdatedInput(ask, [["不需要"], ["A", "C"]]);
    expect(updated.questions).toBeDefined();
    expect(updated.answers).toEqual({
      "连接成功后是否需要断开入口？": "不需要",
      "要启用哪些功能？": "A,C",
    });
  });
});
