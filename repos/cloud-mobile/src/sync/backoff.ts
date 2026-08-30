export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const defaultBackoffPolicy: BackoffPolicy = Object.freeze({
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
});

export function calculateBackoffDelay(
  attempt: number,
  policy: BackoffPolicy = defaultBackoffPolicy,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError('backoff attempt must be a non-negative safe integer');
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0 || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs || !Number.isFinite(policy.factor) || policy.factor < 1) {
    throw new RangeError('invalid backoff policy');
  }
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * (policy.factor ** attempt));
}

export function applyJitter(delayMs: number, jitter: () => number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('backoff delay must be a non-negative finite number');
  }
  const sample = jitter();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError('jitter must return a number between 0 and 1');
  }
  return Math.round(delayMs * (0.5 + sample));
}
