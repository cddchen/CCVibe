interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface QueuedValue<T> {
  readonly value: T;
  readonly accepted: Deferred<void>;
}

interface PendingNext<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

type TerminalState =
  | { readonly kind: 'closed'; readonly error: Error }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * A single-consumer FIFO queue for an SDK async input stream.
 *
 * A push is not accepted until a consumer receives its value from `next()`.
 * Closing drains buffered input, while failing rejects all input that has not
 * reached the consumer yet.
 */
export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: QueuedValue<T>[] = [];
  private readonly pendingNext: PendingNext<T>[] = [];
  private readonly closeError = new Error('AsyncInputQueue is closed');
  private iteratorClaimed = false;
  private terminal: TerminalState | undefined;

  public push(value: T): Promise<void> {
    if (this.terminal !== undefined) {
      return Promise.reject(this.terminal.error);
    }

    const accepted = createDeferred<void>();
    const queued: QueuedValue<T> = { value, accepted };
    const next = this.pendingNext.shift();
    if (next === undefined) {
      this.values.push(queued);
    } else {
      next.resolve({ done: false, value });
      accept(accepted);
    }

    return accepted.promise;
  }

  public close(): void {
    if (this.terminal !== undefined) {
      return;
    }

    this.terminal = { kind: 'closed', error: this.closeError };
    this.drainPendingNext();
  }

  public fail(error: unknown): void {
    if (this.terminal !== undefined) {
      return;
    }

    this.terminal = { kind: 'failed', error };
    for (const queued of this.values.splice(0)) {
      queued.accepted.reject(error);
    }
    for (const next of this.pendingNext.splice(0)) {
      next.reject(error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorClaimed) {
      throw new TypeError('AsyncInputQueue supports only one consumer');
    }
    this.iteratorClaimed = true;

    return {
      next: (): Promise<IteratorResult<T>> => this.nextValue(),
    };
  }

  private nextValue(): Promise<IteratorResult<T>> {
    const queued = this.values.shift();
    if (queued !== undefined) {
      const result: IteratorResult<T> = { done: false, value: queued.value };
      accept(queued.accepted);
      return Promise.resolve(result);
    }

    if (this.terminal?.kind === 'failed') {
      return Promise.reject(this.terminal.error);
    }
    if (this.terminal?.kind === 'closed') {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pendingNext.push({ resolve, reject });
    });
  }

  private drainPendingNext(): void {
    if (this.terminal?.kind !== 'closed' || this.values.length !== 0) {
      return;
    }

    for (const next of this.pendingNext.splice(0)) {
      next.resolve({ done: true, value: undefined });
    }
  }

}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function accept(accepted: Deferred<void>): void {
  accepted.resolve();
}
