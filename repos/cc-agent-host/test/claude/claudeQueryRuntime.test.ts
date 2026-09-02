import type { UUID } from 'node:crypto';

import type {
  NonNullableUsage,
  Options,
  Query,
  SDKAssistantMessage,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ClaudeQueryRuntime,
  type ClaudeQueryRuntimeDeps,
} from '../../src/claude/claudeQueryRuntime.js';
import type { ClaudeAgentSdkService } from '../../src/claude/claudeAgentSdkService.js';
import type { ClaudeRuntimeSignal } from '../../src/claude/runtimeTypes.js';
import { createTurnId, type TurnId } from '../../src/domain/ids.js';

const SESSION_ID: UUID = '00000000-0000-4000-8000-000000000002';
const SDK_UUIDS: readonly UUID[] = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
];

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

type QueryTestSurface = Pick<
  Query,
  'interrupt' | 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'close'
> & AsyncGenerator<SDKMessage, void>;

class FakeQuery implements QueryTestSurface {
  public readonly calls: Array<
    | ['interrupt']
    | ['setModel', string | undefined]
    | ['setPermissionMode', Parameters<Query['setPermissionMode']>[0]]
    | ['applyFlagSettings', Parameters<Query['applyFlagSettings']>[0]]
  > = [];
  public interruptGate: Promise<SDKControlInterruptResponse | undefined> = Promise.resolve({
    still_queued: [],
  });
  public returnCalls = 0;
  public setModelError: unknown;

  private readonly messages: SDKMessage[] = [];
  private readonly waitingNext: Array<Deferred<IteratorResult<SDKMessage, void>>> = [];
  private ended = false;
  private failure: unknown;

  public next(..._args: [] | [any]): Promise<IteratorResult<SDKMessage, void>> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve({ done: false, value: message });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const next = deferred<IteratorResult<SDKMessage, void>>();
    this.waitingNext.push(next);
    return next.promise;
  }

  public return(_value?: void | PromiseLike<void>): Promise<IteratorResult<SDKMessage, void>> {
    this.returnCalls += 1;
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  public throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    this.crash(error ?? new Error('fake query crashed'));
    return Promise.reject(error ?? new Error('fake query crashed'));
  }

  public [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }

  public interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    this.calls.push(['interrupt']);
    return this.interruptGate;
  }

  public async setModel(model?: string): Promise<void> {
    this.calls.push(['setModel', model]);
    if (this.setModelError !== undefined) {
      throw this.setModelError;
    }
  }

  public async setPermissionMode(
    mode: Parameters<Query['setPermissionMode']>[0],
  ): Promise<void> {
    this.calls.push(['setPermissionMode', mode]);
  }

  public async applyFlagSettings(
    settings: Parameters<Query['applyFlagSettings']>[0],
  ): Promise<void> {
    this.calls.push(['applyFlagSettings', settings]);
  }

  public close(): void {
    this.end();
  }

  public yield(message: SDKMessage): void {
    const waiter = this.waitingNext.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.messages.push(message);
  }

  public end(): void {
    if (this.ended || this.failure !== undefined) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waitingNext.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public crash(error: unknown): void {
    if (this.ended || this.failure !== undefined) {
      return;
    }
    this.failure = error;
    for (const waiter of this.waitingNext.splice(0)) {
      waiter.reject(error);
    }
  }
}

class FakeWarmQuery implements Pick<WarmQuery, 'query' | 'close'>, AsyncDisposable {
  public queryCalls = 0;
  public queryInput: AsyncIterable<SDKUserMessage> | undefined;
  public disposeCalls = 0;
  public closeCalls = 0;
  public readonly query: (prompt: string | AsyncIterable<SDKUserMessage>) => Query;

  private inputIterator: AsyncIterator<SDKUserMessage> | undefined;
  private readonly queryValue: FakeQuery;

