/** A task accepted by {@link SequencerByKey}. */
export type SequencerTask<T> = () => T | PromiseLike<T>;

/**
 * Runs tasks serially for each key while allowing unrelated keys to proceed
 * independently.
 *
 * A task's result or rejection is returned to its caller. Rejections are kept
 * out of the per-key tail, so one failed task cannot stop the next task.
 */
export class SequencerByKey<K> {
  private readonly tails = new Map<K, Promise<void>>();

  /** Number of keys that currently have queued or running work. */
  public get activeKeyCount(): number {
    return this.tails.size;
  }

  /**
   * Enqueue a task for a key.
   *
   * Tasks for one key start in insertion order. Tasks for different keys do
   * not share a scheduling tail and can therefore run concurrently.
   */
  public enqueue<T>(key: K, task: SequencerTask<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, currentTail);

    // `previous` is an internal tail that always fulfills. Promise.then also
    // turns a synchronous throw from task into the returned rejection.
    const result = previous.then(() => task());
    const settle = (): void => {
      release();
      if (this.tails.get(key) === currentTail) {
        this.tails.delete(key);
      }
    };

    // Handle both branches so the internal tail never becomes rejected and so
    // cleanup occurs regardless of the task's outcome.
    void result.then(settle, settle);
    return result;
  }

  /** Alias for {@link enqueue} for call sites that model work as execution. */
  public run<T>(key: K, task: SequencerTask<T>): Promise<T> {
    return this.enqueue(key, task);
  }
}
