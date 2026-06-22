import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionRegistry } from "../permission/registry.js";
import type { SessionCreateOptions } from "./types.js";
import type { SessionStatus } from "../events/types.js";
import { log } from "../logger.js";

export type EngineAdapter = {
  start(
    opts: SessionCreateOptions,
    hooks: {
      onMessage: (msg: unknown) => void;
      canUseTool: (
        toolName: string,
        input: Record<string, unknown>,
      ) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message?: string }>;
    },
    runtimeId: string,
  ): Promise<{ runtimeId: string; sessionId?: string }>;
  send(runtimeId: string, content: string): Promise<void>;
  interrupt(runtimeId: string): Promise<void>;
  setPermissionMode(runtimeId: string, mode: string): Promise<void>;
  stop(runtimeId: string): Promise<void>;
};

export class SessionRunner {
  readonly runtimeId: string;
  sessionId: string | null = null;
  readonly cwd: string;
  private subscribers = new Map<string, ClientConnection>();
  private status: SessionStatus = "starting";
  private engine: EngineAdapter;
  private onTerminal?: () => void;

  constructor(
    runtimeId: string,
    cwd: string,
    engine: EngineAdapter,
  ) {
    this.runtimeId = runtimeId;
    this.cwd = cwd;
    this.engine = engine;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  subscribe(conn: ClientConnection): void {
    this.subscribers.set(conn.id, conn);
  }

  unsubscribe(connId: string): void {
    this.subscribers.delete(connId);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  setTerminalCleanup(onTerminal: () => void): void {
    this.onTerminal = onTerminal;
  }

  notify(method: string, params: unknown): void {
    const payload = { jsonrpc: "2.0", method, params };
    for (const conn of this.subscribers.values()) {
      try {
        conn.send(payload);
      } catch {
        // drop slow/broken client
      }
    }
  }

  pushEvent(message: unknown): void {
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("session/event", { sessionId: sid, runtimeId: this.runtimeId, message });
  }

  setStatus(status: SessionStatus, error?: string): void {
    const wasTerminal = this.status === "completed" || this.status === "error";
    this.status = status;
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("session/status", { sessionId: sid, runtimeId: this.runtimeId, status, error });
    if (!wasTerminal && (status === "completed" || status === "error")) {
      this.onTerminal?.();
    }
  }

  bindSessionId(id: string): void {
    this.sessionId = id;
    if (id !== this.runtimeId) {
      this.resolveSessionIdWaiters(id);
    }
  }

  private sessionIdWaiters: Array<{ resolve: (id: string) => void; reject: (e: Error) => void }> = [];

  private resolveSessionIdWaiters(id: string): void {
    for (const w of this.sessionIdWaiters) w.resolve(id);
    this.sessionIdWaiters = [];
  }

  /** Wait until SDK system/init provides session_id (or timeout). */
  waitForSessionId(timeoutMs = 30_000): Promise<string> {
    if (this.sessionId && this.sessionId !== this.runtimeId) {
      return Promise.resolve(this.sessionId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionIdWaiters = this.sessionIdWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error("session init timeout"));
      }, timeoutMs);
      this.sessionIdWaiters.push({
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async startWithEngine(
    opts: SessionCreateOptions,
    permissions: PermissionRegistry,
    permissionConn: ClientConnection,
    onSessionId?: (sessionId: string) => void,
  ): Promise<void> {
    this.bindSessionId(this.runtimeId);
    log.info("session runner starting", { runtimeId: this.runtimeId, cwd: opts.cwd });

    await this.engine.start(
      opts,
      {
      onMessage: (msg) => {
        const m = msg as { type?: string; subtype?: string; session_id?: string; errors?: string[] };
        if (m.type === "system" && m.subtype === "init" && m.session_id) {
          log.info("session init", { runtimeId: this.runtimeId, session_id: m.session_id });
          this.bindSessionId(m.session_id);
          onSessionId?.(m.session_id);
          this.setStatus("running");
        }
        if (m.type === "result") {
          if (m.subtype === "error_during_execution" || m.subtype === "error") {
            const errMsg = m.errors?.join("; ") ?? m.subtype;
            log.error("session result error", { sessionId: this.sessionId, errMsg });
            this.setStatus("error", errMsg);
          } else {
            this.setStatus("completed");
          }
        }
        this.pushEvent(msg);
      },
      canUseTool: async (toolName, input) => {
        if (!this.sessionId) {
          return { behavior: "deny", message: "no session id" };
        }
        const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        permissionConn.send({
          jsonrpc: "2.0",
          method: "permission/request",
          params: {
            sessionId: this.sessionId,
            requestId,
            toolName,
            input,
          },
        });
        const decision = await permissions.waitForResponse(this.sessionId, requestId, permissionConn.id);
        if (decision.behavior === "allow") {
          return { behavior: "allow", updatedInput: decision.updatedInput };
        }
        return { behavior: "deny", message: decision.message };
      },
    },
      this.runtimeId,
    );

    this.setStatus("running");
  }

  send(content: string): Promise<void> {
    return this.engine.send(this.runtimeId, content);
  }

  interrupt(): Promise<void> {
    this.setStatus("interrupted");
    return this.engine.interrupt(this.runtimeId);
  }

  setPermissionMode(mode: string): Promise<void> {
    return this.engine.setPermissionMode(this.runtimeId, mode);
  }

  async stop(): Promise<void> {
    await this.engine.stop(this.runtimeId);
    this.setStatus("completed");
  }
}