  public constructor(queryValue: FakeQuery) {
    this.queryValue = queryValue;
    this.query = (prompt: string | AsyncIterable<SDKUserMessage>): Query => {
      if (typeof prompt === 'string') {
        throw new TypeError('the runtime must use streaming input');
      }
      this.queryCalls += 1;
      this.queryInput = prompt;
      return this.queryValue as unknown as Query;
    };
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.disposeCalls += 1;
  }

  public async acceptNext(): Promise<SDKUserMessage> {
    const input = this.queryInput;
    if (input === undefined) {
      throw new Error('query input has not been installed');
    }
    this.inputIterator ??= input[Symbol.asyncIterator]();
    const result = await this.inputIterator.next();
    if (result.done) {
      throw new Error('runtime input ended before the next message');
    }
    return result.value;
  }
}

interface RuntimeHarness {
  readonly runtime: ClaudeQueryRuntime;
  readonly query: FakeQuery;
  readonly warm: FakeWarmQuery;
  readonly signals: ClaudeRuntimeSignal[];
  readonly buildOptionsCalls: number[];
  readonly abortController: AbortController;
}

function makeHarness(
  options: {
    readonly onSignal?: (signal: ClaudeRuntimeSignal) => void | Promise<void>;
    readonly onSignalError?: (error: unknown) => unknown;
    readonly startup?: (warm: FakeWarmQuery) => Promise<FakeWarmQuery>;
    readonly createSdkUuid?: () => UUID;
  } = {},
): RuntimeHarness {
  const query = new FakeQuery();
  const warm = new FakeWarmQuery(query);
  const signals: ClaudeRuntimeSignal[] = [];
  const buildOptionsCalls: number[] = [];
  const abortController = new AbortController();
  let uuidIndex = 0;
  const onSignal = options.onSignal ?? ((signal: ClaudeRuntimeSignal) => {
    signals.push(signal);
  });
  const onSignalError = options.onSignalError;
  const sdkService: Pick<ClaudeAgentSdkService, 'startup'> = {
    startup: async (..._args: Parameters<ClaudeAgentSdkService['startup']>): Promise<WarmQuery> => {
      if (options.startup !== undefined) {
        return options.startup(warm);
      }
      return warm;
    },
  };
  const deps: ClaudeQueryRuntimeDeps = {
    generation: 7,
    sdkSessionId: SESSION_ID,
    sdkService,
    buildOptions: (): Options => {
      buildOptionsCalls.push(buildOptionsCalls.length + 1);
      return { abortController } satisfies Options;
    },
    createSdkUuid: options.createSdkUuid ?? ((): UUID => {
      const uuid = SDK_UUIDS[uuidIndex];
      uuidIndex += 1;
      if (uuid === undefined) {
        throw new Error('test UUIDs exhausted');
      }
      return uuid;
    }),
    onSignal,
    ...(onSignalError === undefined ? {} : { onSignalError }),
  };
  return {
    runtime: new ClaudeQueryRuntime(deps),
    query,
    warm,
    signals,
    buildOptionsCalls,
    abortController,
  };
}

function initMessage(capabilities?: string[]): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '2.1.220',
    cwd: '/tmp/project',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...(capabilities === undefined ? {} : { capabilities }),
    uuid: '00000000-0000-4000-8000-000000000201',
    session_id: SESSION_ID,
  };
}

function successMessage(userMessageUuid?: string): SDKResultSuccess {
  const usage = Object.create(null) as NonNullableUsage;
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000202',
    session_id: SESSION_ID,
    ...(userMessageUuid === undefined ? {} : { user_message_uuid: userMessageUuid }),
  };
}

function successErrorMessage(message = 'safe success failure'): SDKResultSuccess {
  return {
    ...successMessage(),
    is_error: true,
    result: message,
  };
}

function errorMessage(message = 'safe failure'): SDKResultError {
  const usage = Object.create(null) as NonNullableUsage;
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    uuid: '00000000-0000-4000-8000-000000000203',
    session_id: SESSION_ID,
  };
}

