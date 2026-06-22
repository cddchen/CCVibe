import { useState } from "react";
import type { ToolResultState, ToolUseBlock } from "../lib/messageBlocks";

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === "Read" && typeof input.file_path === "string") return input.file_path;
  if ((name === "Edit" || name === "Write" || name === "MultiEdit") && typeof input.file_path === "string") {
    return input.file_path;
  }
  if (name === "Bash" && typeof input.command === "string") {
    return input.command.length > 80 ? `${input.command.slice(0, 80)}…` : input.command;
  }
  if (name === "Grep" && typeof input.pattern === "string") return input.pattern;
  if (name === "Glob" && typeof input.pattern === "string") return input.pattern;
  try {
    const s = JSON.stringify(input);
    return s.length > 100 ? `${s.slice(0, 100)}…` : s;
  } catch {
    return "";
  }
}

function statusLabel(result: ToolResultState | undefined): string {
  if (!result || result.status === "pending") return "执行中";
  return result.isError || result.status === "error" ? "失败" : "完成";
}

type Props = {
  block: ToolUseBlock;
  result?: ToolResultState;
  streaming?: boolean;
};

export function ToolUseCard({ block, result, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const pending = !result || result.status === "pending";
  const pulse = pending && streaming;

  return (
    <div className="my-2 min-w-0 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 text-xs shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/60">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${pulse ? "animate-pulse bg-amber-400" : pending ? "bg-zinc-400" : result?.isError ? "bg-red-400" : "bg-emerald-400"}`}
        />
        <span className="font-semibold text-zinc-800 dark:text-zinc-200">{block.name}</span>
        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {statusLabel(result)}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-500">{summarizeInput(block.name, block.input)}</span>
        <span className="text-zinc-400">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-200 px-3 pb-3 pt-2 dark:border-zinc-800">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">Input</div>
            <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-xl bg-white p-2 text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
          {result?.content && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">Result</div>
              <pre
                className={`max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-xl p-2 ${result.isError ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200" : "bg-white text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"}`}
              >
                {result.content}
              </pre>
            </div>
          )}
          {pending && <p className="text-zinc-500 italic">执行中…</p>}
        </div>
      )}
    </div>
  );
}
