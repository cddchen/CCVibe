export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

type Pending = {
  sessionId: string;
  ownerConnId: string;
  resolve: (d: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PermissionRegistry {
  private pending = new Map<string, Pending>();
  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  static requestKey(sessionId: string, requestId: string | number): string {
    return `${sessionId}::${String(requestId)}`;
  }

  waitForResponse(
    sessionId: string,
    requestId: string,
    ownerConnId: string,
    onTimeout?: () => void,
  ): Promise<PermissionDecision> {
    const key = PermissionRegistry.requestKey(sessionId, requestId);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`duplicate permission request: ${key}`));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        onTimeout?.();
        resolve({ behavior: "deny", message: "permission request timed out" });
      }, this.timeoutMs);
      this.pending.set(key, { sessionId, ownerConnId, resolve, timer });
    });
  }

  respond(
    sessionId: string,
    requestId: string | number,
    connId: string,
    decision: PermissionDecision,
  ): boolean {
    const key = PermissionRegistry.requestKey(sessionId, requestId);
    const p = this.pending.get(key);
    if (!p || p.ownerConnId !== connId) return false;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(decision);
    return true;
  }

  denyAllForSession(sessionId: string): void {
    for (const [key, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      p.resolve({ behavior: "deny", message: "session ended" });
      this.pending.delete(key);
    }
  }

  denyAllForConnection(connId: string): void {
    for (const [key, p] of this.pending) {
      if (p.ownerConnId !== connId) continue;
      clearTimeout(p.timer);
      p.resolve({ behavior: "deny", message: "permission client disconnected" });
      this.pending.delete(key);
    }
  }

  size(): number {
    return this.pending.size;
  }
}