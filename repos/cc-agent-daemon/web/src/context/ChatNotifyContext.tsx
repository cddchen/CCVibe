import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useDaemon } from "./DaemonContext";
import type { ConversationEventEnvelope } from "../lib/daemonClient";

export type ConversationEventMeta = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
};

export type StreamHandlers = {
  onEvent: (envelope: ConversationEventEnvelope, meta: ConversationEventMeta) => void;
};

type Bind = {
  acceptAny: boolean;
  sessionIds: Set<string>;
  handlers: StreamHandlers;
};

function matches(bind: Bind, ids: string[]): boolean {
  const values = ids.filter(Boolean);
  if (values.length === 0) return bind.acceptAny;
  if (bind.acceptAny) return true;
  return values.some((id) => bind.sessionIds.has(id));
}

const ChatNotifyCtx = createContext<{
  bind: (opts: { acceptAny?: boolean; sessionIds?: string[] }, handlers: StreamHandlers) => () => void;
} | null>(null);

export function ChatNotifyProvider({ children }: { children: ReactNode }) {
  const { client } = useDaemon();
  const bindsRef = useRef<Bind[]>([]);

  useEffect(() => {
    if (!client) return;
    client.onNotification((method, params) => {
      if (method !== "conversation/event") return;
      const envelope = params as ConversationEventEnvelope;
      if (envelope.version !== 1 || !envelope.event) return;
      const meta = {
        conversationId: envelope.conversationId,
        sessionId: envelope.sessionId,
        runtimeId: envelope.runtimeId,
      };
      for (const bind of bindsRef.current) {
        if (!matches(bind, [meta.conversationId, meta.sessionId, meta.runtimeId])) continue;
        bind.handlers.onEvent(envelope, meta);
      }
    });
  }, [client]);

  const bind = (
    opts: { acceptAny?: boolean; sessionIds?: string[] },
    handlers: StreamHandlers,
  ) => {
    const entry: Bind = {
      acceptAny: opts.acceptAny ?? false,
      sessionIds: new Set((opts.sessionIds ?? []).filter(Boolean)),
      handlers,
    };
    bindsRef.current.push(entry);
    return () => {
      bindsRef.current = bindsRef.current.filter((bind) => bind !== entry);
    };
  };

  return <ChatNotifyCtx.Provider value={{ bind }}>{children}</ChatNotifyCtx.Provider>;
}

export function useChatNotify() {
  const value = useContext(ChatNotifyCtx);
  if (!value) throw new Error("useChatNotify outside provider");
  return value;
}
