export type ServerSeqDecision =
  | { readonly apply: true; readonly reason: 'forward' | 'forward_gap' }
  | { readonly apply: false; readonly reason: 'duplicate' | 'stale' };

function assertServerSeq(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function decideServerSeqApply(current: number, next: number): ServerSeqDecision {
  assertServerSeq(current, 'current serverSeq');
  assertServerSeq(next, 'next serverSeq');
  if (next === current) {
    return Object.freeze({ apply: false, reason: 'duplicate' });
  }
  if (next < current) {
    return Object.freeze({ apply: false, reason: 'stale' });
  }
  return Object.freeze({ apply: true, reason: next === current + 1 ? 'forward' : 'forward_gap' });
}

export interface SequencedState<S> {
  readonly state: S;
  readonly serverSeq: number;
}

export interface SequencedAction<A> {
  readonly serverSeq: number;
  readonly action: A;
}

export function applySequencedAction<S, A>(
  current: SequencedState<S>,
  next: SequencedAction<A>,
  reducer: (state: S, action: A) => S,
): SequencedState<S> {
  const decision = decideServerSeqApply(current.serverSeq, next.serverSeq);
  if (!decision.apply) {
    return current;
  }
  return Object.freeze({
    state: reducer(current.state, next.action),
    serverSeq: next.serverSeq,
  });
}
