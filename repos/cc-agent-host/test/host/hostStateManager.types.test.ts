import { describe, expectTypeOf, it } from 'vitest';

import {
  createChatUri,
  createRootUri,
  createSessionUri,
  createTurnId,
  HostStateManager,
  type ChatAction,
  type ChatActionEnvelope,
  type ChatState,
  type ChatStateSnapshot,
  type RootUri,
  type SessionUri,
} from '../../src/index.js';

const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
const chatUri = createChatUri('session-1', 'chat-1');
const rootUri = createRootUri();
const sessionUri = createSessionUri('session-1');
const chatAction: ChatAction = {
  type: 'chat/turnStarted',
  turnId: createTurnId('turn-1'),
  prompt: 'prompt',
  timestamp: 'action-1',
};

expectTypeOf(manager.getState(chatUri)).toEqualTypeOf<ChatState | undefined>();
expectTypeOf(manager.snapshot(chatUri)).toEqualTypeOf<ChatStateSnapshot | undefined>();
expectTypeOf<ReturnType<HostStateManager['dispatch']>>().toEqualTypeOf<ChatActionEnvelope | undefined>();

describe('HostStateManager type surface', () => {
  it('keeps host methods chat-only at compile time', () => {
    expectTypeOf(manager.getState(chatUri)).toEqualTypeOf<ChatState | undefined>();
    expectTypeOf(manager.snapshot(chatUri)).toEqualTypeOf<ChatStateSnapshot | undefined>();
    expectTypeOf<ReturnType<HostStateManager['dispatch']>>().toEqualTypeOf<ChatActionEnvelope | undefined>();
  });

  if (false) {
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.registerChat(rootUri);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.registerChat(sessionUri);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.getState(rootUri);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.snapshot(sessionUri);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.getSnapshot(rootUri);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.dispatch(rootUri, chatAction);
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.dispatch(chatUri, { type: 'root/changed', timestamp: 'action-2' });
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.reconnect(0, new Set<RootUri>([rootUri]));
    // @ts-expect-error HostStateManager is intentionally narrowed to chat resources.
    manager.reconnect(0, new Set<SessionUri>([sessionUri]));
  }
});
