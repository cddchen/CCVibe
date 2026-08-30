import type { ClientId, CommandId } from '../domain/ids.js';
import type { DeepReadonly } from '../protocol/types.js';

/** The identity used to scope a command to one logical client. */
export interface CommandKey {
  readonly clientId: ClientId;
  readonly commandId: CommandId;
}

export interface AcceptedCommandReceipt<T> {
  readonly status: 'accepted';
  /** The accepted value is a recursively immutable defensive snapshot. */
  readonly value: DeepReadonly<T>;
}

export interface RejectedCommandReceipt {
  readonly status: 'rejected';
  readonly code: string;
  readonly message: string;
}

export type CommandReceipt<T> = AcceptedCommandReceipt<T> | RejectedCommandReceipt;

/** The serializable fields a rejection mapper supplies. */
export interface CommandRejection {
  readonly code: string;
  readonly message: string;
}

/**
 * A mapper may return either the fields of a rejection or the complete
 * rejected receipt. The deduper always stores a freshly canonicalized receipt.
 */
export type CommandRejectionResult = CommandRejection | RejectedCommandReceipt;

export type CommandRejectionMapper = (
  error: unknown,
) => CommandRejectionResult | PromiseLike<CommandRejectionResult>;

export type CommandEffect<T> = () => T | PromiseLike<T>;

export interface CommandDeduperOptions {
  /** Global maximum number of completed receipts retained. */
  readonly capacity: number;
}

type UnknownReceipt = CommandReceipt<unknown>;

interface InFlightEntry {
  readonly promise: Promise<UnknownReceipt>;
}

interface CompletedEntry {
  readonly clientId: ClientId;
  readonly commandId: CommandId;
  readonly receipt: UnknownReceipt;
}

/**
 * Provides command single-flight and a bounded in-memory receipt cache.
 *
 * In-flight work is tracked separately from completed receipts. Consequently,
 * pressure on the completed cache can evict old receipts without cancelling
 * or duplicating work that is still running.
 */
export class CommandDeduper {
  private readonly completedCapacity: number;
  private readonly inFlight = new Map<ClientId, Map<CommandId, InFlightEntry>>();
  private readonly completed = new Map<ClientId, Map<CommandId, CompletedEntry>>();
  private readonly completedOrder = new Map<CompletedEntry, undefined>();

  public constructor(options: CommandDeduperOptions) {
    this.completedCapacity = validateCapacity(options.capacity);
  }

  /** The maximum number of completed receipts retained by this instance. */
  public get capacity(): number {
    return this.completedCapacity;
  }

  /**
   * Execute a command at most once while it is in flight and while its receipt
   * remains cached.
   *
   * Concurrent calls for a key receive the exact same Promise. The mapper
   * supplied by the first call is the mapper used if that effect rejects.
   */
  public execute<T>(
    key: CommandKey,
    effect: CommandEffect<T>,
    mapRejection: CommandRejectionMapper,
  ): Promise<CommandReceipt<T>> {
    const clientId = key.clientId;
    const commandId = key.commandId;
    const running = this.findInFlight(clientId, commandId);
    if (running !== undefined) {
      return running.promise as Promise<CommandReceipt<T>>;
    }

    const cached = this.findCompleted(clientId, commandId);
    if (cached !== undefined) {
      return Promise.resolve(cached.receipt as CommandReceipt<T>);
    }

    let resolvePromise!: (receipt: UnknownReceipt | PromiseLike<UnknownReceipt>) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<UnknownReceipt>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: InFlightEntry = { promise };
    this.setInFlight(clientId, commandId, entry);

    // Starting through a fulfilled promise catches both synchronous throws and
    // rejected thenables without ever placing the raw error in a receipt.
    void Promise.resolve()
      .then(effect)
      .then(
        (value) => {
          try {
            resolvePromise(this.completeAccepted(clientId, commandId, entry, value));
          } catch (error) {
            // Canonicalization failures are not command results. Remove the
            // flight before rejecting so the caller can retry the command.
            this.removeInFlight(clientId, commandId, entry);
            rejectPromise(error);
          }
        },
        (error: unknown) => {
          let mapped: CommandRejectionResult | PromiseLike<CommandRejectionResult>;
          try {
            mapped = mapRejection(error);
          } catch (mappingError) {
            this.removeInFlight(clientId, commandId, entry);
            rejectPromise(mappingError);
            return;
          }

          void Promise.resolve(mapped).then(
            (rejection) => {
              try {
                resolvePromise(this.completeRejected(clientId, commandId, entry, rejection));
              } catch (mappingError) {
                this.removeInFlight(clientId, commandId, entry);
                rejectPromise(mappingError);
              }
            },
            (mappingError: unknown) => {
              this.removeInFlight(clientId, commandId, entry);
              rejectPromise(mappingError);
            },
          );
        },
      );

    return promise as Promise<CommandReceipt<T>>;
  }

  /** Alias for {@link execute}. */
  public run<T>(
    key: CommandKey,
    effect: CommandEffect<T>,
    mapRejection: CommandRejectionMapper,
  ): Promise<CommandReceipt<T>> {
    return this.execute(key, effect, mapRejection);
  }

  private findInFlight(clientId: ClientId, commandId: CommandId): InFlightEntry | undefined {
    return this.inFlight.get(clientId)?.get(commandId);
  }

  private setInFlight(clientId: ClientId, commandId: CommandId, entry: InFlightEntry): void {
    let clientEntries = this.inFlight.get(clientId);
    if (clientEntries === undefined) {
      clientEntries = new Map<CommandId, InFlightEntry>();
      this.inFlight.set(clientId, clientEntries);
    }
    clientEntries.set(commandId, entry);
  }

