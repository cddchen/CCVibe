import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DaemonClient } from "../lib/daemonClient";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type Ctx = {
  client: DaemonClient | null;
  status: ConnectionStatus;
  connected: boolean;
  error: string | null;
  token: string;
  wsUrl: string;
  connect: (wsUrl: string, token: string) => void;
  disconnect: () => void;
};

const DaemonCtx = createContext<Ctx | null>(null);

export function DaemonProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => localStorage.getItem("cc_daemon_token") || "");
  const [wsUrl, setWsUrl] = useState(() => localStorage.getItem("cc_daemon_ws_url") || "");
  const [client, setClient] = useState<DaemonClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    localStorage.getItem("cc_daemon_token") ? "connecting" : "disconnected",
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(() => (localStorage.getItem("cc_daemon_token") ? 1 : 0));

  const connect = (nextWsUrl: string, nextToken: string) => {
    localStorage.setItem("cc_daemon_ws_url", nextWsUrl);
    localStorage.setItem("cc_daemon_token", nextToken);
    setWsUrl(nextWsUrl);
    setToken(nextToken);
    setError(null);
    setStatus("connecting");
    setAttempt((a) => a + 1);
  };

  const disconnect = () => {
    client?.close();
    setStatus("disconnected");
  };

  useEffect(() => {
    if (attempt === 0) return;
    const c = new DaemonClient(token);
    setClient(c);
    setStatus("connecting");
    setError(null);
    c.connect()
      .then(() => setStatus("connected"))
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("disconnected");
      });
    return () => {
      c.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const value = useMemo(
    () => ({ client, status, connected: status === "connected", error, token, wsUrl, connect, disconnect }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, status, error, token, wsUrl],
  );

  return <DaemonCtx.Provider value={value}>{children}</DaemonCtx.Provider>;
}

export function useDaemon() {
  const v = useContext(DaemonCtx);
  if (!v) throw new Error("useDaemon outside provider");
  return v;
}
