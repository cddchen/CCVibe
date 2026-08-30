import { describe, expect, it } from 'vitest';

import { AsyncInputQueue } from '../../src/index.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AsyncInputQueue', () => {
  it('preserves FIFO order and resolves push only when values are consumed', async () => {
    const queue = new AsyncInputQueue<string>();
    const firstAccepted = queue.push('first');
    const secondAccepted = queue.push('second');
    let firstWasAccepted = false;
    let secondWasAccepted = false;
    void firstAccepted.then(() => {
      firstWasAccepted = true;
    });
    void secondAccepted.then(() => {
      secondWasAccepted = true;
    });
    await flushMicrotasks();
    expect(firstWasAccepted).toBe(false);
    expect(secondWasAccepted).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    await firstAccepted;
    expect(secondWasAccepted).toBe(false);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'second' });
    await secondAccepted;
    expect(secondWasAccepted).toBe(true);
  });

  it('parks next and wakes it immediately when a value is pushed', async () => {
    const queue = new AsyncInputQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();
    const accepted = queue.push(42);

    await expect(next).resolves.toEqual({ done: false, value: 42 });
    await expect(accepted).resolves.toBeUndefined();
  });

  it('drains buffered values before returning done after close', async () => {
    const queue = new AsyncInputQueue<string>();
    const accepted = queue.push('buffered');
    queue.close();
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'buffered' });
    await expect(accepted).resolves.toBeUndefined();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('wakes parked consumers with done when closed', async () => {
    const queue = new AsyncInputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();

    queue.close();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('fails parked and future next calls and rejects unaccepted values', async () => {
    const queue = new AsyncInputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const parked = iterator.next();
    const error = new Error('runtime crashed');

    queue.fail(error);

    await expect(parked).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);

    const accepted = queue.push('after failure');
    await expect(accepted).rejects.toBe(error);
  });

  it('rejects buffered values on failure and preserves values already accepted', async () => {
    const queue = new AsyncInputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const acceptedNext = iterator.next();
    const accepted = queue.push('already handed off');
    await expect(acceptedNext).resolves.toEqual({ done: false, value: 'already handed off' });
    await expect(accepted).resolves.toBeUndefined();

    const buffered = queue.push('buffered');
    const error = new Error('queue failed');
    queue.fail(error);

    await expect(buffered).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);
  });

  it('keeps the first terminal state and rejects pushes after close', async () => {
    const queue = new AsyncInputQueue<string>();
    queue.close();
    queue.fail(new Error('ignored failure'));
    queue.close();

    await expect(queue.push('late')).rejects.toMatchObject({ message: 'AsyncInputQueue is closed' });
    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('allows exactly one consumer iterator', () => {
    const queue = new AsyncInputQueue<string>();
    queue[Symbol.asyncIterator]();

    expect(() => queue[Symbol.asyncIterator]()).toThrow(TypeError);
  });
});
