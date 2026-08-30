import { applySequencedAction, type SequencedAction, type SequencedState } from './serverSeq';

export interface ReconnectSnapshot<S> {
  readonly fromSeq: number;
  readonly state: S;
}

export type ReconnectPayload<S, A> =
  | {
      readonly type: 'replay';
      readonly actions: readonly SequencedAction<A>[];
      readonly throughSeq: number;
    }
  | {
      readonly type: 'snapshot';
      readonly snapshot: ReconnectSnapshot<S>;
      readonly throughSeq: number;
    };

export function applyReconnect<S, A>(
  current: SequencedState<S>,
  payload: ReconnectPayload<S, A>,
  reducer: (state: S, action: A) => S,
): SequencedState<S> {
  if (!Number.isSafeInteger(payload.throughSeq) || payload.throughSeq < 0) {
    throw new RangeError('throughSeq must be a non-negative safe integer');
  }
  if (payload.throughSeq < current.serverSeq) {
    throw new RangeError('reconnect cut cannot move serverSeq backwards');
  }

  if (payload.type === 'snapshot') {
    if (!Number.isSafeInteger(payload.snapshot.fromSeq) || payload.snapshot.fromSeq < 0) {
      throw new RangeError('snapshot fromSeq must be a non-negative safe integer');
    }
    if (payload.snapshot.fromSeq > payload.throughSeq) {
      throw new RangeError('snapshot fromSeq cannot exceed throughSeq');
    }
    return Object.freeze({ state: payload.snapshot.state, serverSeq: payload.throughSeq });
  }

  let result = current;
  for (const action of payload.actions) {
    result = applySequencedAction(result, action, reducer);
  }
  return result.serverSeq === payload.throughSeq
    ? result
    : Object.freeze({ state: result.state, serverSeq: payload.throughSeq });
}
