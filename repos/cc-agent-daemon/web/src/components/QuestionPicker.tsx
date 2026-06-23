import { useState } from "react";
import {
  allQuestionsAnswered,
  buildAnswersUpdatedInput,
  toggleSelection,
  type AskUserQuestion,
} from "../lib/askUserQuestion";

type Props = {
  ask: AskUserQuestion;
  onSubmit: (updatedInput: Record<string, unknown>) => void;
  onCancel: () => void;
};

export function QuestionPicker({ ask, onSubmit, onCancel }: Props) {
  const [selections, setSelections] = useState<string[][]>(() => ask.questions.map(() => []));
  const ready = allQuestionsAnswered(ask, selections);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
        需要你的选择
      </div>
      {ask.questions.map((q, qi) => {
        const selected = selections[qi] ?? [];
        return (
          <div key={qi} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {q.header && (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                  {q.header}
                </span>
              )}
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{q.question}</span>
              {q.multiSelect && <span className="text-[11px] text-zinc-400">可多选</span>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {q.options.map((o) => {
                const active = selected.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelections((s) => toggleSelection(s, qi, o.label, q.multiSelect))}
                    className={`rounded-2xl border px-3 py-2 text-left text-sm transition ${
                      active
                        ? "border-violet-500 bg-violet-50 text-violet-900 dark:border-violet-500 dark:bg-violet-950/40 dark:text-violet-100"
                        : "border-zinc-200 bg-white hover:border-violet-300 hover:bg-violet-50/40 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-violet-700"
                    }`}
                  >
                    <div className="font-medium">{o.label}</div>
                    {o.description && (
                      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{o.description}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-2xl bg-zinc-100 px-4 py-2 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => onSubmit(buildAnswersUpdatedInput(ask, selections))}
          className="rounded-2xl bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          提交
        </button>
      </div>
    </div>
  );
}
