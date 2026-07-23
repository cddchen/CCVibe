import { randomUUID, type UUID } from "node:crypto";
import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionRegistry } from "../permission/registry.js";
import type { RuntimeStatus, SessionStatus, TurnStatus } from "../events/types.js";
import { log } from "../logger.js";
import type {
  EngineAdapter,
  EngineInterruptReceipt,
  EnginePermissionContext,
} from "./engine.js";
import type { PermissionMode, SessionCreateOptions } from "./types.js";
import type { EffortLevel } from "../settings/reader.js";

type TurnState = {
  id: UUID;
  status: TurnStatus;
};

type PendingPermissionPrompt = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  context: EnginePermissionContext;
};

function isResultError(message: { subtype?: string; is_error?: boolean }): boolean {
  return message.is_error === true || message.subtype?.startsWith("error_") === true || message.subtype === "error";
}

function isLimitedResult(subtype?: string): boolean {
  return subtype === "error_max_turns" || subtype === "error_max_budget_usd";
}

export type { EngineAdapter } from "./engine.js";

export class SessionRunner {
  readonly runtimeId: string;
  sessionId: string | null = null;
  conversationId: string;
  readonly cwd: string;
  private subscribers = new Map<string, ClientConnection>();
  private permissionOwner: ClientConnection | undefined;
  private permissionRegistry: PermissionRegistry | undefined;
  private pendingPermissionPrompts = new Map<string, PendingPermissionPrompt>();
  private sessionStatus: SessionStatus = "starting";
  private runtimeStatus: RuntimeStatus = "starting";
  private currentTurn: TurnState | undefined;
  private queuedTurns: TurnState[] = [];
  private engineStarted = false;
  private runtimeTerminal = false;
  private onRuntimeTerminal?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleMs = 600_000;
  private onReclaim?: () => void;
  private onConversationFinished?: (lastConversationAt: number) => void;
  private lastConversationAt = Date.now();
  private turnBuffer: unknown[] = [];
  private readonly maxTurnBuffer = 4000;

  constructor(
    runtimeId: string,
    cwd: string,
    private readonly engine: EngineAdapter,
  ) {
    this.runtimeId = runtimeId;
    this.conversationId = runtimeId;
    this.cwd = cwd;
  }

  bindConversationId(id: string): void {
    this.conversationId = id;
  }

  getStatus(): SessionStatus {
    return this.sessionStatus;
  }

  getRuntimeStatus(): RuntimeStatus {
    return this.runtimeStatus;
  }

  getTurnStatus(): TurnState | undefined {
    return this.currentTurn ? { ...this.currentTurn } : undefined;
  }

  isRuntimeActive(): boolean {
    return this.runtimeStatus !== "closed" && this.runtimeStatus !== "crashed";
  }

  setReclaimHandler(fn: () => void, idleMs?: number): void {
    this.onReclaim = fn;
    if (idleMs !== undefined) this.idleMs = idleMs;
  }

  getLastConversationAt(): number {
    return this.lastConversationAt;
  }

  isEvictable(): boolean {
    return this.isRuntimeActive()
      && this.engineStarted
      && !this.currentTurn
      && this.queuedTurns.length === 0
      && this.sessionStatus !== "starting"
      && this.sessionStatus !== "running"
      && this.sessionStatus !== "waiting_permission"
      && this.sessionStatus !== "closing";
  }

  setRuntimeTerminalHandler(fn: () => void): void {
    this.onRuntimeTerminal = fn;
  }

  setConversationFinishedHandler(fn: (lastConversationAt: number) => void): void {
    this.onConversationFinished = fn;
  }

  private markConversationFinished(): void {
    this.lastConversationAt = Date.now();
    this.onConversationFinished?.(this.lastConversationAt);
  }

  private scheduleReclaim(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.isEvictable()) this.onReclaim?.();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearReclaimTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearTurnBuffer(): void {
    this.turnBuffer = [];
  }

