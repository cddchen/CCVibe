import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useDaemon } from "./DaemonContext";

export type StreamEventMeta = {
  sessionId: string;
  runtimeId: string;
  sdkSessionId: string;
};

export type StreamHandlers = {
  onSdkEvent: (message: unknown, meta: StreamEventMeta) => void;
  onStatus: (status: string, error: string | undefined, meta: StreamEventMeta) => void;
  onPermission: (p: { sessionId: string; requestId: string | number; toolName: string; input?: unknown }) => void;
  onInit?: (p: { sessionId?: string; model?: string; cwd?: string; slashCommands?: unknown[] }, meta: StreamEventMeta) => void;
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
      const p = params as Record<string, unknown>;
      const evSid = String(p.sessionId ?? "");
      const runtimeId = String(p.runtimeId ?? "");
      const msg = p.message;
      const m = msg as { type?: string; subtype?: string; session_id?: string; model?: string; cwd?: string; slash_commands?: unknown[] };
      const sdkSessionId = String(m?.session_id ?? "");
      const meta = { sessionId: evSid, runtimeId, sdkSessionId };

      for (const bind of bindsRef.current) {
        if (!matches(bind, [evSid, runtimeId, sdkSessionId])) continue;

        if (method === "permission/request") {
          bind.handlers.onPermission({
            sessionId: evSid,
            requestId: p.requestId as string | number,
            toolName: String(p.toolName),
            input: p.input,
          });
        } else if (method === "session/event") {
          if (msg) bind.handlers.onSdkEvent(msg, meta);
          if (m?.type === "system" && m.subtype === "init") {
            bind.handlers.onInit?.({
              sessionId: m.session_id,
              model: m.model,
              cwd: m.cwd,
              slashCommands: m.slash_commands,
            }, meta);
          }
        } else if (method === "session/status") {
          bind.handlers.onStatus(p.status as string, p.error as string | undefined, meta);
        }
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
      bindsRef.current = bindsRef.current.filter((b) => b !== entry);
    };
  };

  return <ChatNotifyCtx.Provider value={{ bind }}>{children}</ChatNotifyCtx.Provider>;
}

export function useChatNotify() {
  const v = useContext(ChatNotifyCtx);
  if (!v) throw new Error("useChatNotify outside provider");
  return v;
}