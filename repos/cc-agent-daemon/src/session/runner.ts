import { randomUUID, type UUID } from "node:crypto";
import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionRegistry } from "../permission/registry.js";
import type { RuntimeStatus, SessionStatus, TurnStatus } from "../events/types.js";
import { log } from "../logger.js";
import type {
  EngineAdapter,
  EngineInterruptReceipt,
} from "./engine.js";
import type { PermissionMode, SessionCreateOptions } from "./types.js";
import type { EffortLevel } from "../settings/reader.js";
import { ConversationProjector } from "../conversation/projector.js";
import type {
  ConversationEvent,
  ConversationEventEnvelope,
  ConversationMessage,
  MessageLifecycleEvent,
} from "../conversation/types.js";

type TurnState = {
  id: UUID;
  status: TurnStatus;
};

export type ActiveTurnSnapshot = {
  turnId: string;
  status: TurnStatus;
  messages: ConversationMessage[];
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
  private sessionStatus: SessionStatus = "starting";
  private runtimeStatus: RuntimeStatus = "starting";
  private currentTurn: TurnState | undefined;
  private engineStarted = false;
  private runtimeTerminal = false;
  private onRuntimeTerminal?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleMs = 600_000;
  private onReclaim?: () => void;
  private onConversationFinished?: (lastConversationAt: number) => void;
  private lastConversationAt = Date.now();
  private turnBuffer: ConversationEventEnvelope[] = [];
  private readonly maxTurnBuffer = 4000;
  private sequence = 0;
  private readonly projectors = new Map<string, ConversationProjector>();
  private readonly liveMessages = new Map<string, ConversationMessage>();
  private readonly pendingMessageUpdates = new Map<string, MessageLifecycleEvent>();
  private updateFlushTimer?: ReturnType<typeof setTimeout>;

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
    if (this.updateFlushTimer) clearTimeout(this.updateFlushTimer);
    this.updateFlushTimer = undefined;
    this.pendingMessageUpdates.clear();
    this.turnBuffer = [];
    this.liveMessages.clear();
  }

  private sendEnvelopeTo(conn: ClientConnection, envelope: ConversationEventEnvelope): void {
    try {
      conn.send({ jsonrpc: "2.0", method: "conversation/event", params: envelope });
    } catch {
      // Broken subscribers are removed when their connection closes.
    }
  }

  private envelope(event: ConversationEvent, incrementSequence = true): ConversationEventEnvelope {
    if (incrementSequence) this.sequence += 1;
    return {
      version: 1,
      sequence: this.sequence,
      conversationId: this.conversationId,
      sessionId: this.sessionId ?? this.runtimeId,
      runtimeId: this.runtimeId,
      timestamp: new Date().toISOString(),
      event,
    };
  }

  private publishImmediate(event: ConversationEvent): void {
    const envelope = this.envelope(event);
    this.turnBuffer.push(envelope);
    if (this.turnBuffer.length > this.maxTurnBuffer) this.turnBuffer.shift();
    for (const conn of this.subscribers.values()) this.sendEnvelopeTo(conn, envelope);
  }

  private flushPendingMessageUpdates(): void {
    if (this.updateFlushTimer) clearTimeout(this.updateFlushTimer);
    this.updateFlushTimer = undefined;
    const updates = [...this.pendingMessageUpdates.values()];
    this.pendingMessageUpdates.clear();
    for (const update of updates) this.publishImmediate(update);
  }

  private publish(event: ConversationEvent): void {
    if (event.type === "message_update") {
      this.pendingMessageUpdates.set(event.message.id, event);
      if (!this.updateFlushTimer) {
        this.updateFlushTimer = setTimeout(() => this.flushPendingMessageUpdates(), 40);
        this.updateFlushTimer.unref?.();
      }
      return;
    }
    this.flushPendingMessageUpdates();
    this.publishImmediate(event);
  }

  private publishLifecycle(events: MessageLifecycleEvent[]): void {
    for (const event of events) {
      this.liveMessages.set(event.message.id, structuredClone(event.message));
      this.publish(event);
    }
  }

  private currentProjector(): ConversationProjector | undefined {
    return this.currentTurn ? this.projectors.get(this.currentTurn.id) : undefined;
  }

  publishMessage(message: ConversationMessage): void {
    this.publishLifecycle([
      { type: "message_start", message: structuredClone(message) },
      { type: "message_end", message: structuredClone(message) },
    ]);
  }

  getLiveMessages(): ConversationMessage[] {
    return [...this.liveMessages.values()].map((message) => structuredClone(message));
  }

  getActiveTurnSnapshot(): ActiveTurnSnapshot | undefined {
    this.flushPendingMessageUpdates();
    const turn = this.currentTurn;
    if (!turn) return undefined;
    return {
      turnId: turn.id,
      status: turn.status,
      messages: [...this.liveMessages.values()]
        .filter((message) => "turnId" in message && message.turnId === turn.id)
        .map((message) => structuredClone(message)),
    };
  }

  getSequence(): number {
    this.flushPendingMessageUpdates();
    return this.sequence;
  }

  subscribe(conn: ClientConnection, reinitializeInteractiveState = false): void {
    this.flushPendingMessageUpdates();
    this.subscribers.set(conn.id, conn);
    for (const envelope of this.turnBuffer) this.sendEnvelopeTo(conn, envelope);
    if (reinitializeInteractiveState && this.engineStarted && this.isRuntimeActive()) {
      void this.reinitializeInteractiveState();
    }
  }

  unsubscribe(connId: string): void {
    this.subscribers.delete(connId);
  }

  hasSubscriber(connId: string): boolean {
    return this.subscribers.has(connId);
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

  setStatus(status: SessionStatus, error?: string): void {
    this.sessionStatus = status;
    this.publish({ type: "conversation_status", status, error });
  }

  private setRuntimeStatus(status: RuntimeStatus, error?: string): void {
    this.runtimeStatus = status;
    this.publish({ type: "runtime_status", status, error });
  }

  private setTurnStatus(turn: TurnState, status: TurnStatus, error?: string, resultSubtype?: string): void {
    turn.status = status;
    this.publish({
      type: "turn_status",
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
            model?: string;
            cwd?: string;
            slash_commands?: unknown[];
          };
          if (typed.type === "system" && typed.subtype === "init" && typed.session_id) {
            log.info("session init", { runtimeId: this.runtimeId, session_id: typed.session_id });
            this.bindSessionId(typed.session_id);
            onSessionId?.(typed.session_id);
            this.publish({
              type: "runtime_initialized",
              sdkSessionId: typed.session_id,
              model: typed.model,
              cwd: typed.cwd,
              slashCommands: typed.slash_commands,
            });
            this.setRuntimeStatus("running");
            this.setStatus(
              this.currentTurn?.status === "waiting_permission"
                ? "waiting_permission"
                : this.currentTurn
                  ? "running"
                  : "idle",
            );
          }

          this.publishLifecycle(this.currentProjector()?.accept(message) ?? []);
          if (typed.type === "result") this.handleResult(typed);
        },
        onRuntimeClosed: (error) => this.finalizeRuntime(error),
        canUseTool: async (toolName, input, context) => {
          const turn = this.currentTurn;
          if (turn && turn.status !== "interrupted") {
            this.publishLifecycle(this.currentProjector()?.setToolStatus(context.toolUseId, "waiting_permission") ?? []);
            this.setTurnStatus(turn, "waiting_permission");
            this.setStatus("waiting_permission");
          }

          this.publish({
            type: "permission_request",
            requestId: context.requestId,
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
          });
          try {
            const decision = await permissions.waitForResponse(this.runtimeId, context.requestId, {
              signal: context.signal,
            });
            this.publish({
              type: "permission_resolved",
              requestId: context.requestId,
              behavior: decision.behavior,
              reason: decision.behavior === "deny" ? decision.message : undefined,
            });
            this.publishLifecycle(this.currentProjector()?.setToolStatus(
              context.toolUseId,
              decision.behavior === "allow" ? "running" : "denied",
            ) ?? []);
            return decision;
          } finally {
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
      this.projectors.delete(turn.id);
      this.markConversationFinished();
    }
    // The SDK result is the persistence boundary: completed history now belongs
    // exclusively to Claude Code JSONL, so no live turn state is retained.
    this.clearTurnBuffer();
    if (this.isRuntimeActive() && this.sessionStatus !== "closing") {
      this.setStatus("idle");
      this.scheduleReclaim();
    }
  }

  private finalizeRuntime(error?: Error): void {
    if (this.runtimeTerminal) return;
    this.runtimeTerminal = true;

    if (this.currentTurn && this.currentTurn.status !== "completed") {
      this.publishLifecycle(this.currentProjector()?.finish(error ? "failed" : "interrupted") ?? []);
      this.setTurnStatus(
        this.currentTurn,
        error ? "failed" : "interrupted",
        error?.message,
      );
      this.projectors.delete(this.currentTurn.id);
      this.currentTurn = undefined;
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
    if (this.currentTurn) throw new Error("conversation already has an active turn");
    this.clearReclaimTimer();
    this.lastConversationAt = Date.now();
    const turn: TurnState = { id: randomUUID(), status: "running" };
    this.clearTurnBuffer();
    const projector = new ConversationProjector();
    this.projectors.set(turn.id, projector);
    this.publishLifecycle(projector.beginTurn(turn.id, content));
    this.currentTurn = turn;
    this.setTurnStatus(turn, "running");
    this.setStatus("running");

    try {
      await this.engine.send(this.runtimeId, { id: turn.id, content });
      return { turnId: turn.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.currentTurn === turn) this.currentTurn = undefined;
      this.publishLifecycle(projector.finish("failed"));
      this.projectors.delete(turn.id);
      this.setTurnStatus(turn, "failed", message);
      this.markConversationFinished();
      this.clearTurnBuffer();
      if (this.isRuntimeActive() && this.sessionStatus !== "closing") {
        this.setStatus("idle");
        this.scheduleReclaim();
      }
      throw error;
    }
  }

  async interrupt(): Promise<EngineInterruptReceipt> {
    const receipt = await this.engine.interrupt(this.runtimeId);
    const stillQueued = new Set(receipt?.still_queued ?? []);

    if (this.currentTurn && !stillQueued.has(this.currentTurn.id)) {
      this.publishLifecycle(this.currentProjector()?.finish("interrupted") ?? []);
      this.setTurnStatus(this.currentTurn, "interrupted");
      this.projectors.delete(this.currentTurn.id);
    }
    if (!this.currentTurn) {
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
    this.flushPendingMessageUpdates();
    this.setStatus("closing");
    this.setRuntimeStatus("closing");
    await this.engine.stop(this.runtimeId);
    this.finalizeRuntime();
  }
}
