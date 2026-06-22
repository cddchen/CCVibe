import { Virtuoso } from "react-virtuoso";
import type { ChatMessage, ToolResultState } from "../lib/messageBlocks";
import { ChatMessageRow } from "./ChatMessageRow";

type Props = {
  messages: ChatMessage[];
  toolResults?: Record<string, ToolResultState>;
  emptyHint?: React.ReactNode;
  followOutput?: boolean;
};

export function VirtualMessageList({ messages, toolResults, emptyHint, followOutput = true }: Props) {
  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-sm text-zinc-500 dark:text-zinc-400">
        {emptyHint}
      </div>
    );
  }

  return (
    <Virtuoso
      className="min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      style={{ height: "100%" }}
      data={messages}
      computeItemKey={(_, m) => m.id}
      initialTopMostItemIndex={messages.length - 1}
      followOutput={followOutput ? "auto" : false}
      itemContent={(_, message) => (
        <ChatMessageRow message={message} toolResults={toolResults} />
      )}
      increaseViewportBy={{ top: 200, bottom: 400 }}
    />
  );
}
