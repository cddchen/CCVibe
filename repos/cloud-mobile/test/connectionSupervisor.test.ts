import { describe, expect, it } from 'vitest';

import { createConnectionId } from '../src/protocol/ids';
import { createSyncStore } from '../src/sync/syncState';
import { TransportRpcError, type JsonRpcTransportPort, type TransportStatusEvent } from '../src/sync/transport';
import type { HostNotification } from '../src/protocol/hostWire';
import { ConnectionSupervisor, type AppStatePort, type AppLifecycleState } from '../src/sync/connectionSupervisor';
import type { JsonValue } from '../src/domain/types';
import type { TimerPort } from '../src/sync/timer';

class ManualTimer implements TimerPort {
  private nextId = 0;
  private current = 0;
  private readonly tasks = new Map<number, { readonly at: number; readonly callback: () => void }>();

  public now(): number { return this.current; }
  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.current + milliseconds, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }
  public advance(milliseconds: number): void {
    this.current += milliseconds;
    const due = [...this.tasks.entries()].filter(([, task]) => task.at <= this.current);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      task.callback();
    }
  }
  public get pendingCount(): number { return this.tasks.size; }
}

class FakeAppState implements AppStatePort {
  public state: AppLifecycleState = 'active';
  private readonly listeners = new Set<(state: AppLifecycleState) => void>();
  public currentState(): AppLifecycleState { return this.state; }
  public subscribe(listener: (state: AppLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public setState(state: AppLifecycleState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

class FakeTransport implements JsonRpcTransportPort {
  public openCalls = 0;
  public closeCalls = 0;
  public readonly requests: Array<{ readonly method: string; readonly params: JsonValue | undefined }> = [];
  private readonly events = new Set<(event: HostNotification) => void>();
  private readonly statuses = new Set<(status: TransportStatusEvent) => void>();
  private openResolve: (() => void) | undefined;
  private openReject: ((error: Error) => void) | undefined;
  private pendingRequest: { readonly method: string; readonly resolve: (value: JsonValue) => void; readonly reject: (error: Error) => void } | undefined;

  public open(): Promise<void> {
    this.openCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
  }
  public request(method: string, params?: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, params });
    return new Promise<JsonValue>((resolve, reject) => {
      this.pendingRequest = { method, resolve, reject };
    });
  }
  public onEvent(listener: (event: HostNotification) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  public onStatus(listener: (status: TransportStatusEvent) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  public close(): void {
    this.closeCalls += 1;
    for (const listener of [...this.statuses]) listener({ type: 'closed', code: 1006, reason: 'closed' });
  }
  public resolveOpen(): void { this.openResolve?.(); }
  public rejectOpen(): void { this.openReject?.(new Error('connect failed')); }
  public resolveRequest(value: JsonValue): void { this.pendingRequest?.resolve(value); }
  public rejectRequest(error: Error): void { this.pendingRequest?.reject(error); }
  public emit(event: HostNotification): void { for (const listener of [...this.events]) listener(event); }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function initializeResult(): JsonValue {
  return {
    protocolVersion: '1.0.0',
    hostEpoch: 'epoch-1',
    serverSeq: 0,
    snapshots: [{
      resource: 'agent-root://',
      state: {
        resource: 'agent-root://',
        host: { id: 'host-a', displayName: 'Host A' },
        connection: { status: 'connected', displayStatus: 'online' },
        workspaces: [],
        sessions: [],
        models: [],
        modifiedAt: 't0',
      },
      fromSeq: 0,
    }],
    missing: [],
  };
}

describe('connection supervisor', () => {
  it('initializes, reconnects with epoch/seq/subscriptions, and exposes client replacement', async () => {
    const timer = new ManualTimer();
    const appState = new FakeAppState();
    const store = createSyncStore({ address: 'wss://cloud.example.test', subscriptions: ['agent-root://'] });
    const transports: FakeTransport[] = [];
    const supervisor = new ConnectionSupervisor({
      config: { connectionId: createConnectionId('connection-a'), address: 'wss://cloud.example.test', token: 'secret', mode: 'production' },
      clientId: 'client-a',
      clientInfo: { name: 'Cloud', version: '0.1.0', platform: 'ios' },
      store,
      timer,
      appState,
      backoff: () => 20,
      jitter: (delay) => delay,
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });

    supervisor.start();
    expect(store.getState().status).toBe('connecting');
    const first = transports[0];
    expect(first).toBeDefined();
    first?.resolveOpen();
    await flush();
    expect(first?.requests[0]?.method).toBe('initialize');
    first?.resolveRequest(initializeResult());
    await flush();
    expect(store.getState()).toMatchObject({ status: 'connected', hostEpoch: 'epoch-1', lastSeenServerSeq: 0 });

    first?.emit({ type: 'client/replaced', reason: 'client connection replaced' });
    await flush();
    expect(store.getState()).toMatchObject({ status: 'replaced', replacementReason: 'client connection replaced' });
    expect(timer.pendingCount).toBe(0);
    supervisor.stop();
  });

  it('stops retry timers in background and starts one reconnect on foreground', async () => {
    const timer = new ManualTimer();
    const appState = new FakeAppState();
    const store = createSyncStore({ address: 'wss://cloud.example.test', subscriptions: ['agent-root://'] });
    const transports: FakeTransport[] = [];
    const supervisor = new ConnectionSupervisor({
      config: { connectionId: createConnectionId('connection-b'), address: 'wss://cloud.example.test', token: 'secret', mode: 'production' },
      clientId: 'client-b',
      clientInfo: { name: 'Cloud', version: '0.1.0', platform: 'android' },
      store,
      timer,
      appState,
      backoff: () => 20,
      jitter: (delay) => delay,
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });

    supervisor.start();
    transports[0]?.rejectOpen();
    await flush();
    expect(timer.pendingCount).toBe(1);
    appState.setState('background');
    expect(timer.pendingCount).toBe(0);
    timer.advance(100);
    expect(transports).toHaveLength(1);

    appState.setState('active');
    await flush();
    expect(transports).toHaveLength(2);
    supervisor.stop();
  });

  it('falls back to initialize when a restarted host no longer knows the client', async () => {
    const timer = new ManualTimer();
    const appState = new FakeAppState();
    const store = createSyncStore({ address: 'wss://cloud.example.test', subscriptions: ['agent-root://'] });
    store.dispatch({ type: 'initialize/succeeded', result: initializeResult() as never, requestedSubscriptions: ['agent-root://'] });
    const transport = new FakeTransport();
    const supervisor = new ConnectionSupervisor({
      config: { connectionId: createConnectionId('connection-c'), address: 'wss://cloud.example.test', token: 'secret', mode: 'production' },
      clientId: 'client-c',
      clientInfo: { name: 'Cloud', version: '0.1.0', platform: 'ios' },
      store,
      timer,
      appState,
      transportFactory: () => transport,
    });

    supervisor.start();
    transport.resolveOpen();
    await flush();
    expect(transport.requests[0]?.method).toBe('reconnect');
    transport.rejectRequest(new TransportRpcError({ code: -32004, message: 'Resource not found' }));
    await flush();
    expect(transport.requests[1]?.method).toBe('initialize');
    transport.resolveRequest({ ...initializeResult() as object, hostEpoch: 'epoch-2' } as JsonValue);
    await flush();
    expect(store.getState()).toMatchObject({ status: 'connected', hostEpoch: 'epoch-2' });
    supervisor.stop();
  });
});
