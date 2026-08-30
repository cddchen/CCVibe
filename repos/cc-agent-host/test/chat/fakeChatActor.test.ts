import { describe, expect, it } from 'vitest';

import {
  createChatUri,
  createClientId,
  createCommandId,
  createTurnId,
  HostStateManager,
} from '../../src/index.js';
import {
  FakeChatActor,
  type FakeChatActorDeps,
} from '../../src/chat/fakeChatActor.js';
import { CommandDeduper } from '../../src/chat/commandDeduper.js';
import { SequencerByKey } from '../../src/chat/sequencer.js';

const channel = createChatUri('session-1', 'chat-1');
const missingChannel = createChatUri('session-1', 'missing-chat');
const clientA = createClientId('client-a');
const clientB = createClientId('client-b');

function makeActor(options: {
  readonly actionTimes?: readonly string[];
  readonly turnIds?: readonly string[];
  readonly onActionTime?: (call: number) => string;
} = {}): {
  readonly actor: FakeChatActor;
  readonly host: HostStateManager;
  readonly actionCalls: { value: number };
  readonly turnCalls: { value: number };
} {
  const actionCalls = { value: 0 };
  const turnCalls = { value: 0 };
  const actionTimes = options.actionTimes ?? ['action-time-1', 'action-time-2', 'action-time-3'];
  const turnIds = options.turnIds ?? ['turn-1', 'turn-2', 'turn-3'];
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 16 });
  host.registerChat(channel);

  const deps: FakeChatActorDeps = {
    hostStateManager: host,
    sequencer: new SequencerByKey(),
    commandDeduper: new CommandDeduper({ capacity: 16 }),
    nowAction: () => {
      actionCalls.value += 1;
      const custom = options.onActionTime?.(actionCalls.value);
      return custom ?? actionTimes[actionCalls.value - 1] ?? `action-time-${actionCalls.value}`;
    },
    allocateTurnId: () => {
      turnCalls.value += 1;
      const value = turnIds[turnCalls.value - 1] ?? `turn-${turnCalls.value}`;
      return createTurnId(value);
    },
  };
  return { actor: new FakeChatActor(deps), host, actionCalls, turnCalls };
}

