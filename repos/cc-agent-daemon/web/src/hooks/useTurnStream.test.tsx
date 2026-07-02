/**
 * @vitest-environment happy-dom
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTurnStream } from "./useTurnStream";
import type { ChatMessage } from "../lib/messageBlocks";

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function successResult() {
  return { type: "result", subtype: "success" };
}

type StreamApi = ReturnType<typeof useTurnStream>;

function TurnHarness({
  messagesRef,
  apiRef,
}: {
  messagesRef: { current: ChatMessage[] };
  apiRef: { current: StreamApi | null };
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  messagesRef.current = messages;
  const api = useTurnStream(setMessages);
  apiRef.current = api;
  return null;
}

describe("useTurnStream", () => {
  let root: Root;
  let container: HTMLDivElement;
  const messagesRef = { current: [] as ChatMessage[] };
  const apiRef = { current: null as StreamApi | null };

  beforeEach(() => {
    messagesRef.current = [];
    apiRef.current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<TurnHarness messagesRef={messagesRef} apiRef={apiRef} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("auto-activates on replay deltas without beginTurn and ends on result", () => {
    const api = apiRef.current!;

    act(() => {
      api.onSdkEvent(textDelta("hel"));
      api.onSdkEvent(textDelta("lo"));
    });

    const streaming = messagesRef.current.find((m) => m.role === "assistant");
    expect(streaming?.streaming).toBe(true);
    expect(streaming?.content).toEqual([{ type: "text", text: "hello" }]);

    act(() => {
      api.onSdkEvent(successResult());
    });

    const final = messagesRef.current.find((m) => m.role === "assistant");
    expect(final?.streaming).toBe(false);
    expect(final?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("beginTurn then delta and result yields one final assistant message", () => {
    const api = apiRef.current!;

    act(() => {
      api.beginTurn();
      api.onSdkEvent(textDelta("ok"));
      api.onSdkEvent(successResult());
    });

    const assistants = messagesRef.current.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].streaming).toBe(false);
    expect(assistants[0].content).toEqual([{ type: "text", text: "ok" }]);
  });
});