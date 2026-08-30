import type { RawData } from 'ws';

/** A source-independent representation accepted by the ws message callback. */
export type TransportRawData = RawData | string | Uint8Array | ArrayBuffer | readonly Uint8Array[];

export type IncomingFrameDecision =
  | { readonly kind: 'text'; readonly bytes: number }
  | { readonly kind: 'binary'; readonly bytes: number }
  | { readonly kind: 'too-large'; readonly bytes: number; readonly limit: number };

/** Pure byte measurement used before decoding a frame as UTF-8. */
export function rawDataByteLength(data: TransportRawData): number {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  // RawData currently has only the cases above.  Keeping a defensive branch
  // makes this boundary fail closed if ws adds another binary representation.
  return Number.POSITIVE_INFINITY;
}

/** Pure frame classification.  Binary and oversized frames are never text-decoded. */
export function assessIncomingFrame(
  data: TransportRawData,
  isBinary: boolean,
  limit: number,
): IncomingFrameDecision {
  assertByteLimit(limit, 'frame limit');
  const bytes = rawDataByteLength(data);
  if (isBinary) {
    return { kind: 'binary', bytes };
  }
  if (bytes > limit) {
    return { kind: 'too-large', bytes, limit };
  }
  return { kind: 'text', bytes };
}

/** Pure queue admission decision; no frame is queued by this helper. */
export interface QueueLimitDecision {
  readonly allowed: boolean;
  readonly pending: number;
  readonly limit: number;
  readonly reason?: 'queue-full';
}

export function assessPendingFrames(
  pending: number,
  limit: number,
): QueueLimitDecision {
  assertNonNegativeSafeInteger(pending, 'pending frame count');
  assertPositiveSafeInteger(limit, 'pending frame limit');
  if (pending >= limit) {
    return Object.freeze({ allowed: false, pending, limit, reason: 'queue-full' });
  }
  return Object.freeze({ allowed: true, pending: pending + 1, limit });
}

/** Alias for callers that name the queue as in-flight work. */
export const admitPendingFrame = assessPendingFrames;

export interface RateLimitPolicy {
  readonly maxMessages: number;
  readonly windowMs: number;
  readonly maxBytes?: number;
}

export interface RateLimitState {
  readonly windowStartedAt: number;
  readonly acceptedMessages: number;
  readonly acceptedBytes: number;
}

export interface RateLimitEvent {
  readonly bytes: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly state: RateLimitState;
  readonly retryAfterMs: number;
  readonly reason?: 'messages' | 'bytes';
}

export function createRateLimitState(now = 0): RateLimitState {
  assertTimestamp(now);
  return Object.freeze({ windowStartedAt: now, acceptedMessages: 0, acceptedBytes: 0 });
}

/**
 * Consume one event from a fixed-window limiter without mutating its input.
 * Clock rollback never grants a fresh window; a forward boundary does.
 */
