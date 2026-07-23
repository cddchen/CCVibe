import { randomUUID } from "node:crypto";
import type { EngineAdapter } from "./runner.js";
import { SessionRunner } from "./runner.js";
import type { SessionCreateOptions } from "./types.js";
import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionRegistry } from "../permission/registry.js";
import { log } from "../logger.js";

export type SessionRegistryOptions = {
  autoReclaimMs?: number;
  maxThreads?: number;
};

type EvictionCandidate = {
  runner: SessionRunner;
  lastConversationAt: number;
  sequence: number;
};

export class SessionRegistry {
  private runners = new Map<string, SessionRunner>();
  private readonly autoReclaimMs: number;
  private readonly maxThreads: number;
  private createTail: Promise<void> = Promise.resolve();
  private evictionQueue: EvictionCandidate[] = [];
  private evictionIndex = new Map<SessionRunner, number>();
  private evictionSequence = 0;

  constructor(
    private engineFactory: () => EngineAdapter,
    private permissions: PermissionRegistry,
    options: SessionRegistryOptions | number = {},
  ) {
    this.autoReclaimMs = typeof options === "number" ? options : options.autoReclaimMs ?? 600_000;
    this.maxThreads = typeof options === "number" ? 10 : options.maxThreads ?? 10;
  }

  get(sessionId: string): SessionRunner | undefined {
    return this.findRunner(sessionId);
  }

  findRunner(id: string): SessionRunner | undefined {
    const direct = this.runners.get(id);
    if (direct) return direct;
    for (const r of this.runners.values()) {
      if (r.sessionId === id || r.runtimeId === id) return r;
    }
    return undefined;
  }

  private registerRunner(keys: string[], runner: SessionRunner): void {
    for (const k of keys) {
      if (k) this.runners.set(k, runner);
    }
  }

  private unregisterRunner(runner: SessionRunner): void {
    for (const [k, r] of this.runners) {
      if (r === runner) this.runners.delete(k);
    }
    this.removeEvictionCandidate(runner);
  }

  private candidateBefore(a: EvictionCandidate, b: EvictionCandidate): boolean {
    return a.lastConversationAt < b.lastConversationAt
      || (a.lastConversationAt === b.lastConversationAt && a.sequence < b.sequence);
  }