  private removeInFlight(clientId: ClientId, commandId: CommandId, entry: InFlightEntry): void {
    const clientEntries = this.inFlight.get(clientId);
    if (clientEntries?.get(commandId) !== entry) {
      return;
    }

    clientEntries.delete(commandId);
    if (clientEntries.size === 0) {
      this.inFlight.delete(clientId);
    }
  }

  private findCompleted(clientId: ClientId, commandId: CommandId): CompletedEntry | undefined {
    return this.completed.get(clientId)?.get(commandId);
  }

  private completeAccepted<T>(
    clientId: ClientId,
    commandId: CommandId,
    entry: InFlightEntry,
    value: T,
  ): UnknownReceipt {
    const snapshot = canonicalizeAcceptedValue(value);
    const receipt: AcceptedCommandReceipt<T> = Object.freeze({ status: 'accepted', value: snapshot });
    this.cacheCompleted(clientId, commandId, receipt);
    this.removeInFlight(clientId, commandId, entry);
    return receipt;
  }

  private completeRejected(
    clientId: ClientId,
    commandId: CommandId,
    entry: InFlightEntry,
    rejection: CommandRejectionResult,
  ): RejectedCommandReceipt {
    const receipt = canonicalizeRejection(rejection);
    this.cacheCompleted(clientId, commandId, receipt);
    this.removeInFlight(clientId, commandId, entry);
    return receipt;
  }

  private cacheCompleted(clientId: ClientId, commandId: CommandId, receipt: UnknownReceipt): void {
    if (this.completedCapacity === 0) {
      return;
    }

    let clientEntries = this.completed.get(clientId);
    if (clientEntries === undefined) {
      clientEntries = new Map<CommandId, CompletedEntry>();
      this.completed.set(clientId, clientEntries);
    }

    const previous = clientEntries.get(commandId);
    if (previous !== undefined) {
      this.completedOrder.delete(previous);
    }

    const entry: CompletedEntry = {
      clientId,
      commandId,
      receipt,
    };
    clientEntries.set(commandId, entry);
    this.completedOrder.set(entry, undefined);

    while (this.completedOrder.size > this.completedCapacity) {
      const oldestResult = this.completedOrder.keys().next();
      if (oldestResult.done) {
        break;
      }
      const oldest = oldestResult.value;
      this.completedOrder.delete(oldest);

      const oldestClientEntries = this.completed.get(oldest.clientId);
      if (oldestClientEntries?.get(oldest.commandId) === oldest) {
        oldestClientEntries.delete(oldest.commandId);
        if (oldestClientEntries.size === 0) {
          this.completed.delete(oldest.clientId);
        }
      }
    }
  }
}

function validateCapacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('command deduper capacity must be a non-negative safe integer');
  }
  return value;
}

function canonicalizeAcceptedValue<T>(value: T): DeepReadonly<T> {
  return cloneAndFreezeJsonValue(value, new WeakSet<object>()) as DeepReadonly<T>;
}

function cloneAndFreezeJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) {
        return value;
      }
      throw new TypeError('command effect value must contain only finite numbers');
    case 'object':
      if (ancestors.has(value)) {
        throw new TypeError('command effect value must not contain cycles');
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return cloneAndFreezeArray(value, ancestors);
        }
        return cloneAndFreezeObject(value, ancestors);
      } finally {
        ancestors.delete(value);
      }
    default:
      throw new TypeError(`command effect value contains unsupported type: ${typeof value}`);
  }
}

function cloneAndFreezeArray(value: object, ancestors: WeakSet<object>): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('command effect value may contain only ordinary arrays');
  }

  const source = value as unknown[];
  const indices: number[] = [];
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') {
      throw new TypeError('command effect value may contain only string-keyed arrays');
    }
    if (key === 'length') {
      continue;
    }

    const index = parseArrayIndex(key, source.length);
    if (index === undefined) {
      throw new TypeError('command effect value arrays may not contain extra properties');
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('command effect value arrays must contain data elements');
    }
    indices.push(index);
  }

  if (indices.length !== source.length) {
    throw new TypeError('command effect value arrays may not contain holes');
  }

  const clone: unknown[] = new Array(source.length);
  indices.sort((left, right) => left - right);
  for (const index of indices) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('command effect value arrays must contain data elements');
    }
    clone[index] = cloneAndFreezeJsonValue(descriptor.value, ancestors);
  }
  return Object.freeze(clone);
}

function cloneAndFreezeObject(value: object, ancestors: WeakSet<object>): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('command effect value may contain only plain objects');
  }

  const clone: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError('command effect value objects must be string-keyed');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('command effect value objects must contain enumerable data properties');
    }

    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneAndFreezeJsonValue(descriptor.value, ancestors),
      writable: true,
    });
  }
  return Object.freeze(clone);
}

function parseArrayIndex(key: string, length: number): number | undefined {
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
    return undefined;
  }
  return index;
}

function canonicalizeRejection(value: CommandRejectionResult): RejectedCommandReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('command rejection mapper must return code and message');
  }

  const candidate = value as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (candidate.status !== undefined && candidate.status !== 'rejected') {
    throw new TypeError('command rejection mapper must return a rejected receipt');
  }
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    throw new TypeError('command rejection mapper must return string code and message');
  }

  return Object.freeze({
    status: 'rejected' as const,
    code: candidate.code,
    message: candidate.message,
  });
}
