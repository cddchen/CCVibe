import { describe, expect, it } from 'vitest';

import { SequencerByKey } from '../../src/index.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('SequencerByKey', () => {
  it('runs tasks for one key in strict FIFO order and returns each result', async () => {
    const sequencer = new SequencerByKey<string>();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = sequencer.enqueue('chat-1', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first-result';
    });
    const second = sequencer.enqueue('chat-1', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second-result';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(sequencer.activeKeyCount).toBe(1);

    firstGate.resolve(undefined);
    expect(await first).toBe('first-result');
    expect(await second).toBe('second-result');
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(sequencer.activeKeyCount).toBe(0);
  });

  it('allows different keys to start before either one finishes', async () => {
    const sequencer = new SequencerByKey<string>();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const started: string[] = [];

    const first = sequencer.run('chat-a', async () => {
      started.push('chat-a');
      await firstGate.promise;
      return 'a';
    });
    const second = sequencer.run('chat-b', async () => {
      started.push('chat-b');
      await secondGate.promise;
      return 'b';
    });

    await Promise.resolve();
    expect(started).toEqual(['chat-a', 'chat-b']);
    expect(sequencer.activeKeyCount).toBe(2);

    firstGate.resolve(undefined);
    secondGate.resolve(undefined);
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
    expect(sequencer.activeKeyCount).toBe(0);
  });

  it('returns the original rejection and continues with the next task', async () => {
    const sequencer = new SequencerByKey<string>();
    const failure = new Error('first task failed');

    const failed = sequencer.enqueue('chat-1', () => {
      throw failure;
    });
    const next = sequencer.enqueue('chat-1', () => 'next-result');

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe('next-result');
    expect(sequencer.activeKeyCount).toBe(0);
  });
});
