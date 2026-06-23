import { useEffect, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatMessage, ToolResultState } from "../lib/messageBlocks";
import { followTargetIndex } from "../lib/scrollFollow";
import { ChatMessageRow } from "./ChatMessageRow";

type Props = {
  messages: ChatMessage[];
  toolResults?: Record<string, ToolResultState>;
  emptyHint?: React.ReactNode;
  followOutput?: boolean;
};

export function VirtualMessageList({ messages, toolResults, emptyHint, followOutput = true }: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  const target = followTargetIndex(messages.length, followOutput);

  // Keep the latest content in view while following: fires when follow is toggled on
  // and on every streaming delta (the last message grows in place, which `followOutput`
  // alone does not track once the user is scrolled away from the bottom).
  useEffect(() => {
    if (target === null) return;
    ref.current?.scrollToIndex({ index: target, align: "end", behavior: "auto" });
  }, [target, messages]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-sm text-zinc-500 dark:text-zinc-400">
        {emptyHint}
      </div>
    );
  }

  return (
    <Virtuoso
      ref={ref}
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
