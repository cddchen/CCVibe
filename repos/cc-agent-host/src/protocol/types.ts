import type { ChatAction } from '../domain/actions.js';
import type { ChatState } from '../domain/chat.js';
import type { ChatUri, ClientId, CommandId } from '../domain/ids.js';
import type { AgentResource } from '../domain/resources.js';

/** A recursively readonly view used at the package boundary. */
export type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export interface ActionOrigin {
  readonly clientId: ClientId;
  readonly clientSeq: number;
  readonly commandId: CommandId;
}

export interface ActionEnvelope<A = ChatAction, R extends AgentResource = AgentResource> {
  readonly channel: R;
  readonly action: DeepReadonly<A>;
  readonly serverSeq: number;
  readonly serverTime: string;
  readonly origin?: ActionOrigin;
}

export interface StateSnapshot<S = ChatState, R extends AgentResource = AgentResource> {
  readonly resource: R;
  readonly state: DeepReadonly<S>;
  readonly fromSeq: number;
}

/**
 * The synchronized global cut returned by a reconnect operation.
 *
 * `throughSeq` is the protocol-neutral name. `serverSeq` is retained as an
 * explicit alias for callers that use the HostStateManager terminology.
 */
export interface ReconnectResultCut {
  readonly throughSeq: number;
  readonly serverSeq: number;
  /** Set by a protocol state provider; Phase 0 hosts may omit it. */
  readonly hostEpoch?: string;
}

export interface ReplayReconnectResult<A = ChatAction, R extends AgentResource = AgentResource>
  extends ReconnectResultCut {
  readonly type: 'replay';
  readonly actions: readonly ActionEnvelope<A, R>[];
  readonly missing: readonly R[];
}

export interface SnapshotReconnectResult<S = ChatState, R extends AgentResource = AgentResource>
  extends ReconnectResultCut {
  readonly type: 'snapshot';
  readonly snapshots: readonly StateSnapshot<S, R>[];
  readonly missing: readonly R[];
}

export type ReconnectResult<
  A = ChatAction,
  S = ChatState,
  R extends AgentResource = AgentResource,
> = ReplayReconnectResult<A, R> | SnapshotReconnectResult<S, R>;

export type ChatActionEnvelope = ActionEnvelope<ChatAction, ChatUri>;
export type ChatStateSnapshot = StateSnapshot<ChatState, ChatUri>;
export type ChatReconnectResult = ReconnectResult<ChatAction, ChatState, ChatUri>;

/**
 * Values cloned and frozen at this package boundary are safe to share again.
 * Keeping the registry private prevents callers from claiming mutability-safe
 * status for an arbitrary externally frozen object.
 */
const immutableBoundaryValues = new WeakSet<object>();

function freezeBoundaryValue<T extends object>(value: T): Readonly<T> {
  Object.freeze(value);
  immutableBoundaryValues.add(value);
  return value;
}

/**
 * Freeze a package-created array without copying it. Object elements must have
 * already crossed the immutable boundary, so callers cannot use this helper to
 * bless an arbitrary shallow-frozen object graph.
 *
 * @internal
 */
export function freezeBoundaryArray<T>(value: T[]): readonly T[] {
  for (const item of value) {
    if (typeof item === 'object' && item !== null && !immutableBoundaryValues.has(item)) {
      throw new TypeError('immutable boundary array contains an unregistered object');
    }
  }
  return freezeBoundaryValue(value);
}

/**
 * Clone a protocol/domain value and recursively freeze the clone.
 *
 * Phase 0 values are JSON-shaped domain objects. Keeping this helper here lets
 * the protocol and host shells share one defensive-copy boundary without
 * making the domain layer depend on runtime concerns. Values that have
 * already crossed this boundary are returned by identity; external values are
 * still cloned even when they happen to be frozen by their caller.
 */
export function cloneAndFreeze<T>(value: T): T {
  return freezeClone(value) as T;
}

function freezeClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (immutableBoundaryValues.has(value)) {
    return value;
  }

  const frozen = Array.isArray(value)
    ? freezeBoundaryValue(value.map((item) => freezeClone(item)))
    : freezeObject(value as Record<string, unknown>);
  return frozen;
}

function freezeObject(source: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    clone[key] = freezeClone(child);
  }
  return freezeBoundaryValue(clone);
}
