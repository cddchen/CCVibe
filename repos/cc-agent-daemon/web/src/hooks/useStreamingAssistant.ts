import { useCallback, useRef } from "react";
import type { ChatMessage } from "../lib/daemonClient";

/** Stream updates: sync UI each chunk so Virtuoso + markdown see every delta. */
export function useStreamingAssistant(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
) {
  const streamBuf = useRef("");
  const streamId = useRef("assistant-live");

  const pushAssistant = useCallback(
    (text: string, streaming: boolean) => {
      const id = streamId.current;
      setMessages((prev) => {
        const rest = prev.filter((m) => m.id !== id);
        return [...rest, { id, role: "assistant", content: text, streaming }];
      });
    },
    [setMessages],
  );

  const appendChunk = useCallback(
    (chunk: string) => {
      if (!chunk) return;
      streamBuf.current += chunk;
      pushAssistant(streamBuf.current, true);
    },
    [pushAssistant],
  );

  const beginTurn = useCallback(() => {
    streamBuf.current = "";
    streamId.current = `a-${Date.now()}`;
  }, []);

  const endTurn = useCallback(() => {
    const text = streamBuf.current;
    const id = streamId.current;
    if (text) {
      setMessages((prev) => {
        const rest = prev.filter((m) => m.id !== id);
        return [...rest, { id, role: "assistant", content: text, streaming: false }];
      });
    } else {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
    }
    streamBuf.current = "";
  }, [setMessages]);

  return { beginTurn, appendChunk, endTurn, streamIdRef: streamId };
}