export function shouldReplaceChatUrlFromInit(historySessionId: string | null): boolean {
  return historySessionId === null;
}

export function chatNotifyBindOptions(liveSessionId: string | null): { acceptAny: true } | { sessionIds: string[] } {
  return liveSessionId ? { sessionIds: [liveSessionId] } : { acceptAny: true };
}
