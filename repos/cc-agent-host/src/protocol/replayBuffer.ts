import type { ChatAction } from '../domain/actions.js';
import type { AgentResource } from '../domain/resources.js';
import { cloneAndFreeze, freezeBoundaryArray, type ActionEnvelope } from './types.js';

export interface ReplayBufferOptions {
  readonly maxActions: number;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Whether every global sequence after lastSeen is still represented by the
 * buffer. The oldest buffered action is usable when the client has seen the
 * sequence immediately before it.
 */
export function canReplayFrom(
  oldestBufferedSeq: number | undefined,
  currentServerSeq: number,
  lastSeen: number,
): boolean {
  if (!isNonNegativeSafeInteger(currentServerSeq) || !isNonNegativeSafeInteger(lastSeen)) {
    return false;
  }

  if (lastSeen > currentServerSeq) {
    return false;
  }

  if (lastSeen === currentServerSeq) {
    return true;
  }

  if (oldestBufferedSeq === undefined) {
    return false;
  }

  return isPositiveSafeInteger(oldestBufferedSeq) && lastSeen >= oldestBufferedSeq - 1;
}

/** Select subscribed actions without renumbering their global sequences. */
export function selectReplayActions<
  A = ChatAction,
  R extends AgentResource = AgentResource,
>(
  envelopes: readonly ActionEnvelope<A, R>[],
  lastSeenServerSeq: number,
  channels: ReadonlySet<R>,
): readonly ActionEnvelope<A, R>[] {
  const selected: ActionEnvelope<A, R>[] = [];
  for (const envelope of envelopes) {
    if (envelope.serverSeq > lastSeenServerSeq && channels.has(envelope.channel)) {
      selected.push(cloneAndFreeze(envelope));
    }
  }

  return freezeBoundaryArray(selected);
}

export class ReplayBuffer<
  A = ChatAction,
  R extends AgentResource = AgentResource,
> {
  private readonly maxActions: number;
  private readonly envelopes: Array<ActionEnvelope<A, R> | undefined>;
  private start = 0;
  private count = 0;
  private latestServerSeq: number | undefined;

  public constructor(options: ReplayBufferOptions) {
    if (!Number.isSafeInteger(options.maxActions) || options.maxActions < 0) {
      throw new RangeError('replay maxActions must be a non-negative safe integer');
    }
    this.maxActions = options.maxActions;
    this.envelopes = new Array<ActionEnvelope<A, R> | undefined>(options.maxActions);
  }

  public get size(): number {
    return this.count;
  }

  public get oldestBufferedSeq(): number | undefined {
    return this.count === 0 ? undefined : this.envelopes[this.start]?.serverSeq;
  }

  public append(envelope: ActionEnvelope<A, R>): void {
    const immutableEnvelope = cloneAndFreeze(envelope);
    if (!isPositiveSafeInteger(immutableEnvelope.serverSeq)) {
      throw new RangeError('replay serverSeq must be a positive safe integer');
    }

    if (this.latestServerSeq !== undefined && immutableEnvelope.serverSeq <= this.latestServerSeq) {
      throw new RangeError('replay envelopes must have strictly increasing serverSeq values');
    }
    this.latestServerSeq = immutableEnvelope.serverSeq;

    if (this.maxActions === 0) {
      return;
    }

    const insertAt = (this.start + this.count) % this.maxActions;
    this.envelopes[insertAt] = immutableEnvelope;
    if (this.count < this.maxActions) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.maxActions;
    }
  }

  public replayAfter(
    lastSeenServerSeq: number,
    channels: ReadonlySet<R>,
  ): readonly ActionEnvelope<A, R>[] {
    const ordered: ActionEnvelope<A, R>[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const index = (this.start + offset) % this.maxActions;
      const envelope = this.envelopes[index];
      if (envelope !== undefined) {
        ordered.push(envelope);
      }
    }
    return selectReplayActions(ordered, lastSeenServerSeq, channels);
  }
}
