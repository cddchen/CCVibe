export function shouldReplaceChatUrlFromInit(historySessionId: string | null): boolean {
  return historySessionId === null;
}

export function chatNotifyBindOptions(liveSessionId: string | null): { acceptAny: true } | { sessionIds: string[] } {
  return liveSessionId ? { sessionIds: [liveSessionId] } : { acceptAny: true };
}

export function liveTurnIsBusy(status?: string): boolean {
  return status === "running"
    || status === "starting"
    || status === "waiting_permission"
    || status === "closing";
}

export type SessionRunState = "running" | "completed" | "error" | "interrupted";

/** Map daemon runner status to UI run state when re-attaching after a tab/session switch. */
export function runStateFromDaemonStatus(status?: string): SessionRunState {
  if (liveTurnIsBusy(status)) return "running";
  if (status === "error") return "error";
  return "completed";
}