export function evaluateRateLimit(
  state: RateLimitState,
  event: RateLimitEvent,
  now: number,
  policy: RateLimitPolicy,
): RateLimitDecision {
  assertRateLimitPolicy(policy);
  assertTimestamp(now);
  assertNonNegativeSafeInteger(event.bytes, 'rate-limit event bytes');
  assertRateLimitState(state);

  const elapsed = now - state.windowStartedAt;
  const fresh = elapsed >= policy.windowMs;
  const base = fresh
    ? { windowStartedAt: now, acceptedMessages: 0, acceptedBytes: 0 }
    : state;
  const retryAfterMs = Math.max(0, base.windowStartedAt + policy.windowMs - now);

  if (base.acceptedMessages >= policy.maxMessages) {
    return Object.freeze({ allowed: false, state: Object.freeze({ ...base }), retryAfterMs, reason: 'messages' });
  }
  if (base.acceptedBytes + event.bytes > (policy.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
    return Object.freeze({ allowed: false, state: Object.freeze({ ...base }), retryAfterMs, reason: 'bytes' });
  }

  const nextState = Object.freeze({
    windowStartedAt: base.windowStartedAt,
    acceptedMessages: base.acceptedMessages + 1,
    acceptedBytes: base.acceptedBytes + event.bytes,
  });
  return Object.freeze({ allowed: true, state: nextState, retryAfterMs: 0 });
}

/** Common verb for code that models a limiter as a consume operation. */
export const consumeRateLimit = evaluateRateLimit;

export interface BufferedAmountDecision {
  readonly allowed: boolean;
  readonly bufferedAmount: number;
  readonly highWaterMarkBytes: number;
}

/** Pure backpressure predicate shared by adapter and tests. */
export function assessBufferedAmount(
  bufferedAmount: number,
  highWaterMarkBytes: number,
): BufferedAmountDecision {
  assertNonNegativeSafeInteger(bufferedAmount, 'buffered amount');
  assertNonNegativeSafeInteger(highWaterMarkBytes, 'high-water mark');
  return Object.freeze({
    allowed: bufferedAmount <= highWaterMarkBytes,
    bufferedAmount,
    highWaterMarkBytes,
  });
}

export interface SubscriptionLimitState {
  readonly resources: readonly string[];
}

export type SubscriptionLimitDecision =
  | { readonly allowed: true; readonly state: SubscriptionLimitState }
  | {
    readonly allowed: false;
    readonly state: SubscriptionLimitState;
    readonly reason: 'subscriptions';
  };

export function createSubscriptionLimitState(): SubscriptionLimitState {
  return Object.freeze({ resources: Object.freeze([]) });
}

/**
 * Inspect only the subscription-shaped part of a JSON-RPC frame.  Business
 * validation remains the protocol handler's job; this helper exists solely
 * to prevent an attacker from creating an unbounded subscription collection.
 * Malformed/non-subscription frames are passed through unchanged.
 */
export function applySubscriptionLimit(
  raw: string,
  state: SubscriptionLimitState,
  limit: number,
): SubscriptionLimitDecision {
  assertPositiveSafeInteger(limit, 'subscription limit');
  assertSubscriptionState(state);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { allowed: true, state };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string' || !isRecord(parsed.params)) {
    return { allowed: true, state };
  }

  const method = parsed.method;
  if (method === 'initialize' || method === 'reconnect') {
    const key = method === 'initialize' ? 'initialSubscriptions' : 'subscriptions';
    const values = parsed.params[key];
    if (!Array.isArray(values)) {
      return { allowed: true, state };
    }
    // Count every array member for the admission decision, including malformed
    // members that the protocol parser will reject later.
    if (values.length > limit) {
      return { allowed: false, state, reason: 'subscriptions' };
    }
    const resources = uniqueStrings(values);
    if (resources.length > limit) {
      return { allowed: false, state, reason: 'subscriptions' };
    }
    return { allowed: true, state: freezeSubscriptionState(resources) };
  }

  if (method === 'subscribe') {
    const resource = parsed.params.channel;
    if (typeof resource !== 'string' || state.resources.includes(resource)) {
      return { allowed: true, state };
    }
    if (state.resources.length >= limit) {
      return { allowed: false, state, reason: 'subscriptions' };
    }
    return { allowed: true, state: freezeSubscriptionState([...state.resources, resource]) };
  }

  if (method === 'unsubscribe') {
    const resource = parsed.params.channel;
    if (typeof resource !== 'string' || !state.resources.includes(resource)) {
      return { allowed: true, state };
    }
    return {
      allowed: true,
      state: freezeSubscriptionState(state.resources.filter((item) => item !== resource)),
    };
  }

  return { allowed: true, state };
}

/** Alias that emphasizes this is a pure frame-level check. */
export const assessSubscriptionFrame = applySubscriptionLimit;

function freezeSubscriptionState(resources: readonly string[]): SubscriptionLimitState {
  return Object.freeze({ resources: Object.freeze([...resources]) });
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === 'string' && !result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertByteLimit(value: number, name: string): void {
  assertNonNegativeSafeInteger(value, name);
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError('rate-limit timestamp must be finite');
  }
}

function assertRateLimitPolicy(policy: RateLimitPolicy): void {
  assertPositiveSafeInteger(policy.maxMessages, 'rate-limit maxMessages');
  assertPositiveSafeInteger(policy.windowMs, 'rate-limit windowMs');
  if (policy.maxBytes !== undefined) {
    assertPositiveSafeInteger(policy.maxBytes, 'rate-limit maxBytes');
  }
}

function assertRateLimitState(state: RateLimitState): void {
  assertTimestamp(state.windowStartedAt);
  assertNonNegativeSafeInteger(state.acceptedMessages, 'rate-limit acceptedMessages');
  assertNonNegativeSafeInteger(state.acceptedBytes, 'rate-limit acceptedBytes');
}

function assertSubscriptionState(state: SubscriptionLimitState): void {
  if (!Array.isArray(state.resources) || state.resources.some((resource) => typeof resource !== 'string')) {
    throw new TypeError('subscription state resources must be strings');
  }
}