  private sendEventTo(conn: ClientConnection, message: unknown): void {
    const sid = this.sessionId ?? this.runtimeId;
    const payload = {
      jsonrpc: "2.0" as const,
      method: "session/event",
      params: { conversationId: this.conversationId, sessionId: sid, runtimeId: this.runtimeId, message },
    };
    try {
      conn.send(payload);
    } catch {
      // Broken subscribers are removed when their connection closes.
    }
  }

  subscribe(conn: ClientConnection, claimPermissions = false): void {
    this.subscribers.set(conn.id, conn);
    if (claimPermissions || !this.permissionOwner) {
      this.claimPermissionOwnership(conn);
    }
    for (const message of this.turnBuffer) this.sendEventTo(conn, message);
  }

  unsubscribe(connId: string): void {
    this.subscribers.delete(connId);
    if (this.permissionOwner?.id === connId) {
      this.permissionOwner = undefined;
      const nextOwner = [...this.subscribers.values()].at(-1);
      if (nextOwner) this.claimPermissionOwnership(nextOwner);
    }
  }

  private claimPermissionOwnership(conn: ClientConnection): void {
    this.permissionOwner = conn;
    this.permissionRegistry?.claimSession(this.runtimeId, conn.id);
    for (const prompt of this.pendingPermissionPrompts.values()) {
      this.sendPermissionRequest(conn, prompt);
    }
    if (this.engineStarted && this.isRuntimeActive()) {
      void this.reinitializeInteractiveState();
    }
  }

