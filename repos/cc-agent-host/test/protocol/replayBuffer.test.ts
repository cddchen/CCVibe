import { describe, expect, it } from 'vitest';

import {
  canReplayFrom,
  createChatUri,
  createRootUri,
  createSessionUri,
  createTurnId,
  ReplayBuffer,
  selectReplayActions,
  type ActionEnvelope,
  type AgentResource,
  type ChatAction,
  type ChatActionEnvelope,
  type ChatUri,
  type RootUri,
  type SessionUri,
} from '../../src/index.js';

const channelA = createChatUri('session-1', 'chat-a');
const channelB = createChatUri('session-1', 'chat-b');
const rootChannel = createRootUri();
const sessionChannel = createSessionUri('session-1');

type RootAction = { readonly type: 'root/changed'; readonly value: string };
type SessionAction = { readonly type: 'session/changed'; readonly value: string };

function envelope(serverSeq: number, channel = channelA): ChatActionEnvelope {
  return {
    channel,
    action: {
      type: 'chat/turnStarted',
      turnId: createTurnId(`turn-${serverSeq}`),
      prompt: `prompt-${serverSeq}`,
      timestamp: `action-${serverSeq}`,
    },
    serverSeq,
    serverTime: `server-${serverSeq}`,
  };
}

function rootEnvelope(serverSeq: number): ActionEnvelope<RootAction, RootUri> {
  return {
    channel: rootChannel,
    action: { type: 'root/changed', value: `root-${serverSeq}` },
    serverSeq,
    serverTime: `server-${serverSeq}`,
  };
}

function sessionEnvelope(serverSeq: number): ActionEnvelope<SessionAction, SessionUri> {
  return {
    channel: sessionChannel,
    action: { type: 'session/changed', value: `session-${serverSeq}` },
    serverSeq,
    serverTime: `server-${serverSeq}`,
  };
}

