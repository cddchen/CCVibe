import { MessageMarkdown } from "./MessageMarkdown";
import { ModelReplyFeedback, StreamingCursor } from "./ModelReplyFeedback";
import { ToolUseCard } from "./ToolUseCard";
import type { MessageBlock, ToolResultState } from "../lib/messageBlocks";

type Props = {
  blocks: MessageBlock[];
  toolResults: Record<string, ToolResultState>;
  streaming?: boolean;
};

function ThinkingBlockView({ content, streaming }: { content: string; streaming: boolean }) {
  return (
    <details className="group min-w-0 w-full overflow-hidden rounded-2xl border border-amber-200/70 bg-amber-50/70 text-xs dark:border-amber-900/60 dark:bg-amber-950/20" open={streaming}>
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

export function AssistantMessageBody({ blocks, toolResults, streaming }: Props) {
  const live = streaming === true;

  if (blocks.length === 0 && live) {
    return <ModelReplyFeedback variant="bubble" label="思考中" />;
  }

  const hasPendingTool =
    live &&
    blocks.some((b) => b.type === "tool_use" && (!toolResults[b.id] || toolResults[b.id].status === "pending"));
  const onlyThinking = live && blocks.length > 0 && blocks.every((b) => b.type === "thinking");

  return (
    <div className="min-w-0 w-full space-y-3">
      {blocks.map((block, i) => {
        if (block.type === "thinking") {
          return <ThinkingBlockView key={`think-${i}`} content={block.thinking} streaming={live} />;
        }
        if (block.type === "tool_use") {
          return (
            <ToolUseCard
              key={block.id}
              block={block}
              result={toolResults[block.id]}
              streaming={live}
            />
          );
        }
        if (block.type === "text" && block.text) {
          return (
            <div key={`text-${i}`}>
              <MessageMarkdown content={block.text} />
            </div>
          );
        }
        return null;
      })}
      {onlyThinking && <ModelReplyFeedback variant="inline" label="思考中" />}
      {hasPendingTool && !blocks.some((b) => b.type === "text") && (
        <ModelReplyFeedback variant="inline" label="调用工具" />
      )}
      {live && blocks.some((b) => b.type === "text") && <StreamingCursor />}
    </div>
  );
}
