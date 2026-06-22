import { memo } from "react";
import type { ChatMessage, MessageMetrics } from "../lib/messageBlocks";
import { isAssistantBlocks } from "../lib/messageBlocks";
import type { ToolResultState } from "../lib/messageBlocks";
import { AssistantMessageBody } from "./AssistantMessageBody";
import { MessageMarkdown } from "./MessageMarkdown";

type Props = {
  message: ChatMessage;
  toolResults?: Record<string, ToolResultState>;
};

function formatMetrics(metrics?: MessageMetrics): string[] {
  const items: string[] = [];
  if (metrics?.usage) {
    const parts: string[] = [];
    if (metrics.usage.input !== undefined) parts.push(`in ${metrics.usage.input}`);
    if (metrics.usage.output !== undefined) parts.push(`out ${metrics.usage.output}`);
    if (metrics.usage.total !== undefined) parts.push(`total ${metrics.usage.total}`);
    if (parts.length > 0) items.push(`tokens ${parts.join(" / ")}`);
  }
  if (metrics?.elapsedSeconds !== undefined) items.push(`${metrics.elapsedSeconds}s`);
  return items;
}

function ChatMessageRowInner({ message, toolResults = {} }: Props) {
  const isUser = message.role === "user";
  const metrics = formatMetrics(message.metrics);

  return (
    <div className={`flex min-w-0 px-4 py-3 ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex min-w-0 max-w-[92%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`min-w-0 w-full overflow-hidden rounded-[1.35rem] px-4 py-3 text-sm leading-relaxed shadow-sm ${
            isUser
              ? "bg-violet-600 text-white whitespace-pre-wrap break-words shadow-violet-600/15"
              : `border border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:text-zinc-100 ${
                  message.streaming === true ? "model-reply-bubble-active" : ""
                }`
          }`}
        >
          {isUser ? (
            typeof message.content === "string" ? (
              message.content
            ) : (
              ""
            )
          ) : isAssistantBlocks(message.content) ? (
            <AssistantMessageBody
              blocks={message.content}
              toolResults={toolResults}
              streaming={message.streaming}
            />
          ) : (
            <MessageMarkdown content={String(message.content)} />
          )}
        </div>
        {!isUser && (message.model || metrics.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 text-[10px] font-mono text-zinc-400 dark:text-zinc-600">
            {message.model && <span>{message.model}</span>}
            {metrics.map((item) => (
              <span key={item} className="rounded-full bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-900">
                {item}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatMessageRow = memo(ChatMessageRowInner);