describe('FakeChatActor', () => {
  it('accepts send, commits a typed action, and preserves its canonical receipt on retry', async () => {
    const { actor, host, actionCalls, turnCalls } = makeActor();
    const envelopes: unknown[] = [];
    host.subscribe((envelope) => envelopes.push(envelope));

    const first = await actor.dispatch(
      clientA,
      7,
      createCommandId('send-command'),
      channel,
      { type: 'chat/send', prompt: 'hello' },
    );

    expect(first).toEqual({
      status: 'accepted',
      value: { acceptedAtSeq: 1, turnId: createTurnId('turn-1') },
    });
    expect(host.getState(channel)?.activeTurn).toMatchObject({
      id: createTurnId('turn-1'),
      prompt: 'hello',
      startedAt: 'action-time-1',
    });
    expect(actionCalls.value).toBe(1);
    expect(turnCalls.value).toBe(1);
    expect(envelopes).toHaveLength(1);

    const envelope = envelopes[0];
    expect(envelope).toMatchObject({
      channel,
      serverSeq: 1,
      action: {
        type: 'chat/turnStarted',
        timestamp: 'action-time-1',
        turnId: createTurnId('turn-1'),
        prompt: 'hello',
      },
      origin: {
        clientId: clientA,
        clientSeq: 7,
        commandId: createCommandId('send-command'),
      },
    });
    if (typeof envelope !== 'object' || envelope === null || !('origin' in envelope)) {
      throw new Error('expected action origin');
    }
    expect(Object.keys(envelope.origin as object).sort()).toEqual(['clientId', 'clientSeq', 'commandId']);

    const retry = await actor.dispatch(
      clientA,
      99,
      createCommandId('send-command'),
      channel,
      { type: 'chat/send', prompt: 'different prompt must not run' },
    );
    expect(retry).toBe(first);
    expect(host.serverSeq).toBe(1);
    expect(actionCalls.value).toBe(1);
    expect(turnCalls.value).toBe(1);
  });

  it('rejects busy, wrong-target, and missing-resource commands without consuming a sequence', async () => {
    const { actor, host, actionCalls, turnCalls } = makeActor();
    const accepted = await actor.dispatch(
      clientA,
      1,
      createCommandId('first-send'),
      channel,
      { type: 'chat/send', prompt: 'running' },
    );
    if (accepted.status !== 'accepted' || accepted.value.turnId === undefined) {
      throw new Error('expected an active turn');
    }

    await expect(
      actor.dispatch(
        clientB,
        2,
        createCommandId('busy-send'),
        channel,
        { type: 'chat/send', prompt: 'blocked' },
      ),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'CHAT_BUSY',
      message: 'chat already has an active turn',
    });

    await expect(
      actor.dispatch(
        clientB,
        3,
        createCommandId('wrong-interrupt'),
        channel,
        { type: 'chat/interrupt', turnId: createTurnId('not-the-active-turn') },
      ),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'TURN_NOT_ACTIVE',
      message: 'turn is not active',
    });

    await expect(
      actor.dispatch(
        clientB,
        4,
        createCommandId('missing-send'),
        missingChannel,
        { type: 'chat/send', prompt: 'missing' },
      ),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'RESOURCE_NOT_FOUND',
      message: 'chat resource was not found',
    });

    expect(host.serverSeq).toBe(1);
    expect(actionCalls.value).toBe(1);
    expect(turnCalls.value).toBe(1);
    expect(host.getState(missingChannel)).toBeUndefined();
  });

  it('interrupts only the matching active turn and returns an accepted sequence', async () => {
    const { actor, host, actionCalls } = makeActor();
    const send = await actor.dispatch(
      clientA,
      1,
      createCommandId('send'),
      channel,
      { type: 'chat/send', prompt: 'interrupt me' },
    );
    if (send.status !== 'accepted' || send.value.turnId === undefined) {
      throw new Error('expected send to be accepted');
    }

    const interrupt = await actor.dispatch(
      clientB,
      2,
      createCommandId('interrupt'),
      channel,
      { type: 'chat/interrupt', turnId: send.value.turnId },
    );

    expect(interrupt).toEqual({ status: 'accepted', value: { acceptedAtSeq: 2 } });
    expect(host.getState(channel)?.activeTurn).toBeUndefined();
    expect(host.getState(channel)?.turns).toEqual([
      expect.objectContaining({
        id: send.value.turnId,
        status: 'interrupted',
        completedAt: 'action-time-2',
      }),
    ]);
    expect(actionCalls.value).toBe(2);
  });

  it('serializes same-channel commands before checking active state', async () => {
    const { actor, host } = makeActor();
    const first = actor.dispatch(
      clientA,
      1,
      createCommandId('parallel-send-a'),
      channel,
      { type: 'chat/send', prompt: 'first' },
    );
    const second = actor.dispatch(
      clientB,
      1,
      createCommandId('parallel-send-b'),
      channel,
      { type: 'chat/send', prompt: 'second' },
    );

    await expect(first).resolves.toMatchObject({ status: 'accepted', value: { acceptedAtSeq: 1 } });
    await expect(second).resolves.toEqual({
      status: 'rejected',
      code: 'CHAT_BUSY',
      message: 'chat already has an active turn',
    });
    expect(host.serverSeq).toBe(1);
  });

  it('maps unexpected dependency failures to a safe cached rejection', async () => {
    const secret = 'do-not-return-this-error';
    const { actor, host } = makeActor({
      onActionTime: () => {
        throw new Error(secret);
      },
    });

    const first = await actor.dispatch(
      clientA,
      1,
      createCommandId('clock-failure'),
      channel,
      { type: 'chat/send', prompt: 'hello' },
    );
    expect(first).toEqual({ status: 'rejected', code: 'INTERNAL_ERROR', message: 'chat command failed' });
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(host.serverSeq).toBe(0);

    const retry = await actor.dispatch(
      clientA,
      99,
      createCommandId('clock-failure'),
      channel,
      { type: 'chat/send', prompt: 'retry must use cached rejection' },
    );
    expect(retry).toBe(first);
  });

  it('rejects forged direct clientSeq values before constructing origin metadata', () => {
    const { actor, host } = makeActor();
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1' as unknown as number];

    for (const [index, clientSeq] of invalidValues.entries()) {
      expect(() => actor.dispatch(
        clientA,
        clientSeq,
        createCommandId(`invalid-client-seq-${index}`),
        channel,
        { type: 'chat/send', prompt: 'must not commit' },
      )).toThrow(RangeError);
    }

    expect(host.serverSeq).toBe(0);
    expect(host.getState(channel)?.activeTurn).toBeUndefined();
  });
});