  private async reinitializeInteractiveState(): Promise<void> {
    try {
      await this.engine.reinitialize(this.runtimeId);
    } catch (error) {
      log.warn("session reinitialize failed", {
        runtimeId: this.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  notify(method: string, params: unknown): void {
    const payload = { jsonrpc: "2.0", method, params };
    for (const conn of this.subscribers.values()) {
      try {
        conn.send(payload);
      } catch {
        // Broken subscribers are removed when their connection closes.
      }
    }
  }

  pushEvent(message: unknown): void {
    this.turnBuffer.push(message);
    if (this.turnBuffer.length > this.maxTurnBuffer) this.turnBuffer.shift();
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("session/event", { conversationId: this.conversationId, sessionId: sid, runtimeId: this.runtimeId, message });
    const typed = message as { type?: string };
    if (typed.type === "result") this.clearTurnBuffer();
  }

  setStatus(status: SessionStatus, error?: string): void {
    this.sessionStatus = status;
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("session/status", { conversationId: this.conversationId, sessionId: sid, runtimeId: this.runtimeId, status, error });
  }

  private setRuntimeStatus(status: RuntimeStatus, error?: string): void {
    this.runtimeStatus = status;
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("runtime/status", { conversationId: this.conversationId, sessionId: sid, runtimeId: this.runtimeId, status, error });
  }

  private setTurnStatus(turn: TurnState, status: TurnStatus, error?: string, resultSubtype?: string): void {
    turn.status = status;
    const sid = this.sessionId ?? this.runtimeId;
    this.notify("turn/status", {
      sessionId: sid,
      conversationId: this.conversationId,
      runtimeId: this.runtimeId,
      turnId: turn.id,
      status,
      error,
      resultSubtype,
    });
  }

  bindSessionId(id: string): void {
    this.sessionId = id;
    if (id !== this.runtimeId) this.resolveSessionIdWaiters(id);
  }

  private sessionIdWaiters: Array<{ resolve: (id: string) => void; reject: (error: Error) => void }> = [];

  private resolveSessionIdWaiters(id: string): void {
    for (const waiter of this.sessionIdWaiters) waiter.resolve(id);
    this.sessionIdWaiters = [];
  }

  waitForSessionId(timeoutMs = 30_000): Promise<string> {
    if (this.sessionId && this.sessionId !== this.runtimeId) return Promise.resolve(this.sessionId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionIdWaiters = this.sessionIdWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error("session init timeout"));
      }, timeoutMs);
      this.sessionIdWaiters.push({
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async startWithEngine(
    opts: SessionCreateOptions,
    permissions: PermissionRegistry,
    onSessionId?: (sessionId: string) => void,
  ): Promise<void> {
    this.bindSessionId(this.runtimeId);
    this.permissionRegistry = permissions;
    log.info("session runner starting", { runtimeId: this.runtimeId, cwd: opts.cwd });

    await this.engine.start(
      opts,
      {
        onMessage: (message) => {
          const typed = message as {
            type?: string;
            subtype?: string;
            session_id?: string;
            errors?: string[];
            is_error?: boolean;
          };
          if (typed.type === "system" && typed.subtype === "init" && typed.session_id) {
            log.info("session init", { runtimeId: this.runtimeId, session_id: typed.session_id });
            this.bindSessionId(typed.session_id);
            onSessionId?.(typed.session_id);
            this.setRuntimeStatus("running");
            this.setStatus(
              this.currentTurn?.status === "waiting_permission"
                ? "waiting_permission"
                : this.currentTurn
                  ? "running"
                  : "idle",
            );
          }

          this.pushEvent(message);
          if (typed.type === "result") this.handleResult(typed);
        },
        onRuntimeClosed: (error) => this.finalizeRuntime(error),
        canUseTool: async (toolName, input, context) => {
          const sessionId = this.sessionId ?? this.runtimeId;
          const owner = this.permissionOwner;
          const turn = this.currentTurn;
          const prompt: PendingPermissionPrompt = {
            sessionId,
            requestId: context.requestId,
            toolName,
            input,
            context,
          };
          this.pendingPermissionPrompts.set(context.requestId, prompt);
          if (turn && turn.status !== "interrupted") {
            this.setTurnStatus(turn, "waiting_permission");
            this.setStatus("waiting_permission");
          }

          if (owner) this.sendPermissionRequest(owner, prompt);
          try {
            return await permissions.waitForResponse(this.runtimeId, context.requestId, owner?.id, {
              signal: context.signal,
            });
          } finally {
            if (this.pendingPermissionPrompts.get(context.requestId) === prompt) {
              this.pendingPermissionPrompts.delete(context.requestId);
            }
            if (turn && this.currentTurn === turn && turn.status === "waiting_permission") {
              this.setTurnStatus(turn, "running");
              this.setStatus("running");
            }
          }
        },
      },
      this.runtimeId,
    );

    this.engineStarted = true;
    if (this.runtimeStatus === "starting") this.setRuntimeStatus("running");
    if (this.sessionStatus === "starting") this.setStatus("idle");
  }

  private sendPermissionRequest(
    owner: ClientConnection,
    prompt: PendingPermissionPrompt,
  ): void {
    const { sessionId, requestId, toolName, input, context } = prompt;
    try {
      owner.send({
        jsonrpc: "2.0",
        method: "permission/request",
        params: {
          sessionId,
          conversationId: this.conversationId,
          runtimeId: this.runtimeId,
          requestId,
          toolName,
          input,
          toolUseId: context.toolUseId,
          agentId: context.agentId,
          suggestions: context.suggestions,
          title: context.title,
          displayName: context.displayName,
          description: context.description,
          blockedPath: context.blockedPath,
          decisionReason: context.decisionReason,
        },
      });
    } catch (error) {
      log.warn("permission request delivery failed", {
        runtimeId: this.runtimeId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleResult(message: { subtype?: string; errors?: string[]; is_error?: boolean }): void {
    const turn = this.currentTurn;
    if (turn) {
      if (turn.status !== "interrupted") {
        const error = message.errors?.join("; ");
        if (isLimitedResult(message.subtype)) {
          this.setTurnStatus(turn, "limited", error, message.subtype);
        } else if (isResultError(message)) {
          this.setTurnStatus(turn, "failed", error ?? message.subtype, message.subtype);
        } else {
          this.setTurnStatus(turn, "completed", undefined, message.subtype);
        }
      }
      this.currentTurn = undefined;
      this.markConversationFinished();
    }
    this.startNextQueuedTurn();
  }

  private startNextQueuedTurn(): void {
    const next = this.queuedTurns.shift();
    if (!next) {
      if (this.isRuntimeActive() && this.sessionStatus !== "closing") {
        this.setStatus("idle");
        this.scheduleReclaim();
      }
      return;
    }
    this.currentTurn = next;
    this.setTurnStatus(next, "running");
    this.setStatus("running");
  }

  private finalizeRuntime(error?: Error): void {
    if (this.runtimeTerminal) return;
    this.runtimeTerminal = true;

    if (this.currentTurn && this.currentTurn.status !== "completed") {
      this.setTurnStatus(
        this.currentTurn,
        error ? "failed" : "interrupted",
        error?.message,
      );
      this.currentTurn = undefined;
    }
    for (const queued of this.queuedTurns.splice(0)) {
      this.setTurnStatus(queued, "interrupted", error?.message);
    }

    if (error) {
      this.setRuntimeStatus("crashed", error.message);
      this.setStatus("error", error.message);
    } else {
      this.setRuntimeStatus("closed");
      this.setStatus("closed");
    }
    this.onRuntimeTerminal?.();
  }

  async send(content: string): Promise<{ turnId: string }> {
    if (!this.isRuntimeActive() || !this.engineStarted) throw new Error("session runtime is not active");
    this.clearReclaimTimer();
    this.lastConversationAt = Date.now();
    const turn: TurnState = { id: randomUUID(), status: "queued" };
    this.clearTurnBuffer();

    if (this.currentTurn) {
      this.queuedTurns.push(turn);
      this.setTurnStatus(turn, "queued");
    } else {
      this.currentTurn = turn;
      this.setTurnStatus(turn, "running");
      this.setStatus("running");
    }

    try {
      await this.engine.send(this.runtimeId, { id: turn.id, content });
      return { turnId: turn.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.currentTurn === turn) this.currentTurn = undefined;
      else this.queuedTurns = this.queuedTurns.filter((queued) => queued !== turn);
      this.setTurnStatus(turn, "failed", message);
      this.markConversationFinished();
      this.startNextQueuedTurn();
      throw error;
    }
  }

  async interrupt(): Promise<EngineInterruptReceipt> {
    const receipt = await this.engine.interrupt(this.runtimeId);
    const stillQueued = new Set(receipt?.still_queued ?? []);

    if (this.currentTurn && !stillQueued.has(this.currentTurn.id)) {
      this.setTurnStatus(this.currentTurn, "interrupted");
    }
    if (receipt) {
      const retained: TurnState[] = [];
      for (const queued of this.queuedTurns) {
        if (stillQueued.has(queued.id)) retained.push(queued);
        else this.setTurnStatus(queued, "interrupted");
      }
      this.queuedTurns = retained;
    }

    if (!this.currentTurn && this.queuedTurns.length === 0) {
      this.markConversationFinished();
      this.setStatus("idle");
      this.scheduleReclaim();
    }
    return receipt;
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.engine.setPermissionMode(this.runtimeId, mode);
  }

  setModel(model?: string): Promise<void> {
    return this.engine.setModel(this.runtimeId, model);
  }

  setEffort(effort: EffortLevel): Promise<void> {
    return this.engine.setEffort(this.runtimeId, effort);
  }

  async stop(): Promise<void> {
    if (this.runtimeTerminal) return;
    this.clearReclaimTimer();
    this.setStatus("closing");
    this.setRuntimeStatus("closing");
    await this.engine.stop(this.runtimeId);
    this.finalizeRuntime();
  }
}
