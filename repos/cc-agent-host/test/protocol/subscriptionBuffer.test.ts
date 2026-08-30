import { describe, expect, it } from 'vitest';

import {
  createChatUri,
  createTurnId,
  SubscriptionBuffer,
  type ActionEnvelope,
  type ChatAction,
  type ChatUri,
} from '../../src/index.js';

const channelA = createChatUri('session-1', 'chat-a');
const channelB = createChatUri('session-1', 'chat-b');

function actionEnvelope(serverSeq: number, channel: ChatUri = channelA): ActionEnvelope<ChatAction, ChatUri> {
  return {
    channel,
    action: {
      type: 'chat/turnStarted',
      turnId: createTurnId(`turn-${serverSeq}`),
      prompt: `prompt-${serverSeq}`,
      timestamp: `timestamp-${serverSeq}`,
    },
    serverSeq,
    serverTime: `server-${serverSeq}`,
  };
}

describe('SubscriptionBuffer', () => {
  it('buffers the snapshot race and flushes only actions after the snapshot cut', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const token = buffer.begin(channelA);
    const beforeCut = actionEnvelope(4);
    const afterCut = actionEnvelope(5);

    expect(buffer.receive(beforeCut)).toEqual({ type: 'buffer' });
    expect(buffer.receive(actionEnvelope(5, channelB))).toEqual({ type: 'ignore' });
    expect(buffer.receive(afterCut)).toEqual({ type: 'buffer' });

    const flushed = buffer.commit(token, 4);
    expect(flushed).toEqual([afterCut]);
    expect(Object.isFrozen(flushed)).toBe(true);
    expect(buffer.isActive(channelA)).toBe(true);
    expect(buffer.receive(actionEnvelope(6))).toEqual({ type: 'deliver', envelope: actionEnvelope(6) });
  });

  it('preserves buffered arrival order and does not duplicate a global sequence', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const token = buffer.begin(channelA);
    const first = actionEnvelope(10);
    const second = actionEnvelope(12);

    buffer.receive(first);
    buffer.receive(second);
    buffer.receive(first);

    expect(buffer.commit(token, 9).map((envelope) => envelope.serverSeq)).toEqual([10, 12]);
  });

  it('rejects stale tokens without committing or cancelling a newer subscription', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const stale = buffer.begin(channelA);
    buffer.receive(actionEnvelope(1));
    const current = buffer.begin(channelA);
    buffer.receive(actionEnvelope(2));

    expect(buffer.commit(stale, 0)).toEqual([]);
    expect(buffer.hasPending(channelA)).toBe(true);
    expect(buffer.commit(current, 1).map((envelope) => envelope.serverSeq)).toEqual([2]);

    buffer.cancel(stale);
    expect(buffer.isActive(channelA)).toBe(true);
    const live = actionEnvelope(3);
    const delivered = buffer.receive(live);
    expect(delivered).toEqual({ type: 'deliver', envelope: live });
  });

  it('cancels pending and active subscriptions without affecting other resources', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const pending = buffer.begin(channelA);
    buffer.receive(actionEnvelope(1));
    buffer.begin(channelB);
    buffer.commit(buffer.begin(channelB), 0);

    buffer.cancel(pending);
    expect(buffer.commit(pending, 0)).toEqual([]);
    expect(buffer.receive(actionEnvelope(2))).toEqual({ type: 'ignore' });
    expect(buffer.isActive(channelB)).toBe(true);

    buffer.unsubscribe(channelB);
    expect(buffer.receive(actionEnvelope(3, channelB))).toEqual({ type: 'ignore' });
  });

  it('delivers directly once active, including an envelope with an older sequence', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const token = buffer.begin(channelA);
    buffer.commit(token, 100);
    const envelope = actionEnvelope(1);

    expect(buffer.receive(envelope)).toEqual({ type: 'deliver', envelope });
  });

  it('keeps the action envelope generic over domain action fields', () => {
    const buffer = new SubscriptionBuffer<ChatAction, ChatUri>();
    const token = buffer.begin(channelA);
    const envelope = actionEnvelope(1);

    buffer.receive(envelope);
    expect(buffer.commit(token, 0)).toEqual([envelope]);
  });
});
