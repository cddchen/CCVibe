import type { ChatAction } from '../domain/actions.js';
import type { AgentResource } from '../domain/resources.js';
import type { ActionEnvelope } from './types.js';

export interface SubscriptionToken<R extends AgentResource = AgentResource> {
  readonly resource: R;
  readonly generation: number;
}

export type SubscriptionReceiveResult<
  A = ChatAction,
  R extends AgentResource = AgentResource,
> =
  | { readonly type: 'deliver'; readonly envelope: ActionEnvelope<A, R> }
  | { readonly type: 'buffer' }
  | { readonly type: 'ignore' };

interface PendingSubscription<A, R extends AgentResource> {
  readonly kind: 'pending';
  readonly token: SubscriptionToken<R>;
  readonly buffered: ActionEnvelope<A, R>[];
  readonly bufferedServerSeqs: Set<number>;
}

interface ActiveSubscription<R extends AgentResource> {
  readonly kind: 'active';
  readonly token: SubscriptionToken<R>;
}

type SubscriptionState<A, R extends AgentResource> =
  | PendingSubscription<A, R>
  | ActiveSubscription<R>;

const BUFFERED_RESULT: { readonly type: 'buffer' } = Object.freeze({ type: 'buffer' });
const IGNORED_RESULT: { readonly type: 'ignore' } = Object.freeze({ type: 'ignore' });

/**
 * A transport-independent snapshot-before-action barrier.
 *
 * `begin` starts a new generation for one resource and invalidates any older
 * token for that resource. Actions received before `commit` are retained only
 * long enough to bridge the snapshot response. `cancel`/`unsubscribe` remove
 * the barrier and its buffer without affecting host state.
 */
export class SubscriptionBuffer<
  A = ChatAction,
  R extends AgentResource = AgentResource,
> {
  private readonly subscriptions = new Map<R, SubscriptionState<A, R>>();
  private nextGeneration = 0;

  public begin(resource: R): SubscriptionToken<R> {
    this.nextGeneration += 1;
    const token: SubscriptionToken<R> = Object.freeze({
      resource,
      generation: this.nextGeneration,
    });
    this.subscriptions.set(resource, {
      kind: 'pending',
      token,
      buffered: [],
      bufferedServerSeqs: new Set<number>(),
    });
    return token;
  }

  public receive(envelope: ActionEnvelope<A, R>): SubscriptionReceiveResult<A, R> {
    const state = this.subscriptions.get(envelope.channel);
    if (state === undefined) {
      return IGNORED_RESULT;
    }

    if (state.kind === 'pending') {
      if (!state.bufferedServerSeqs.has(envelope.serverSeq)) {
        state.bufferedServerSeqs.add(envelope.serverSeq);
        state.buffered.push(envelope);
      }
      return BUFFERED_RESULT;
    }

    return { type: 'deliver', envelope };
  }

  public commit(token: SubscriptionToken<R>, fromSeq: number): readonly ActionEnvelope<A, R>[] {
    assertSequence(fromSeq);
    const state = this.subscriptions.get(token.resource);
    if (state === undefined || state.kind !== 'pending' || !sameToken(state.token, token)) {
      return EMPTY_ENVELOPES as readonly ActionEnvelope<A, R>[];
    }

    const actions = state.buffered.filter((envelope) => envelope.serverSeq > fromSeq);

    this.subscriptions.set(token.resource, {
      kind: 'active',
      token: state.token,
    });
    return Object.freeze(actions);
  }

  public cancel(token: SubscriptionToken<R>): void {
    const state = this.subscriptions.get(token.resource);
    if (state !== undefined && sameToken(state.token, token)) {
      this.subscriptions.delete(token.resource);
    }
  }

  /** Remove a resource regardless of which generation is currently active. */
  public unsubscribe(resource: R): void {
    this.subscriptions.delete(resource);
  }

  public isActive(resource: R): boolean {
    return this.subscriptions.get(resource)?.kind === 'active';
  }

  public hasPending(resource: R): boolean {
    return this.subscriptions.get(resource)?.kind === 'pending';
  }
}

export type SubscriptionBarrier<A = ChatAction, R extends AgentResource = AgentResource> = SubscriptionBuffer<A, R>;

export function createSubscriptionBuffer<
  A = ChatAction,
  R extends AgentResource = AgentResource,
>(): SubscriptionBuffer<A, R> {
  return new SubscriptionBuffer<A, R>();
}

const EMPTY_ENVELOPES: readonly unknown[] = Object.freeze([]);

function sameToken<R extends AgentResource>(
  left: SubscriptionToken<R>,
  right: SubscriptionToken<R>,
): boolean {
  return left.resource === right.resource && left.generation === right.generation;
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('subscription snapshot sequence must be a non-negative safe integer');
  }
}
