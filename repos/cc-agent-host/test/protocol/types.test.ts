import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createChatUri,
  createClientId,
  createCommandId,
  createRootUri,
  createSessionUri,
  createTurnId,
  type ActionEnvelope,
  type AgentResource,
  type ChatActionEnvelope,
  type ChatStateSnapshot,
  type ChatUri,
  type RootUri,
  type SessionUri,
  type StateSnapshot,
} from '../../src/index.js';

type RootAction = {
  readonly type: 'root/changed';
  readonly value: string;
};

type SessionAction = {
  readonly type: 'session/changed';
  readonly value: string;
};

type RootState = {
  readonly revision: number;
};

type SessionState = {
  readonly revision: number;
};

const rootUri = createRootUri();
const sessionUri = createSessionUri('session-1');
const chatUri = createChatUri('session-1', 'chat-1');

const rootEnvelope: ActionEnvelope<RootAction, RootUri> = {
  channel: rootUri,
  action: { type: 'root/changed', value: 'root-value' },
  serverSeq: 1,
  serverTime: 'server-1',
};

const sessionEnvelope: ActionEnvelope<SessionAction, SessionUri> = {
  channel: sessionUri,
  action: { type: 'session/changed', value: 'session-value' },
  serverSeq: 2,
  serverTime: 'server-2',
};

const chatEnvelope: ActionEnvelope = {
  channel: chatUri,
  action: {
    type: 'chat/turnStarted',
    turnId: createTurnId('turn-1'),
    prompt: 'prompt',
    timestamp: 'action-1',
  },
  serverSeq: 3,
  serverTime: 'server-3',
};

const rootSnapshot: StateSnapshot<RootState, RootUri> = {
  resource: rootUri,
  state: { revision: 1 },
  fromSeq: 1,
};

const sessionSnapshot: StateSnapshot<SessionState, SessionUri> = {
  resource: sessionUri,
  state: { revision: 2 },
  fromSeq: 2,
};

const chatSnapshot: ChatStateSnapshot = {
  resource: chatUri,
  state: {
    status: 'idle',
    turns: [],
    pendingApprovals: [],
    modifiedAt: '',
  },
  fromSeq: 3,
};

const chatCompatibleEnvelope: ActionEnvelope = chatEnvelope;

expectTypeOf<ActionEnvelope<RootAction, RootUri>['channel']>().toEqualTypeOf<RootUri>();
expectTypeOf<ActionEnvelope<SessionAction, SessionUri>['channel']>().toEqualTypeOf<SessionUri>();
expectTypeOf<ActionEnvelope['channel']>().toEqualTypeOf<AgentResource>();
expectTypeOf<ChatActionEnvelope['channel']>().toEqualTypeOf<ChatUri>();
expectTypeOf<ChatStateSnapshot['resource']>().toEqualTypeOf<ChatUri>();
expectTypeOf(rootSnapshot.resource).toEqualTypeOf<RootUri>();
expectTypeOf(sessionSnapshot.resource).toEqualTypeOf<SessionUri>();
expectTypeOf(chatSnapshot.resource).toEqualTypeOf<ChatUri>();
expectTypeOf(chatCompatibleEnvelope.channel).toEqualTypeOf<AgentResource>();

describe('protocol resource-generic types', () => {
  it('represents root, session, and chat values without duplicate envelopes', () => {
    expect(rootEnvelope.channel).toBe(rootUri);
    expect(sessionEnvelope.channel).toBe(sessionUri);
    expect(chatEnvelope.channel).toBe(chatUri);
    expect(rootSnapshot.resource).toBe(rootUri);
    expect(sessionSnapshot.resource).toBe(sessionUri);
    expect(chatSnapshot.resource).toBe(chatUri);
  });

  it('omits origin when absent and preserves it when provided', () => {
    expect('origin' in rootEnvelope).toBe(false);
    expect('origin' in sessionEnvelope).toBe(false);
    expect('origin' in chatEnvelope).toBe(false);

    const withOrigin: ActionEnvelope = {
      ...chatEnvelope,
      origin: {
        clientId: createClientId('client-1'),
        clientSeq: 1,
        commandId: createCommandId('command-1'),
      },
    };
    expect('origin' in withOrigin).toBe(true);
  });
});
