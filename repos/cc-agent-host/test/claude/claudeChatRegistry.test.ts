import type { UUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ClaudeChatRegistry,
  createChatUri,
  createTurnId,
  type ClaudeRuntimeConfig,
} from '../../src/index.js';
import type {
  ClaudeChatRuntime,
  ClaudeChatRuntimeFactoryInput,
} from '../../src/claude/claudeChatRegistry.js';
import type { ClaudeRuntimeSignal, ClaudeRuntimeState, ClaudeTurnHandle } from '../../src/claude/runtimeTypes.js';
import { SequencerByKey } from '../../src/chat/sequencer.js';
import type { ChatUri, TurnId } from '../../src/domain/ids.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const defaultConfig: ClaudeRuntimeConfig = {
  permissionMode: 'default',
  model: 'claude-sonnet',
  effort: 'high',
};
const chatA = createChatUri('host-session', 'chat-a');
const chatB = createChatUri('host-session', 'chat-b');
const turnA = createTurnId('turn-a');
const turnB = createTurnId('turn-b');

let uuidIndex = 0;

class FakeRuntime implements ClaudeChatRuntime {
  public state: ClaudeRuntimeState = 'starting';
  public startCalls = 0;
  public closeCalls = 0;
  public readonly sends: Array<{ readonly turnId: TurnId; readonly text: string }> = [];
  public readonly interrupts: TurnId[] = [];
  public readonly appliedConfigs: ClaudeRuntimeConfig[] = [];
  public readonly startGate = deferred<void>();
  public startError: unknown;
  public applyError: unknown;
  public readonly closeGate = deferred<void>();
  public closeIsGated = false;

  public start(): Promise<void> {
    this.startCalls += 1;
    return this.startGate.promise.then(
      () => {
        if (this.startError !== undefined) {
          this.state = 'crashed';
          throw this.startError;
        }
        if (this.state !== 'closed') {
          this.state = 'running';
        }
      },
      (error: unknown) => {
        this.state = 'crashed';
        throw error;
      },
    );
  }

  public send(turnId: TurnId, text: string): ClaudeTurnHandle {
    this.sends.push({ turnId, text });
    const sdkUuid = `00000000-0000-4000-8000-${String(100 + uuidIndex).padStart(12, '0')}` as UUID;
    uuidIndex += 1;
    return {
      turnId,
      sdkUuid,
      accepted: Promise.resolve(),
      completed: new Promise(() => undefined),
    };
  }

  public interrupt(
    turnId: TurnId,
  ): ReturnType<ClaudeChatRuntime['interrupt']> {
    if (!this.sends.some((send) => send.turnId === turnId)) {
      return Promise.resolve(undefined);
    }
    this.interrupts.push(turnId);
    return Promise.resolve({ still_queued: [] });
  }

  public applyRuntimeConfig(config: ClaudeRuntimeConfig): Promise<void> {
    this.appliedConfigs.push(config);
    return this.applyError === undefined
      ? Promise.resolve()
      : Promise.reject(this.applyError);
  }

  public close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    if (this.closeIsGated) {
      return this.closeGate.promise;
    }
    this.startGate.resolve();
    return Promise.resolve();
  }
}

interface FactoryHarness {
  readonly registry: ClaudeChatRegistry;
  readonly calls: ClaudeChatRuntimeFactoryInput[];
  readonly runtimes: FakeRuntime[];
  readonly factoryGate?: Deferred<FakeRuntime>;
}

function makeRegistry(options: {
  readonly factory?: (input: ClaudeChatRuntimeFactoryInput, index: number) => FakeRuntime | Promise<FakeRuntime>;
  readonly onSignal?: (chatUri: ChatUri, signal: ClaudeRuntimeSignal) => void | Promise<void>;
} = {}): FactoryHarness {
  const calls: ClaudeChatRuntimeFactoryInput[] = [];
  const runtimes: FakeRuntime[] = [];
  let index = 0;
  const registry = new ClaudeChatRegistry({
    sequencer: new SequencerByKey<ChatUri>(),
    runtimeFactory: (input) => {
      calls.push(input);
      const runtime = options.factory?.(input, index) ?? new FakeRuntime();
      index += 1;
      if (runtime instanceof Promise) {
        return runtime.then((resolved) => {
          runtimes.push(resolved);
          return resolved;
        });
      }
      runtimes.push(runtime);
      return runtime;
    },
    ...(options.onSignal === undefined ? {} : { onSignal: options.onSignal }),
  });
  return { registry, calls, runtimes };
}

