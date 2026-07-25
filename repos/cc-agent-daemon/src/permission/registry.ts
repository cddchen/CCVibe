export type PermissionUpdate = Record<string, unknown>;

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message?: string };

type Pending = {
  sessionId: string;
  requestId: string;
  promise: Promise<PermissionDecision>;
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanups: Array<() => void>;
};

type WaitOptions = {
  signal?: AbortSignal;
  onTimeout?: () => void;
};

export class PermissionRegistry {
  private pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 120_000) {}

  static requestKey(sessionId: string, requestId: string | number): string {
    return `${sessionId}::${String(requestId)}`;
  }

  waitForResponse(
    sessionId: string,
    requestId: string,
    options: WaitOptions = {},
  ): Promise<PermissionDecision> {
    const key = PermissionRegistry.requestKey(sessionId, requestId);
    const existing = this.pending.get(key);
    if (existing) {
      this.attachAbortSignal(key, existing, options.signal);
      return existing.promise;
    }

    let resolvePromise!: (decision: PermissionDecision) => void;
    const promise = new Promise<PermissionDecision>((resolve) => {
      resolvePromise = resolve;
    });
    const pending: Pending = {
      sessionId,
      requestId,
      promise,
      resolve: resolvePromise,
      timer: setTimeout(() => {
        options.onTimeout?.();
        this.settle(key, { behavior: "deny", message: "permission request timed out" });
      }, this.timeoutMs),
      abortCleanups: [],
    };
    this.pending.set(key, pending);
    this.attachAbortSignal(key, pending, options.signal);
    return promise;
  }

  private attachAbortSignal(key: string, pending: Pending, signal?: AbortSignal): void {
    if (!signal) return;
    if (signal.aborted) {
      this.settle(key, { behavior: "deny", message: "permission request cancelled" });
      return;
    }
    const onAbort = () => {
      this.settle(key, { behavior: "deny", message: "permission request cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.abortCleanups.push(() => signal.removeEventListener("abort", onAbort));
  }

  private settle(key: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    for (const cleanup of pending.abortCleanups) cleanup();
    this.pending.delete(key);
    pending.resolve(decision);
    return true;
  }

  respond(
    sessionId: string,
    requestId: string | number,
    decision: PermissionDecision,
  ): boolean {
    const key = PermissionRegistry.requestKey(sessionId, requestId);
    return this.settle(key, decision);
  }

  denyAllForSession(sessionId: string): void {
    for (const [key, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue;
      this.settle(key, { behavior: "deny", message: "session ended" });
    }
  }

  hasPendingForSession(sessionId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  size(): number {
    return this.pending.size;
  }
}
