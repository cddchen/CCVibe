export type AskOption = { label: string; description?: string };

export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskOption[];
};

export type AskUserQuestion = {
  questions: AskQuestion[];
  /** preserved original fields so the tool input is echoed back intact */
  raw: Record<string, unknown>;
};

/** Parse a permission/request `input` for the AskUserQuestion tool, or null if the shape is unusable. */
export function parseAskUserQuestion(input: unknown): AskUserQuestion | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const questions: AskQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || !q.question) return null;
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => {
            const oo = (o ?? {}) as Record<string, unknown>;
            return {
              label: typeof oo.label === "string" ? oo.label : "",
              description: typeof oo.description === "string" ? oo.description : undefined,
            };
          })
          .filter((o) => o.label)
      : [];
    if (options.length === 0) return null;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: Boolean(q.multiSelect),
      options,
    });
  }
  return { questions, raw };
}

/** Apply a click on an option, returning a new selections array (one string[] per question). */
export function toggleSelection(
  selections: string[][],
  questionIndex: number,
  label: string,
  multiSelect: boolean,
): string[][] {
  const next = selections.map((s) => [...s]);
  while (next.length <= questionIndex) next.push([]);
  const current = next[questionIndex];
  if (multiSelect) {
    const at = current.indexOf(label);
    if (at >= 0) current.splice(at, 1);
    else current.push(label);
  } else {
    next[questionIndex] = [label];
  }
  return next;
}

/** Every question must have at least one selected option before submitting. */
export function allQuestionsAnswered(ask: AskUserQuestion, selections: string[][]): boolean {
  return ask.questions.every((_, i) => (selections[i]?.length ?? 0) > 0);
}

/** Build the `updatedInput` echoed back to the SDK: original input + `answers` keyed by question text. */
export function buildAnswersUpdatedInput(ask: AskUserQuestion, selections: string[][]): Record<string, unknown> {
  const answers: Record<string, string> = {};
  ask.questions.forEach((q, i) => {
    answers[q.question] = (selections[i] ?? []).join(",");
  });
  return { ...ask.raw, answers };
}