function create(registry: ClaudeChatRegistry, chatUri: ChatUri, sdkSessionId: string): void {
  registry.createProvisional({
    chatUri,
    sdkSessionId,
    cwd: '/workspace/project',
    additionalDirectories: ['/workspace/project', '/workspace/shared'],
    desiredConfig: defaultConfig,
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('ClaudeChatRegistry', () => {
  it('does not start a runtime for a provisional chat', () => {
    const { registry, calls } = makeRegistry();
    const backing = registry.createProvisional({
      chatUri: chatA,
      sdkSessionId: 'sdk-explicit-a',
      cwd: '/workspace/project',
      desiredConfig: defaultConfig,
    });

    expect(backing.lifecycle).toBe('provisional');
    expect(calls).toHaveLength(0);
    expect(registry.snapshot(chatA)?.sdkSessionId).toBe('sdk-explicit-a');
    expect(() => create(registry, chatA, 'sdk-other')).toThrow('chat URI is already registered');
    expect(() => create(registry, chatB, 'sdk-explicit-a')).toThrow('sdkSessionId is already registered');
  });

  it('materializes concurrent first sends once and resolves handles before completion', async () => {
    const { registry, calls, runtimes } = makeRegistry();
    create(registry, chatA, 'sdk-a');

    const first = registry.send(chatA, turnA, 'first');
    const second = registry.send(chatA, turnB, 'second');
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      generation: 1,
      session: { kind: 'new', sessionId: 'sdk-a' },
      backing: {
        chatUri: chatA,
        sdkSessionId: 'sdk-a',
        cwd: '/workspace/project',
        additionalDirectories: ['/workspace/shared'],
        desiredConfig: defaultConfig,
        lifecycle: 'provisional',
      },
    });
    expect(Object.isFrozen(calls[0]?.backing)).toBe(true);
    expect(runtimes[0]?.startCalls).toBe(1);
    const handles = await Promise.all([first, second]);
    expect(runtimes[0]?.state).toBe('starting');

    runtimes[0]?.startGate.resolve();
    expect(handles.map((handle) => handle.turnId)).toEqual([turnA, turnB]);
    expect(runtimes[0]?.sends).toEqual([
      { turnId: turnA, text: 'first' },
      { turnId: turnB, text: 'second' },
    ]);
  });

  it('materializes different chats in parallel', async () => {
    const { registry, calls, runtimes } = makeRegistry();
    create(registry, chatA, 'sdk-a');
    create(registry, chatB, 'sdk-b');

    const first = registry.send(chatA, turnA, 'a');
    const second = registry.send(chatB, turnB, 'b');
    await flush();

    expect(calls).toHaveLength(2);
    expect(runtimes[0]?.startCalls).toBe(1);
    expect(runtimes[1]?.startCalls).toBe(1);
    await Promise.all([first, second]);
    expect(runtimes[0]?.sends).toEqual([{ turnId: turnA, text: 'a' }]);
    expect(runtimes[1]?.sends).toEqual([{ turnId: turnB, text: 'b' }]);

    runtimes[0]?.startGate.resolve();
    runtimes[1]?.startGate.resolve();
  });

  it('cleans up a failed materialization and permits a retry', async () => {
    const firstError = new Error('first start failed');
    let factoryIndex = 0;
    const { registry, calls, runtimes } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        if (factoryIndex === 0) {
          runtime.startError = firstError;
        }
        factoryIndex += 1;
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');

    const first = registry.materialize(chatA);
    await flush();
    runtimes[0]?.startGate.resolve();
    await expect(first).rejects.toBe(firstError);
    expect(runtimes[0]?.closeCalls).toBe(1);
    expect(registry.snapshot(chatA)?.lifecycle).toBe('provisional');

    const second = registry.materialize(chatA);
    await flush();
    runtimes[1]?.startGate.resolve();
    await second;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.session).toEqual({ kind: 'new', sessionId: 'sdk-a' });
    expect(calls[1]?.session).toEqual({ kind: 'new', sessionId: 'sdk-a' });
    expect(registry.snapshot(chatA)?.lifecycle).toBe('materialized');
  });

  it('interrupts a runtime during startup directly', async () => {
    const { registry, runtimes } = makeRegistry();
    create(registry, chatA, 'sdk-a');

    const send = registry.send(chatA, turnA, 'interrupt during startup');
    const handle = await send;
    expect(handle.turnId).toBe(turnA);
    expect(runtimes[0]?.state).toBe('starting');
    expect(runtimes[0]?.sends).toEqual([
      { turnId: turnA, text: 'interrupt during startup' },
    ]);

    const interrupt = await registry.interrupt(chatA, turnA);
    expect(interrupt).toEqual({ still_queued: [] });
    expect(runtimes[0]?.interrupts).toEqual([turnA]);

    runtimes[0]?.startGate.resolve();
  });

  it('orders send before interrupt across an asynchronous factory installation', async () => {
    const factoryGate = deferred<FakeRuntime>();
    const { registry } = makeRegistry({ factory: () => factoryGate.promise });
    create(registry, chatA, 'sdk-a');

    const send = registry.send(chatA, turnA, 'async factory');
    await flush();
    const interrupt = registry.interrupt(chatA, turnA);
    const runtime = new FakeRuntime();
    factoryGate.resolve(runtime);

    const handle = await send;
    expect(handle.turnId).toBe(turnA);
    await expect(interrupt).resolves.toEqual({ still_queued: [] });
    expect(runtime.sends).toEqual([{ turnId: turnA, text: 'async factory' }]);
    expect(runtime.interrupts).toEqual([turnA]);
    expect(runtime.state).toBe('starting');
    runtime.startGate.resolve();
  });

  it('retains a desired config update when live application rejects', async () => {
    const applyError = new Error('apply failed');
    const { registry, runtimes } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        runtime.startGate.resolve();
        runtime.applyError = applyError;
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');
    await registry.materialize(chatA);

    const updated: ClaudeRuntimeConfig = { permissionMode: 'plan', model: 'new-model' };
    await expect(registry.setRuntimeConfig(chatA, updated)).rejects.toBe(applyError);
    expect(registry.snapshot(chatA)?.desiredConfig).toEqual(updated);
    expect(runtimes[0]?.appliedConfigs).toEqual([updated]);
  });

  it('releases a runtime and resumes the materialized backing next time', async () => {
    const { registry, calls, runtimes } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        runtime.startGate.resolve();
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');
    await registry.materialize(chatA);
    await registry.release(chatA);
    expect(runtimes[0]?.closeCalls).toBe(1);
    expect(registry.snapshot(chatA)?.lifecycle).toBe('materialized');

    await registry.materialize(chatA);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.session).toEqual({ kind: 'resume', sessionId: 'sdk-a' });
  });

  it('rebinds single-flight after old close and before new start', async () => {
    const events: string[] = [];
    const { registry, calls, runtimes } = makeRegistry({
      factory: (input) => {
        events.push(`factory-${input.generation}`);
        const runtime = new FakeRuntime();
        const originalClose = runtime.close.bind(runtime);
        runtime.close = (): Promise<void> => {
          events.push(`close-${input.generation}`);
          return originalClose();
        };
        const originalStart = runtime.start.bind(runtime);
        runtime.start = (): Promise<void> => {
          events.push(`start-${input.generation}`);
          return originalStart();
        };
        runtime.startGate.resolve();
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');
    await registry.materialize(chatA);

    const first = registry.rebind(chatA);
    const second = registry.rebind(chatA);
    expect(second).toBe(first);
    await first;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.session).toEqual({ kind: 'resume', sessionId: 'sdk-a' });
    expect(events.indexOf('close-1')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('close-1')).toBeLessThan(events.indexOf('start-2'));
    expect(runtimes[0]?.closeCalls).toBe(1);
    expect(runtimes[1]?.startCalls).toBe(1);
  });

  it('does not let a stale terminal signal delete a newer generation', async () => {
    const signals: ClaudeRuntimeSignal[] = [];
    const observedChats: ChatUri[] = [];
    const { registry, calls } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        runtime.startGate.resolve();
        return runtime;
      },
      onSignal: (observedChat, signal) => {
        observedChats.push(observedChat);
        signals.push(signal);
      },
    });
    create(registry, chatA, 'sdk-a');
    await registry.materialize(chatA);
    await registry.rebind(chatA);

    const oldSignal = calls[0]?.onSignal;
    const newSignal = calls[1]?.onSignal;
    if (oldSignal === undefined || newSignal === undefined) {
      throw new Error('expected signal callbacks');
    }
    await oldSignal({ type: 'runtime/terminal', generation: 1, state: 'crashed' });
    expect(registry.runtimeCount).toBe(1);
    expect(signals).toHaveLength(1);
    expect(observedChats).toEqual([chatA]);

    await newSignal({ type: 'runtime/terminal', generation: 2, state: 'closed' });
    expect(registry.runtimeCount).toBe(0);
    expect(signals).toHaveLength(2);
    expect(observedChats).toEqual([chatA, chatA]);
  });

  it('disposes the runtime and deletes the backing', async () => {
    const { registry, runtimes } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        runtime.startGate.resolve();
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');
    await registry.materialize(chatA);

    await registry.disposeChat(chatA);
    expect(runtimes[0]?.closeCalls).toBe(1);
    expect(registry.snapshot(chatA)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('awaits release and dispose flights during shutdown before clearing state', async () => {
    const { registry, runtimes } = makeRegistry({
      factory: () => {
        const runtime = new FakeRuntime();
        runtime.startGate.resolve();
        return runtime;
      },
    });
    create(registry, chatA, 'sdk-a');
    create(registry, chatB, 'sdk-b');
    await Promise.all([registry.materialize(chatA), registry.materialize(chatB)]);
    const runtimeA = runtimes[0];
    const runtimeB = runtimes[1];
    if (runtimeA === undefined || runtimeB === undefined) {
      throw new Error('expected two runtimes');
    }
    runtimeA.closeIsGated = true;
    runtimeB.closeIsGated = true;

    const release = registry.release(chatA);
    const dispose = registry.disposeChat(chatB);
    const shutdown = registry.shutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await flush();
    expect(shutdownSettled).toBe(false);

    runtimeA.closeGate.resolve();
    runtimeB.closeGate.resolve();
    await Promise.all([release, dispose, shutdown]);
    expect(registry.size).toBe(0);
    expect(registry.runtimeCount).toBe(0);
  });

  it('closes a runtime whose start finishes after shutdown begins', async () => {
    const { registry, runtimes } = makeRegistry();
    create(registry, chatA, 'sdk-a');
    const handle = await registry.send(chatA, turnA, 'starting turn');
    expect(handle.turnId).toBe(turnA);
    const runtime = runtimes[0];
    if (runtime === undefined) {
      throw new Error('expected a starting runtime');
    }
    expect(runtime.state).toBe('starting');

    await registry.shutdown();
    expect(runtime.closeCalls).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.runtimeCount).toBe(0);
  });

  it('closes late factory materialization during idempotent shutdown and clears state', async () => {
    const gate = deferred<FakeRuntime>();
    const { registry, calls } = makeRegistry({
      factory: () => gate.promise,
    });
    create(registry, chatA, 'sdk-a');
    const materialize = registry.materialize(chatA);
    await flush();

    const shutdown = registry.shutdown();
    expect(registry.shutdown()).toBe(shutdown);
    expect(() => registry.createProvisional({
      chatUri: chatB,
      sdkSessionId: 'sdk-b',
      cwd: '/workspace/project',
      desiredConfig: defaultConfig,
    })).toThrow();
    await expect(registry.send(chatA, turnA, 'blocked')).rejects.toThrow();
    await expect(registry.setRuntimeConfig(chatA, defaultConfig)).rejects.toThrow();
    await expect(registry.rebind(chatA)).rejects.toThrow();

    const lateRuntime = new FakeRuntime();
    lateRuntime.startGate.resolve();
    gate.resolve(lateRuntime);
    await expect(materialize).rejects.toThrow();
    await shutdown;

    expect(lateRuntime.closeCalls).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.runtimeCount).toBe(0);
    expect(registry.listBackings()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
