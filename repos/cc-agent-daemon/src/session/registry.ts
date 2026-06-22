import { randomUUID } from "node:crypto";
import type { EngineAdapter } from "./runner.js";
import { SessionRunner } from "./runner.js";
import type { SessionCreateOptions } from "./types.js";
import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionRegistry } from "../permission/registry.js";
import { log } from "../logger.js";

export class SessionRegistry {
  private runners = new Map<string, SessionRunner>();
  constructor(
    private engineFactory: () => EngineAdapter,
    private permissions: PermissionRegistry,
  ) {}

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
  }

  listActive(): { sessionId: string; cwd: string; status: string; subscriberCount: number }[] {
    const seen = new Set<SessionRunner>();
    const unique: SessionRunner[] = [];
    for (const r of this.runners.values()) {
      if (seen.has(r)) continue;
      seen.add(r);
      const status = r.getStatus();
      if (status === "completed" || status === "error") continue;
      unique.push(r);
    }
    return unique.map((r) => ({
      sessionId: r.sessionId ?? r.runtimeId,
      cwd: r.cwd,
      status: r.getStatus(),
      subscriberCount: r.subscriberCount(),
    }));
  }

  async create(
    opts: SessionCreateOptions,
    permissionConn: ClientConnection,
    initialMessage?: string,
    onSessionId?: (sessionId: string, runtimeId: string) => void,
  ): Promise<string> {
    const runtimeId = randomUUID();
    const engine = this.engineFactory();
    const runner = new SessionRunner(runtimeId, opts.cwd, engine);
    runner.subscribe(permissionConn);
    runner.setTerminalCleanup(() => {
      setTimeout(() => {
        const sid = runner.sessionId ?? runtimeId;
        this.permissions.denyAllForSession(sid);
        this.unregisterRunner(runner);
      }, 60_000).unref();
    });
    this.registerRunner([runtimeId], runner);
    log.info("session.create start", { runtimeId, cwd: opts.cwd });
    await runner.startWithEngine(opts, this.permissions, permissionConn, (sid) => {
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
      const sid = r.sessionId ?? sessionId;
      this.permissions.denyAllForSession(sid);
      await r.stop();
      this.unregisterRunner(r);
    }
  }

  onClientDisconnect(connId: string): void {
    for (const r of this.runners.values()) {
      r.unsubscribe(connId);
    }
  }
}