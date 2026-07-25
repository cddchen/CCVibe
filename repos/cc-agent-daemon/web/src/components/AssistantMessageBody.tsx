import { useEffect, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { ModelReplyFeedback, StreamingCursor } from "./ModelReplyFeedback";
import { ToolUseCard } from "./ToolUseCard";
import type { MessageBlock, ToolResultState } from "../lib/messageBlocks";

type Props = {
  blocks: MessageBlock[];
  toolResults: Record<string, ToolResultState>;
  streaming?: boolean;
  placeholderLabel?: string;
};

function ThinkingBlockView({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <details
      className="group min-w-0 w-full overflow-hidden rounded-xl border border-amber-200/70 bg-amber-50/60 text-xs dark:border-amber-900/60 dark:bg-amber-950/20"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-amber-700 dark:text-amber-300">
        <span className={`h-2 w-2 rounded-full ${streaming ? "animate-pulse bg-amber-400" : "bg-amber-300 dark:bg-amber-700"}`} />
        <span className="font-medium">Thinking</span>
        <span className="text-amber-600/70 dark:text-amber-400/70">{streaming ? "生成中" : "已折叠"}</span>
        <span className="ml-auto text-amber-500 group-open:hidden">展开</span>
        <span className="ml-auto hidden text-amber-500 group-open:inline">收起</span>
      </summary>
      <div className="border-t border-amber-200/70 px-3 py-2 text-amber-900/80 dark:border-amber-900/60 dark:text-amber-100/75">
        <MessageMarkdown content={content} className="!prose-xs opacity-95" />
      </div>
    </details>
  );
}

function ProcessGroup({
  blocks,
  toolResults,
  streaming,
}: {
  blocks: MessageBlock[];
  toolResults: Record<string, ToolResultState>;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const toolCount = blocks.filter((block) => block.type === "tool_use").length;
  const thinkingCount = blocks.filter((block) => block.type === "thinking").length;

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <details
      className="group/process overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/80 dark:border-zinc-700/80 dark:bg-zinc-950/35"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-sm">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${streaming ? "animate-pulse bg-orange-400" : "bg-emerald-400"}`} />
        <span className="font-semibold text-zinc-800 dark:text-zinc-100">
          过程 · {streaming ? "进行中" : "已完成"}
        </span>
        {thinkingCount > 0 && <span className="text-xs text-zinc-500">{thinkingCount} 思考</span>}
        {toolCount > 0 && <span className="text-xs text-zinc-500">{toolCount} 工具</span>}
        <span className="ml-auto text-lg leading-none text-zinc-400 group-open/process:hidden">⌄</span>
        <span className="ml-auto hidden text-lg leading-none text-zinc-400 group-open/process:inline">⌃</span>
      </summary>
      <div className="space-y-2 border-t border-zinc-200/80 p-3 dark:border-zinc-800">
        {blocks.map((block, index) => {
          if (block.type === "thinking") {
            return <ThinkingBlockView key={`think-${index}`} content={block.thinking} streaming={streaming} />;
          }
          if (block.type === "tool_use") {
            return (
              <ToolUseCard
                key={block.id}
                block={block}
                result={toolResults[block.id]}
                streaming={streaming}
              />
            );
          }
          return null;
        })}
      </div>
    </details>
  );
}

export function AssistantMessageBody({ blocks, toolResults, streaming, placeholderLabel }: Props) {
  const live = streaming === true;
  const hasRenderableBlock = blocks.some((block) => {
    if (block.type === "text") return block.text.length > 0;
    if (block.type === "thinking") return block.thinking.length > 0;
    return true;
  });

  if (!hasRenderableBlock && live) {
    return <ModelReplyFeedback variant="bubble" label={placeholderLabel ?? "思考中"} />;
  }

  const processBlocks = blocks.filter((block) => {
    if (block.type === "thinking") return block.thinking.length > 0;
    return block.type === "tool_use";
  });
  const textBlocks = blocks.filter((block): block is Extract<MessageBlock, { type: "text" }> => {
    return block.type === "text" && block.text.length > 0;
  });

  return (
    <div className="min-w-0 w-full space-y-3">
      {processBlocks.length > 0 && (
        <ProcessGroup blocks={processBlocks} toolResults={toolResults} streaming={live} />
      )}
      {textBlocks.map((block, index) => (
        <div key={`text-${index}`}>
          <MessageMarkdown content={block.text} />
        </div>
      ))}
      {live && textBlocks.length === 0 && processBlocks.length > 0 && (
        <ModelReplyFeedback variant="inline" label="正在处理" />
      )}
      {live && textBlocks.length > 0 && <StreamingCursor />}
    </div>
  );
}
