import { useCallback, useEffect, useRef, useState } from "react";
import {
  applySdkMessage,
  mergeMetrics,
  type ChatMessage,
  type MessageBlock,
  type MessageMetrics,
  type ToolResultState,
} from "../lib/messageBlocks";

function isTurnDoneMessage(msg: unknown): boolean {
  const m = msg as { type?: string; subtype?: string };
  return m.type === "result" && m.subtype !== "error_during_execution" && m.subtype !== "error";
}

export function useTurnStream(setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) {
  const turnId = useRef(`a-${Date.now()}`);
  const turnActiveRef = useRef(false);
  const blocksRef = useRef<MessageBlock[]>([]);
  const toolsRef = useRef<Record<string, ToolResultState>>({});
  const metricsRef = useRef<MessageMetrics | undefined>(undefined);
  const modelRef = useRef<string | undefined>(undefined);
  const turnStartRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [toolResults, setToolResults] = useState<Record<string, ToolResultState>>({});

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const patchTurnMessage = useCallback(
    (streaming: boolean) => {
      const id = turnId.current;
      const blocks = [...blocksRef.current];
      const metrics = metricsRef.current;
      const model = modelRef.current;
      setMessages((prev) => {
        const rest = prev.filter((m) => m.id !== id);
        if (blocks.length === 0 && streaming) {
          return [...rest, { id, role: "assistant", content: [], streaming: true, model, metrics }];
        }
        if (blocks.length === 0 && !streaming) {
          return prev.map((m) => (m.id === id ? { ...m, streaming: false, model: model ?? m.model, metrics: metrics ?? m.metrics } : m));
        }
        return [...rest, { id, role: "assistant", content: blocks, streaming, model, metrics }];
      });
    },
    [setMessages],
  );

  const beginTurn = useCallback(() => {
    turnId.current = `a-${Date.now()}`;
    turnActiveRef.current = true;
    blocksRef.current = [];
    toolsRef.current = {};
    metricsRef.current = undefined;
    modelRef.current = undefined;
    turnStartRef.current = Date.now();
    setToolResults({});
    setMessages((prev) => [
      ...prev,
      { id: turnId.current, role: "assistant", content: [], streaming: true },
    ]);
    // Stream a live elapsed-seconds counter under the bubble while the turn
    // runs. The SDK only reports duration once (in the final `result`), so
    // without this the time never moves until completion — cc CLI ticks it.
    stopTimer();
    timerRef.current = setInterval(() => {
      if (!turnActiveRef.current || turnStartRef.current === null) return;
      const elapsedSeconds = Math.floor((Date.now() - turnStartRef.current) / 1000);
      if (elapsedSeconds <= 0) return;
      metricsRef.current = { ...metricsRef.current, elapsedSeconds };
      patchTurnMessage(true);
    }, 1000);
  }, [setMessages, stopTimer, patchTurnMessage]);

  const ensureActiveTurn = useCallback(() => {
    if (turnActiveRef.current) return;
    turnActiveRef.current = true;
    turnId.current = `a-${Date.now()}`;
    turnStartRef.current = Date.now();
    stopTimer();
    timerRef.current = setInterval(() => {
      if (!turnActiveRef.current || turnStartRef.current === null) return;
      const elapsedSeconds = Math.floor((Date.now() - turnStartRef.current) / 1000);
      if (elapsedSeconds <= 0) return;
      metricsRef.current = { ...metricsRef.current, elapsedSeconds };
      patchTurnMessage(true);
    }, 1000);
  }, [stopTimer, patchTurnMessage]);

  const resetTurn = useCallback(() => {
    stopTimer();
    turnActiveRef.current = false;
    blocksRef.current = [];
    toolsRef.current = {};
    metricsRef.current = undefined;
    modelRef.current = undefined;
    turnStartRef.current = null;
    setToolResults({});
  }, [stopTimer]);

  const endTurn = useCallback(() => {
    stopTimer();
    turnStartRef.current = null;
    const id = turnId.current;
    if (!turnActiveRef.current) {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
      return;
    }
    turnActiveRef.current = false;
    const blocks = [...blocksRef.current];
    const metrics = metricsRef.current;
    const model = modelRef.current;
    setMessages((prev) => {
      const rest = prev.filter((m) => m.id !== id);
      if (blocks.length === 0) {
        return prev.map((m) => (m.id === id ? { ...m, streaming: false, model: model ?? m.model, metrics: metrics ?? m.metrics } : m));
      }
      return [...rest, { id, role: "assistant", content: blocks, streaming: false, model, metrics }];
    });
    blocksRef.current = [];
    metricsRef.current = undefined;
    modelRef.current = undefined;
  }, [setMessages, stopTimer]);

  useEffect(() => stopTimer, [stopTimer]);

  const onSdkEvent = useCallback(
    (msg: unknown) => {
      const m = msg as { type?: string };
      const applied = applySdkMessage(blocksRef.current, toolsRef.current, msg);
      blocksRef.current = applied.blocks;
      toolsRef.current = applied.toolResults;
      metricsRef.current = mergeMetrics(metricsRef.current, applied.metrics);
      modelRef.current = applied.model ?? modelRef.current;
      setToolResults({ ...applied.toolResults });

      if (m.type === "user") {
        return;
      }

      if (isTurnDoneMessage(msg)) {
        patchTurnMessage(false);
        endTurn();
        return;
      }

      if (!turnActiveRef.current) {
        ensureActiveTurn();
      }

      patchTurnMessage(true);
    },
    [endTurn, ensureActiveTurn, patchTurnMessage],
  );

  return { beginTurn, onSdkEvent, endTurn, resetTurn, toolResults };
}