  private swapCandidates(a: number, b: number): void {
    const left = this.evictionQueue[a];
    const right = this.evictionQueue[b];
    this.evictionQueue[a] = right;
    this.evictionQueue[b] = left;
    this.evictionIndex.set(right.runner, a);
    this.evictionIndex.set(left.runner, b);
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.candidateBefore(this.evictionQueue[index], this.evictionQueue[parent])) break;
      this.swapCandidates(index, parent);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.evictionQueue.length) break;
      let child = left;
      if (right < this.evictionQueue.length
        && this.candidateBefore(this.evictionQueue[right], this.evictionQueue[left])) {
        child = right;
      }
      if (!this.candidateBefore(this.evictionQueue[child], this.evictionQueue[index])) break;
      this.swapCandidates(index, child);
      index = child;
    }
  }

  private enqueueEvictionCandidate(runner: SessionRunner, lastConversationAt = runner.getLastConversationAt()): void {
    const candidate: EvictionCandidate = {
      runner,
      lastConversationAt,
      sequence: this.evictionSequence++,
    };
    const existingIndex = this.evictionIndex.get(runner);
    if (existingIndex !== undefined) {
      this.evictionQueue[existingIndex] = candidate;
      this.evictionIndex.set(runner, existingIndex);
      this.siftUp(existingIndex);
      this.siftDown(this.evictionIndex.get(runner) ?? existingIndex);
      return;
    }
    this.evictionQueue.push(candidate);
    const index = this.evictionQueue.length - 1;
    this.evictionIndex.set(runner, index);
    this.siftUp(index);
  }

  private popEvictionCandidate(): EvictionCandidate | undefined {
    const root = this.evictionQueue[0];
    const tail = this.evictionQueue.pop();
    if (!root || !tail) return root;
    this.evictionIndex.delete(root.runner);
    if (this.evictionQueue.length === 0) return root;
    this.evictionQueue[0] = tail;
    this.evictionIndex.set(tail.runner, 0);
    this.siftDown(0);
    return root;
  }

  private removeEvictionCandidate(runner: SessionRunner): void {
    const index = this.evictionIndex.get(runner);
    if (index === undefined) return;
    const tail = this.evictionQueue.pop();
    this.evictionIndex.delete(runner);
    if (!tail || index >= this.evictionQueue.length) return;
    this.evictionQueue[index] = tail;
    this.evictionIndex.set(tail.runner, index);
    this.siftUp(index);
    this.siftDown(this.evictionIndex.get(tail.runner) ?? index);
  }

  private oldestEvictableRunner(): SessionRunner | undefined {
    while (this.evictionQueue.length > 0) {
      const candidate = this.popEvictionCandidate();
      if (!candidate) return undefined;
      if (!candidate.runner.isEvictable()) continue;
      if (candidate.runner.getLastConversationAt() !== candidate.lastConversationAt) continue;
      return candidate.runner;
    }
    return undefined;
  }

  private uniqueActiveRunners(): SessionRunner[] {
    return [...new Set(this.runners.values())].filter((runner) => runner.isRuntimeActive());
  }

  private async ensureCapacity(): Promise<void> {
    const active = this.uniqueActiveRunners();
    if (active.length < this.maxThreads) return;
    const candidate = this.oldestEvictableRunner();
    if (!candidate) {
      throw new Error(`maximum active Claude threads reached (${this.maxThreads}); all threads are busy`);
    }
    log.info("session capacity evict", {
      runtimeId: candidate.runtimeId,
      conversationId: candidate.conversationId,
      lastConversationAt: new Date(candidate.getLastConversationAt()).toISOString(),
      maxThreads: this.maxThreads,
    });
    this.permissions.denyAllForSession(candidate.runtimeId);
    await candidate.stop();
    this.unregisterRunner(candidate);
  }

  listActive(): {
    conversationId: string;
    sessionId: string;
    runtimeId: string;
    cwd: string;
    status: string;
    runtimeStatus: string;
    turn?: { id: string; status: string };
    subscriberCount: number;
  }[] {
    const seen = new Set<SessionRunner>();
    const unique: SessionRunner[] = [];
    for (const r of this.runners.values()) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (!r.isRuntimeActive()) continue;
      unique.push(r);
    }
    return unique.map((r) => ({
      conversationId: r.conversationId,
      sessionId: r.sessionId ?? r.runtimeId,
      runtimeId: r.runtimeId,
      cwd: r.cwd,
      status: r.getStatus(),
      runtimeStatus: r.getRuntimeStatus(),
      turn: r.getTurnStatus(),
      subscriberCount: r.subscriberCount(),
    }));
  }

  async create(
    opts: SessionCreateOptions,
    permissionConn: ClientConnection,
    initialMessage?: string,
    onSessionId?: (sessionId: string, runtimeId: string) => void,
    conversationId?: string,
  ): Promise<string> {
    let release!: () => void;
    const previous = this.createTail;
    this.createTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (conversationId) {
        const existing = this.findRunner(conversationId);
        if (existing?.isRuntimeActive()) {
          existing.subscribe(permissionConn, true);
          if (initialMessage?.trim()) await existing.send(initialMessage);
          return existing.runtimeId;
        }
      }
      await this.ensureCapacity();
      return await this.createUnlocked(opts, permissionConn, initialMessage, onSessionId, conversationId);
    } finally {
      release();
    }
  }

  private async createUnlocked(
    opts: SessionCreateOptions,
    permissionConn: ClientConnection,
    initialMessage?: string,
    onSessionId?: (sessionId: string, runtimeId: string) => void,
    conversationId?: string,
  ): Promise<string> {
    const runtimeId = randomUUID();
    const engine = this.engineFactory();
    const runner = new SessionRunner(runtimeId, opts.cwd, engine);
    if (conversationId) runner.bindConversationId(conversationId);
    runner.subscribe(permissionConn, true);
    runner.setRuntimeTerminalHandler(() => {
      this.permissions.denyAllForSession(runtimeId);
      this.unregisterRunner(runner);
    });
    runner.setConversationFinishedHandler((lastConversationAt) => {
      this.enqueueEvictionCandidate(runner, lastConversationAt);
    });
    runner.setReclaimHandler(async () => {
      log.info("session auto reclaim", {
        runtimeId,
        conversationId: runner.conversationId,
        idleMs: this.autoReclaimMs,
      });
      await runner.stop();
    }, this.autoReclaimMs);
    this.registerRunner([runtimeId, conversationId ?? ""], runner);
    log.info("session.create start", { runtimeId, cwd: opts.cwd });
    await runner.startWithEngine(opts, this.permissions, (sid) => {
      this.registerRunner([runtimeId, sid], runner);
      onSessionId?.(sid, runtimeId);
    });
    if (initialMessage?.trim()) {
      await runner.send(initialMessage);
    }
    log.info("session.create done", { sessionId: runtimeId, subscribers: runner.subscriberCount() });
    return runtimeId;
  }

  async remove(sessionId: string): Promise<void> {
    const r = this.findRunner(sessionId);
    if (r) {
      this.permissions.denyAllForSession(r.runtimeId);
      await r.stop();
      this.unregisterRunner(r);
    }
  }

  async shutdown(): Promise<void> {
    const runners = [...new Set(this.runners.values())];
    await Promise.allSettled(runners.map(async (runner) => {
      this.permissions.denyAllForSession(runner.runtimeId);
      await runner.stop();
      this.unregisterRunner(runner);
    }));
  }

  onClientDisconnect(connId: string): void {
    const unique = new Set(this.runners.values());
    for (const runner of unique) runner.unsubscribe(connId);
  }
}
