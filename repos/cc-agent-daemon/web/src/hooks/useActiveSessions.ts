import { useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemonClient";

export type ActiveKind = "running" | "alive";

type ActiveSessionRow = {
  sessionId: string;
  cwd: string;
  status: string;
  subscriberCount: number;
};

export function mapActiveSessions(rows: ActiveSessionRow[]): Record<string, ActiveKind> {
  const out: Record<string, ActiveKind> = {};
  for (const row of rows) {
    out[row.sessionId] = row.status === "running" ? "running" : "alive";
  }
  return out;
}

export function useActiveSessions(
  client: DaemonClient | null,
  connected: boolean,
  reconnectNonce: number,
): Record<string, ActiveKind> {
  const [activeMap, setActiveMap] = useState<Record<string, ActiveKind>>({});

  useEffect(() => {
    if (!client || !connected) {
      setActiveMap({});
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const { sessions } = await client.call<{ sessions: ActiveSessionRow[] }>("session.listActive");
        if (!cancelled) setActiveMap(mapActiveSessions(sessions));
      } catch (e) {
        console.warn("[useActiveSessions] listActive failed", e);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 8000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, connected, reconnectNonce]);

  return activeMap;
}