describe('ReplayBuffer', () => {
  it('uses oldest buffered sequence minus one as the replay boundary', () => {
    const buffer = new ReplayBuffer({ maxActions: 2 });
    buffer.append(envelope(1));
    buffer.append(envelope(2));
    buffer.append(envelope(3));

    expect(buffer.oldestBufferedSeq).toBe(2);
    expect(canReplayFrom(buffer.oldestBufferedSeq, 3, 1)).toBe(true);
    expect(canReplayFrom(buffer.oldestBufferedSeq, 3, 0)).toBe(false);
    expect(buffer.replayAfter(1, new Set([channelA])).map((item) => item.serverSeq)).toEqual([2, 3]);
  });

  it('filters channels without renumbering global sequence gaps', () => {
    const envelopes = [envelope(1, channelA), envelope(2, channelB), envelope(3, channelA)];

    expect(selectReplayActions(envelopes, 0, new Set([channelA])).map((item) => item.serverSeq)).toEqual([1, 3]);
    expect(selectReplayActions(envelopes, 1, new Set([channelA])).map((item) => item.serverSeq)).toEqual([3]);
  });

  it('keeps ordered replay across ring wraparound and eviction', () => {
    const buffer = new ReplayBuffer({ maxActions: 3 });
    for (const serverSeq of [1, 2, 3, 4, 5]) {
      buffer.append(envelope(serverSeq));
    }

    expect(buffer.size).toBe(3);
    expect(buffer.oldestBufferedSeq).toBe(3);
    expect(buffer.replayAfter(0, new Set([channelA])).map((item) => item.serverSeq)).toEqual([3, 4, 5]);

    buffer.append(envelope(6));
    expect(buffer.oldestBufferedSeq).toBe(4);
    expect(buffer.replayAfter(0, new Set([channelA])).map((item) => item.serverSeq)).toEqual([4, 5, 6]);
  });

  it('retains sequence validation and empty replay at capacity zero', () => {
    const buffer = new ReplayBuffer({ maxActions: 0 });

    expect(() => buffer.append(envelope(0))).toThrow('positive safe integer');
    expect(() => buffer.append(envelope(-1))).toThrow('positive safe integer');
    buffer.append(envelope(2));
    expect(() => buffer.append(envelope(2))).toThrow('strictly increasing');
    expect(() => buffer.append(envelope(1))).toThrow('strictly increasing');

    expect(buffer.size).toBe(0);
    expect(buffer.oldestBufferedSeq).toBeUndefined();
    expect(buffer.replayAfter(2, new Set([channelA]))).toEqual([]);
  });

  it('defensively clones direct external selections but reuses immutable envelope references', () => {
    const external = envelope(1);
    const selected = selectReplayActions([external], 0, new Set([channelA]));
    const selectedEnvelope = selected[0];
    expect(selectedEnvelope).toBeDefined();
    if (selectedEnvelope === undefined) {
      return;
    }

    expect(selectedEnvelope).not.toBe(external);
    (external.action as unknown as { prompt: string }).prompt = 'mutated-input';
    if (selectedEnvelope.action.type === 'chat/turnStarted') {
      expect(selectedEnvelope.action.prompt).toBe('prompt-1');
    }
    expect(Object.isFrozen(selected)).toBe(true);

    const buffer = new ReplayBuffer({ maxActions: 2 });
    buffer.append(envelope(2));
    const firstReplay = buffer.replayAfter(0, new Set([channelA]));
    const secondReplay = selectReplayActions(firstReplay, 0, new Set([channelA]));
    expect(secondReplay[0]).toBe(firstReplay[0]);
  });

  it('returns no fabricated action for an empty buffer', () => {
    const buffer = new ReplayBuffer({ maxActions: 2 });

    expect(canReplayFrom(undefined, 0, 0)).toBe(true);
    expect(canReplayFrom(undefined, 3, 2)).toBe(false);
    expect(buffer.replayAfter(0, new Set([channelA]))).toEqual([]);
  });

  it('defensively clones and freezes appended envelopes and replay results', () => {
    const input = envelope(1);
    const buffer = new ReplayBuffer({ maxActions: 2 });
    buffer.append(input);

    const replayed = buffer.replayAfter(0, new Set([channelA]));
    const returned = replayed[0];
    expect(returned).toBeDefined();
    if (returned === undefined) {
      return;
    }

    expect(returned).not.toBe(input);
    (input.action as unknown as { prompt: string }).prompt = 'mutated-input';
    if (returned.action.type !== 'chat/turnStarted') {
      return;
    }
    expect(returned.action.prompt).toBe('prompt-1');
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.action)).toBe(true);
    expect(Object.isFrozen(replayed)).toBe(true);
  });

  it('replays mixed root, session, and chat resources through one buffer', () => {
    type AgentAction = RootAction | SessionAction | ChatAction;
    const buffer = new ReplayBuffer<AgentAction, AgentResource>({ maxActions: 3 });
    buffer.append(rootEnvelope(1));
    buffer.append(sessionEnvelope(2));
    buffer.append(envelope(3));

    expect(buffer.replayAfter(0, new Set<AgentResource>([rootChannel])).map((item) => item.serverSeq)).toEqual([1]);
    expect(buffer.replayAfter(0, new Set<AgentResource>([sessionChannel])).map((item) => item.serverSeq)).toEqual([2]);
    expect(buffer.replayAfter(0, new Set<AgentResource>([channelA])).map((item) => item.serverSeq)).toEqual([3]);
    expect(
      buffer.replayAfter(0, new Set<AgentResource>([rootChannel, channelA])).map((item) => item.serverSeq),
    ).toEqual([1, 3]);
  });
});

if (false) {
  const rootOnlyBuffer = new ReplayBuffer<RootAction, RootUri>({ maxActions: 1 });
  const chatEnvelope: ActionEnvelope<ChatAction, ChatUri> = envelope(1);
  // @ts-expect-error A root-only replay buffer must reject chat envelopes.
  rootOnlyBuffer.append(chatEnvelope);
}