function assistantMessage(): SDKMessage {
  const message = Object.create(null) as SDKAssistantMessage;
  message.type = 'assistant';
  message.message = Object.create(null);
  message.parent_tool_use_id = null;
  message.uuid = '00000000-0000-4000-8000-000000000204';
  message.session_id = SESSION_ID;
  return message;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function turn(value: string): TurnId {
  return createTurnId(value);
}

describe('ClaudeQueryRuntime', () => {
  it('uses one startup, one warm query, one queue, and reuses the Query for turns', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    expect(harness.buildOptionsCalls).toEqual([1]);
    expect(harness.warm.queryCalls).toBe(1);

    const first = harness.runtime.send(turn('turn-1'), 'first');
    const second = harness.runtime.send(turn('turn-2'), 'second');
    const firstInput = await harness.warm.acceptNext();
    const secondInput = await harness.warm.acceptNext();
    await Promise.all([first.accepted, second.accepted]);
    expect(firstInput.uuid).toBe(first.sdkUuid);
    expect(secondInput.uuid).toBe(second.sdkUuid);

    harness.query.yield(successMessage(second.sdkUuid));
    await expect(second.completed).resolves.toEqual({ status: 'completed', resultSubtype: 'success' });
    harness.query.yield(errorMessage());
    await expect(first.completed).resolves.toEqual({
      status: 'failed',
      resultSubtype: 'error_during_execution',
      message: 'safe failure',
    });
    expect(harness.warm.queryCalls).toBe(1);
    expect(harness.runtime.state).toBe('running');
  });

  it('classifies a success subtype with is_error as a failed turn using its result text', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const pending = harness.runtime.send(turn('success-error'), 'prompt');
    await harness.warm.acceptNext();
    await pending.accepted;

    harness.query.yield(successErrorMessage('provider reported failure'));

    await expect(pending.completed).resolves.toEqual({
      status: 'failed',
      resultSubtype: 'success',
      message: 'provider reported failure',
    });
    expect(harness.signals).toContainEqual({
      type: 'turn/result',
      generation: 7,
      turnId: pending.turnId,
      outcome: {
        status: 'failed',
        resultSubtype: 'success',
        message: 'provider reported failure',
      },
    });
  });

  it('emits init capabilities and keeps post-result messages in the completed turn tail', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    harness.query.yield(initMessage(['interrupt_receipt_v1']));
    await flush();

    const first = harness.runtime.send(turn('turn-1'), 'first');
    await harness.warm.acceptNext();
    await first.accepted;
    harness.query.yield(assistantMessage());
    await flush();
    harness.query.yield(successMessage(first.sdkUuid));
    await first.completed;

    const second = harness.runtime.send(turn('turn-2'), 'second');
    harness.query.yield(assistantMessage());
    await flush();
    const tail = harness.signals.find(
      (signal): signal is Extract<ClaudeRuntimeSignal, { type: 'runtime/message' }> =>
        signal.type === 'runtime/message'
        && signal.message.type === 'assistant'
        && signal.phase === 'tail',
    );
    expect(tail).toMatchObject({ phase: 'tail', turnId: first.turnId });
    await harness.warm.acceptNext();
    await second.accepted;
    harness.query.yield({
      ...firstInputUser(second.sdkUuid),
    });
    await flush();
    const activeSignals = harness.signals.filter(
      (signal): signal is Extract<ClaudeRuntimeSignal, { type: 'runtime/message' }> =>
        signal.type === 'runtime/message' && signal.turnId === second.turnId,
    );
    expect(activeSignals.at(-1)?.phase).toBe('active');

    const init = harness.signals.find((signal) => signal.type === 'runtime/init');
    expect(init).toMatchObject({
      type: 'runtime/init',
      generation: 7,
      sdkSessionId: SESSION_ID,
      model: 'claude-sonnet',
      permissionMode: 'default',
      capabilities: { interrupt_receipt_v1: true },
    });
  });

  it('attributes a follow-up response as soon as the SDK consumes its input without requiring a user echo', async () => {
    const harness = makeHarness();
    await harness.runtime.start();

    const first = harness.runtime.send(turn('turn-1'), 'first');
    await harness.warm.acceptNext();
    await first.accepted;
    harness.query.yield(successMessage(first.sdkUuid));
    await first.completed;

    const second = harness.runtime.send(turn('turn-2'), 'follow up');
    await harness.warm.acceptNext();
    await second.accepted;
    // Real SDK versions may start streaming the assistant response without
    // first echoing an SDKUserMessage for the streamed input.
    harness.query.yield(assistantMessage());
    await flush();

    const assistantSignal = [...harness.signals].reverse().find(
      (signal): signal is Extract<ClaudeRuntimeSignal, { type: 'runtime/message' }> =>
        signal.type === 'runtime/message' && signal.message.type === 'assistant',
    );
    expect(assistantSignal).toMatchObject({
      phase: 'active',
      turnId: second.turnId,
    });

    harness.query.yield(successMessage(second.sdkUuid));
    await expect(second.completed).resolves.toEqual({
      status: 'completed',
      resultSubtype: 'success',
    });
  });

  it('treats a stale or foreign explicit result UUID as unmatched without FIFO fallback', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const pending = harness.runtime.send(turn('pending-explicit'), 'pending');
    await harness.warm.acceptNext();
    await pending.accepted;

    harness.query.yield(successMessage('00000000-0000-4000-8000-000000009999'));
    await flush();
    expect(harness.signals.filter((signal) => signal.type === 'turn/result')).toHaveLength(0);

    let settled = false;
    void pending.completed.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    harness.query.yield(successMessage(pending.sdkUuid));
    await expect(pending.completed).resolves.toEqual({
      status: 'completed',
      resultSubtype: 'success',
    });
  });

  it('does not rewrite completed turns when the iterator ends, and closes pending turns', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const completed = harness.runtime.send(turn('completed'), 'done');
    const pending = harness.runtime.send(turn('pending'), 'pending');
    await harness.warm.acceptNext();
    await harness.warm.acceptNext();
    await Promise.all([completed.accepted, pending.accepted]);
    harness.query.yield(successMessage(completed.sdkUuid));
    await expect(completed.completed).resolves.toEqual({ status: 'completed', resultSubtype: 'success' });
    harness.query.end();
    await expect(pending.completed).resolves.toEqual({
      status: 'runtime_closed',
      message: 'Claude query runtime closed',
    });
    await flush();
    expect(harness.signals.filter((signal) => signal.type === 'turn/result')).toHaveLength(1);
    expect(harness.signals.at(-1)).toMatchObject({ type: 'runtime/terminal', state: 'closed' });
    await expect(harness.runtime.start()).rejects.toThrow('Claude query runtime closed');
  });

  it('classifies an iterator throw as a crash without changing completed turns', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const completed = harness.runtime.send(turn('completed'), 'done');
    await harness.warm.acceptNext();
    await completed.accepted;
    harness.query.yield(successMessage(completed.sdkUuid));
    await completed.completed;
    const pending = harness.runtime.send(turn('pending'), 'pending');
    await harness.warm.acceptNext();
    await pending.accepted;
    const crash = new Error('stream broke');
    harness.query.crash(crash);
    await expect(pending.completed).resolves.toEqual({ status: 'failed', message: 'stream broke' });
    await flush();
    expect(harness.runtime.state).toBe('crashed');
    expect(harness.signals.at(-1)).toMatchObject({ type: 'runtime/terminal', state: 'crashed', error: crash });
    await expect(completed.completed).resolves.toEqual({ status: 'completed', resultSubtype: 'success' });
  });

  it('interrupts directly, shares concurrent control calls, and ignores a later result', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const target = harness.runtime.send(turn('target'), 'target');
    await harness.warm.acceptNext();
    await target.accepted;
    const interrupt = deferred<SDKControlInterruptResponse | undefined>();
    harness.query.interruptGate = interrupt.promise;
    const firstInterrupt = harness.runtime.interrupt(target.turnId);
    const secondInterrupt = harness.runtime.interrupt(target.turnId);
    expect(firstInterrupt).toBe(secondInterrupt);
    expect(harness.query.calls).toEqual([['interrupt']]);
    let completed = false;
    void target.completed.then(() => {
      completed = true;
    });
    await flush();
    expect(completed).toBe(false);
    const receipt = { still_queued: [] } satisfies SDKControlInterruptResponse;
    interrupt.resolve(receipt);
    await expect(firstInterrupt).resolves.toBe(receipt);
    await expect(target.completed).resolves.toEqual({ status: 'interrupted' });

    const next = harness.runtime.send(turn('next'), 'next');
    await harness.warm.acceptNext();
    await next.accepted;
    harness.query.yield(successMessage(target.sdkUuid));
    await flush();
    expect(harness.signals.filter((signal) => signal.type === 'turn/result')).toHaveLength(1);
    harness.query.yield(successMessage(next.sdkUuid));
    await expect(next.completed).resolves.toEqual({ status: 'completed', resultSubtype: 'success' });
  });

  it('keeps an ordered interrupt tombstone so a late anonymous result cannot settle the next turn', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const interrupted = harness.runtime.send(turn('interrupt-a'), 'A');
    await harness.warm.acceptNext();
    await interrupted.accepted;
    await harness.runtime.interrupt(interrupted.turnId);
    await expect(interrupted.completed).resolves.toEqual({ status: 'interrupted' });

    const next = harness.runtime.send(turn('interrupt-b'), 'B');
    await harness.warm.acceptNext();
    await next.accepted;
    harness.query.yield(errorMessage('late A result'));
    await flush();
    expect(harness.signals.filter((signal) => signal.type === 'turn/result')).toHaveLength(1);

    let nextSettled = false;
    void next.completed.then(() => {
      nextSettled = true;
    });
    await flush();
    expect(nextSettled).toBe(false);

    harness.query.yield(successMessage(next.sdkUuid));
    await expect(next.completed).resolves.toEqual({
      status: 'completed',
      resultSubtype: 'success',
    });
    harness.query.yield(successMessage(interrupted.sdkUuid));
    await flush();
    expect(harness.signals.filter((signal) => signal.type === 'turn/result')).toHaveLength(2);
  });

  it('serializes runtime config through the Phase 2 helper without blocking interrupt', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const applying = harness.runtime.applyRuntimeConfig({
      model: 'claude-opus',
      permissionMode: 'plan',
      effort: 'high',
    });
    await applying;
    expect(harness.query.calls).toEqual([
      ['setModel', 'claude-opus'],
      ['setPermissionMode', 'plan'],
      ['applyFlagSettings', { effortLevel: 'high' }],
    ]);
  });

  it('retains config requested before startup and replays it on the created Query', async () => {
    const harness = makeHarness();
    const applying = harness.runtime.applyRuntimeConfig({ permissionMode: 'acceptEdits', effort: 'low' });
    expect(harness.buildOptionsCalls).toHaveLength(0);
    await harness.runtime.start();
    await applying;
    await flush();
    expect(harness.query.calls).toEqual([
      ['setModel', undefined],
      ['setPermissionMode', 'acceptEdits'],
      ['applyFlagSettings', { effortLevel: 'low' }],
    ]);
  });

  it('propagates desired-config replay failure and crashes startup with one terminal', async () => {
    const harness = makeHarness();
    const setterError = new Error('set model failed');
    harness.query.setModelError = setterError;
    const applying = harness.runtime.applyRuntimeConfig({
      model: 'claude-opus',
      permissionMode: 'plan',
    });
    const starting = harness.runtime.start();

    await expect(applying).rejects.toBe(setterError);
    await expect(starting).rejects.toBe(setterError);
    expect(harness.runtime.state).toBe('crashed');
    expect(harness.query.returnCalls).toBe(1);
    expect(harness.warm.disposeCalls).toBe(1);
    expect(harness.signals.filter((signal) => signal.type === 'runtime/terminal')).toEqual([
      expect.objectContaining({ type: 'runtime/terminal', state: 'crashed', error: setterError }),
    ]);
  });

  it('isolates signal listener failures and disposes a late startup after close', async () => {
    const reported: unknown[] = [];
    let throwOnce = true;
    const harness = makeHarness({
      onSignal: (signal) => {
        if (signal.type === 'runtime/message' && throwOnce) {
          throwOnce = false;
          throw new Error('listener failed');
        }
      },
      onSignalError: (error) => {
        reported.push(error);
      },
    });
    await harness.runtime.start();
    harness.query.yield(assistantMessage());
    harness.query.yield(assistantMessage());
    await flush();
    expect(reported).toHaveLength(1);

    const startup = deferred<FakeWarmQuery>();
    const late = makeHarness({ startup: () => startup.promise });
    const startPromise = late.runtime.start();
    const closePromise = late.runtime.close();
    startup.resolve(late.warm);
    await expect(startPromise).resolves.toBeUndefined();
    await closePromise;
    expect(late.warm.queryCalls).toBe(0);
    expect(late.warm.disposeCalls).toBe(1);
    expect(late.signals.filter((signal) => signal.type === 'runtime/terminal')).toHaveLength(1);
  });

  it('closes idempotently, aborts options, disposes Query and WarmQuery, and settles pending turns', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const pending = harness.runtime.send(turn('pending-close'), 'pending');
    await harness.warm.acceptNext();
    await pending.accepted;
    const closePromise = harness.runtime.close();
    expect(harness.runtime.close()).toBe(closePromise);
    await closePromise;
    await expect(pending.completed).resolves.toEqual({
      status: 'runtime_closed',
      message: 'Claude query runtime closed',
    });
    expect(harness.abortController.signal.aborted).toBe(true);
    expect(harness.query.returnCalls).toBe(1);
    expect(harness.warm.disposeCalls).toBe(1);
    expect(harness.signals.filter((signal) => signal.type === 'runtime/terminal')).toHaveLength(1);
    expect(harness.runtime.state).toBe('closed');
  });

  it('validates duplicate turn IDs and SDK UUIDs while keeping the public handle SDK-light', async () => {
    const harness = makeHarness();
    const first = harness.runtime.send(turn('same'), 'first', { steering: true });
    await harness.runtime.start();
    expect(() => harness.runtime.send(turn('same'), 'second')).toThrow(TypeError);
    expectTypeOf(first.completed).toEqualTypeOf<Promise<
      { readonly status: 'completed'; readonly resultSubtype: string }
      | { readonly status: 'failed'; readonly resultSubtype?: string; readonly message: string }
      | { readonly status: 'interrupted' }
      | { readonly status: 'runtime_closed'; readonly message: string }
    >>();
    await harness.warm.acceptNext();
    await expect(first.accepted).resolves.toBeUndefined();

    const duplicateUuidHarness = makeHarness({
      createSdkUuid: () => SDK_UUIDS[0] as UUID,
    });
    duplicateUuidHarness.runtime.send(turn('uuid-1'), 'first');
    await duplicateUuidHarness.runtime.start();
    expect(() => duplicateUuidHarness.runtime.send(turn('uuid-2'), 'second')).toThrow(TypeError);
  });
});

function firstInputUser(uuid: UUID): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: 'echo' },
    parent_tool_use_id: null,
    uuid,
    session_id: SESSION_ID,
  } satisfies SDKUserMessage;
}
