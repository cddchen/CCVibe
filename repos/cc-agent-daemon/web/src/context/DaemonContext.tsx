import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DaemonClient } from "../lib/daemonClient";

type Ctx = {
  client: DaemonClient | null;
  connected: boolean;
  error: string | null;
  token: string;
  setToken: (t: string) => void;
  wsUrl: string;
  setWsUrl: (u: string, reconnectNow?: boolean) => void;
  reconnect: () => void;
};

const DaemonCtx = createContext<Ctx | null>(null);

export function DaemonProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState(() => localStorage.getItem("cc_daemon_token") || "");
  const [wsUrl, setWsUrlState] = useState(() => localStorage.getItem("cc_daemon_ws_url") || "");
  const [client, setClient] = useState<DaemonClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reconnect = () => setTick((t) => t + 1);

  const setToken = (t: string) => {
    setTokenState(t);
    localStorage.setItem("cc_daemon_token", t);
    reconnect();
  };

  const setWsUrl = (u: string, reconnectNow = false) => {
    setWsUrlState(u);
    localStorage.setItem("cc_daemon_ws_url", u);
    if (reconnectNow) reconnect();
  };

  useEffect(() => {
    const c = new DaemonClient(token);
    setClient(c);
    setConnected(false);
    setError(null);
    c.connect()
      .then(() => setConnected(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      c.close();
    };
  }, [token, wsUrl, tick]);

  const value = useMemo(
    () => ({ client, connected, error, token, setToken, wsUrl, setWsUrl, reconnect }),
    [client, connected, error, token, wsUrl],
  );

  return <DaemonCtx.Provider value={value}>{children}</DaemonCtx.Provider>;
}

export function useDaemon() {
  const v = useContext(DaemonCtx);
  if (!v) throw new Error("useDaemon outside provider");
  return v;
}