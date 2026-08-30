import { describe, expect, it } from 'vitest';

import {
  CATALOG_ACTION_TYPES,
  chatReducer,
  createChatState,
  createChatUri,
  createClientId,
  createCommandId,
  createPartId,
  createRootCatalogState,
  createRootUri,
  createSessionUri,
  createTurnId,
  HostStateManager,
  type ChatAction,
  type ChatActionEnvelope,
  type ChatUri,
} from '../../src/index.js';

const channelA = createChatUri('session-1', 'chat-a');
const channelB = createChatUri('session-1', 'chat-b');
const missingChannel = createChatUri('session-1', 'missing');

function turnStarted(turnName: string, timestamp = `${turnName}-action`): ChatAction {
  return {
    type: 'chat/turnStarted',
    turnId: createTurnId(turnName),
    prompt: `prompt-${turnName}`,
    timestamp,
  };
}

describe('HostStateManager', () => {
  it('publishes catalog state before root listeners and does not consume seq when clock fails', () => {
    const root = createRootUri();
    let shouldThrow = false;
    const manager = new HostStateManager({
      now: () => {
        if (shouldThrow) {
          throw new Error('clock unavailable');
        }
        return 'server-time';
      },
      replayCapacity: 4,
    });
    manager.registerCatalog(root, createRootCatalogState({
      resource: root,
      host: { id: 'host-a', displayName: 'Host A' },
      modifiedAt: 'catalog-0',
    }));
    let stateAtEmit: string | undefined;
    manager.subscribeAll((envelope) => {
      stateAtEmit = manager.getCatalogState(root)?.connection.status;
      expect(envelope.channel).toBe(root);
    });

    const first = manager.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.hostUpdated,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'degraded', displayStatus: 'degraded' },
      timestamp: 'catalog-1',
    });
    expect(first?.serverSeq).toBe(1);
    expect(stateAtEmit).toBe('degraded');

    shouldThrow = true;
    expect(() => manager.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.hostUpdated,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'disconnected', displayStatus: 'offline' },
      timestamp: 'catalog-2',
    })).toThrow('clock unavailable');
    expect(manager.serverSeq).toBe(1);
    expect(manager.getCatalogState(root)?.connection.status).toBe('degraded');
  });

  it('reduces before commit, assigns one global sequence, and skips reducer no-ops', () => {
    let nowCalls = 0;
    const emitted: number[] = [];
    const stateVisibleOnEmit: boolean[] = [];
    const manager = new HostStateManager(
      {
        now: () => {
          nowCalls += 1;
          return `server-time-${nowCalls}`;
        },
        replayCapacity: 10,
      },
      (envelope) => {
        emitted.push(envelope.serverSeq);
        stateVisibleOnEmit.push(manager.getState(envelope.channel)?.modifiedAt === envelope.action.timestamp);
      },
    );
    manager.registerChat(channelA);
    manager.registerChat(channelB);

    const first = manager.dispatch(channelA, turnStarted('turn-a'));
    const second = manager.dispatch(channelB, turnStarted('turn-b'));
    const noOp = manager.dispatch(channelA, {
      type: 'chat/responsePartDelta',
      turnId: createTurnId('turn-a'),
      partId: createPartId('unknown-part'),
      delta: 'ignored',
      timestamp: 'no-op-action',
    });

    expect(first?.serverSeq).toBe(1);
    expect(second?.serverSeq).toBe(2);
    expect(first?.serverTime).toBe('server-time-1');
    expect(second?.serverTime).toBe('server-time-2');
    expect(noOp).toBeUndefined();
    expect(manager.serverSeq).toBe(2);
    expect(nowCalls).toBe(2);
    expect(emitted).toEqual([1, 2]);
    expect(stateVisibleOnEmit).toEqual([true, true]);
    expect(manager.snapshot(channelA)?.state.activeTurn?.id).toBe(createTurnId('turn-a'));
  });

  it('bridges a same-cut snapshot to later actions without loss or duplication', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);
    manager.dispatch(channelA, turnStarted('turn-a'));
    const snapshot = manager.snapshot(channelA);
    expect(snapshot?.fromSeq).toBe(1);
    if (snapshot === undefined) {
      return;
    }

    const envelope = manager.dispatch(channelA, {
      type: 'chat/responsePartAdded',
      turnId: createTurnId('turn-a'),
      part: { kind: 'markdown', id: createPartId('part-a'), content: 'answer' },
      timestamp: 'part-added',
    });
    expect(envelope?.serverSeq).toBe(2);
    if (envelope === undefined) {
      return;
    }

    const clientState = chatReducer(snapshot.state, envelope.action);
    expect(clientState).toEqual(manager.snapshot(channelA)?.state);
  });

  it('does not expose mutable aliases from actions, state, or snapshots', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 3 });
    manager.registerChat(channelA, createChatState({ resource: channelA, modifiedAt: 'initial' }));

    const action = turnStarted('turn-a');
    const envelope = manager.dispatch(channelA, action);
    expect(envelope).toBeDefined();
    if (envelope === undefined) {
      return;
    }

    (action as unknown as { prompt: string }).prompt = 'mutated after dispatch';
    const snapshot = manager.snapshot(channelA);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }

    if (envelope.action.type !== 'chat/turnStarted') {
      return;
    }
    expect(envelope.action.prompt).toBe('prompt-turn-a');
    expect(snapshot.state.activeTurn?.prompt).toBe('prompt-turn-a');
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.action)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.state)).toBe(true);
    expect(Object.isFrozen(snapshot.state.activeTurn)).toBe(true);
    expect(Object.isFrozen(snapshot.state.activeTurn?.parts)).toBe(true);

    const replay = manager.reconnect(0, new Set([channelA]));
    expect(replay.type).toBe('replay');
    if (replay.type === 'replay') {
      expect(replay.actions[0]).toBe(envelope);
      expect(Object.isFrozen(replay)).toBe(true);
      expect(Object.isFrozen(replay.actions)).toBe(true);
      expect(Object.isFrozen(replay.missing)).toBe(true);
    }
  });

  it('replays covered global history while preserving filtered sequence gaps', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 5 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);
    manager.dispatch(channelA, turnStarted('turn-a'));
    manager.dispatch(channelB, turnStarted('turn-b'));
    manager.dispatch(channelA, {
      type: 'chat/responsePartAdded',
      turnId: createTurnId('turn-a'),
      part: { kind: 'markdown', id: createPartId('part-a'), content: '' },
      timestamp: 'part-added',
    });

    const result = manager.reconnect(0, new Set([channelA]));
    expect(result.type).toBe('replay');
    if (result.type !== 'replay') {
      return;
    }

    expect(result.actions.map((action) => action.serverSeq)).toEqual([1, 3]);
    expect(result.missing).toEqual([]);
  });

  it('snapshots a registered default chat with no action history on reconnect', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);

    const result = manager.reconnect(0, new Set([channelA]));

    expect(result.type).toBe('snapshot');
    if (result.type !== 'snapshot') {
      return;
    }
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.resource).toBe(channelA);
    expect(result.snapshots[0]?.fromSeq).toBe(0);
    expect(result.snapshots[0]?.state).toEqual(manager.getState(channelA));
    expect(result.missing).toEqual([]);
  });

  it('snapshots a registered non-default chat when another channel has replay history', () => {
    const initialState = createChatState({ resource: channelA, status: 'error', modifiedAt: 'initial' });
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA, initialState);
    manager.registerChat(channelB);
    manager.dispatch(channelB, turnStarted('turn-b'));

    const result = manager.reconnect(0, new Set([channelA, channelB]));

    expect(result.type).toBe('snapshot');
    if (result.type !== 'snapshot') {
      return;
    }
    expect(result.snapshots.map((snapshot) => snapshot.resource)).toEqual([channelA, channelB]);
    expect(result.snapshots.every((snapshot) => snapshot.fromSeq === 1)).toBe(true);
    expect(result.snapshots[0]?.state).toEqual(initialState);
    expect(result.snapshots[1]?.state.activeTurn?.id).toBe(createTurnId('turn-b'));
  });

  it('snapshots a newly registered no-action channel at the current cut', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);
    manager.dispatch(channelA, turnStarted('turn-a'));
    manager.registerChat(channelB, createChatState({ resource: channelB, modifiedAt: 'new-channel' }));

    const result = manager.reconnect(0, new Set([channelB]));

    expect(result.type).toBe('snapshot');
    if (result.type !== 'snapshot') {
      return;
    }
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.resource).toBe(channelB);
    expect(result.snapshots[0]?.fromSeq).toBe(1);
    expect(result.snapshots[0]?.state.modifiedAt).toBe('new-channel');
  });

  it('reports missing resources on the replay path too', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA);
    manager.dispatch(channelA, turnStarted('turn-a'));

    const result = manager.reconnect(0, new Set([channelA, missingChannel]));
    expect(result.type).toBe('replay');
    expect(result.missing).toEqual([missingChannel]);
  });

  it('falls back to same-cut snapshots and reports missing resources', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);
    manager.dispatch(channelA, turnStarted('turn-a'));
    manager.dispatch(channelB, turnStarted('turn-b'));
    manager.dispatch(channelA, {
      type: 'chat/responsePartAdded',
      turnId: createTurnId('turn-a'),
      part: { kind: 'markdown', id: createPartId('part-a'), content: 'answer' },
      timestamp: 'part-added',
    });

    const result = manager.reconnect(0, new Set([channelA, missingChannel]));
    expect(result.type).toBe('snapshot');
    if (result.type !== 'snapshot') {
      return;
    }

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.resource).toBe(channelA);
    expect(result.snapshots[0]?.fromSeq).toBe(3);
    expect(result.snapshots[0]?.state.activeTurn?.parts).toEqual([
      { kind: 'markdown', id: createPartId('part-a'), content: 'answer' },
    ]);
    expect(result.missing).toEqual([missingChannel]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshots)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
  });

  it('does not partially commit when the injected clock throws', () => {
    let shouldThrow = true;
    const manager = new HostStateManager({
      now: () => {
        if (shouldThrow) {
          throw new Error('clock unavailable');
        }
        return 'server-time';
      },
      replayCapacity: 2,
    });
    manager.registerChat(channelA);

    expect(() => manager.dispatch(channelA, turnStarted('turn-a'))).toThrow('clock unavailable');
    expect(manager.serverSeq).toBe(0);
    expect(manager.getState(channelA)?.activeTurn).toBeUndefined();

    shouldThrow = false;
    expect(manager.dispatch(channelA, turnStarted('turn-a'))?.serverSeq).toBe(1);
    const replay = manager.reconnect(0, new Set([channelA]));
    expect(replay.type).toBe('replay');
    if (replay.type === 'replay') {
      expect(replay.actions.map((action) => action.serverSeq)).toEqual([1]);
    }
  });

  it('queues reentrant dispatches until every listener receives the current envelope', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);
    const firstListener: number[] = [];
    const secondListener: number[] = [];

    manager.subscribe((envelope) => {
      firstListener.push(envelope.serverSeq);
      if (envelope.serverSeq === 1) {
        manager.dispatch(channelB, turnStarted('turn-b'));
      }
    });
    manager.subscribe((envelope) => secondListener.push(envelope.serverSeq));

    manager.dispatch(channelA, turnStarted('turn-a'));

    expect(firstListener).toEqual([1, 2]);
    expect(secondListener).toEqual([1, 2]);
  });

  it('rejects replacing a registered resource outside the action sequence', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA);

    expect(() => manager.registerChat(channelA)).toThrow('already registered');
  });

  it('normalizes an initial state without a resource to its registered channel', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA, createChatState({ modifiedAt: 'initial' }));

    expect(manager.snapshot(channelA)?.state.resource).toBe(channelA);
  });

  it('accepts the oldest-minus-one reconnect boundary', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);
    manager.dispatch(channelA, turnStarted('turn-a'));
    manager.dispatch(channelB, turnStarted('turn-b'));
    manager.dispatch(channelA, {
      type: 'chat/responsePartAdded',
      turnId: createTurnId('turn-a'),
      part: { kind: 'markdown', id: createPartId('part-a'), content: '' },
      timestamp: 'part-added',
    });

    const result = manager.reconnect(1, new Set([channelA]));
    expect(result.type).toBe('replay');
    if (result.type === 'replay') {
      expect(result.actions.map((action) => action.serverSeq)).toEqual([3]);
    }
  });

  it('rejects non-chat resources at runtime without changing the sequence', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    const rootAsChat = createRootUri() as unknown as ChatUri;
    const sessionAsChat = createSessionUri('session-1') as unknown as ChatUri;

    expect(() => manager.registerChat(rootAsChat)).toThrow(TypeError);
    expect(() => manager.registerChat(sessionAsChat)).toThrow(TypeError);
    expect(() => manager.getState(rootAsChat)).toThrow(TypeError);
    expect(() => manager.snapshot(sessionAsChat)).toThrow(TypeError);
    expect(() => manager.getSnapshot(rootAsChat)).toThrow(TypeError);
    expect(() => manager.dispatch(rootAsChat, turnStarted('turn-root'))).toThrow(TypeError);
    expect(() => manager.reconnect(0, new Set([sessionAsChat]))).toThrow(TypeError);
    expect(manager.serverSeq).toBe(0);
  });

  it('rejects non-chat action types without emitting or consuming a sequence', () => {
    const emitted: number[] = [];
    const manager = new HostStateManager(
      { now: () => 'server-time', replayCapacity: 2 },
      (envelope) => emitted.push(envelope.serverSeq),
    );
    manager.registerChat(channelA);
    const nonChatAction = { type: 'root/changed', timestamp: 'root-action' } as unknown as ChatAction;

    expect(() => manager.dispatch(channelA, nonChatAction)).toThrow(TypeError);
    expect(manager.serverSeq).toBe(0);
    expect(emitted).toEqual([]);
    const reconnect = manager.reconnect(0, new Set([channelA]));
    expect(reconnect.type).toBe('snapshot');
    if (reconnect.type === 'snapshot') {
      expect(reconnect.snapshots[0]?.fromSeq).toBe(0);
    }
  });

  it('omits an absent origin without weakening exact optional property semantics', () => {
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 2 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);

    const withoutOrigin = manager.dispatch(channelA, turnStarted('turn-a'));
    const withOrigin = manager.dispatch(channelB, turnStarted('turn-b'), {
      clientId: createClientId('client-1'),
      clientSeq: 1,
      commandId: createCommandId('command-1'),
    });

    expect(withoutOrigin).toBeDefined();
    expect(withOrigin).toBeDefined();
    if (withoutOrigin === undefined || withOrigin === undefined) {
      return;
    }
    expect('origin' in withoutOrigin).toBe(false);
    expect('origin' in withOrigin).toBe(true);
  });

  it('reports listener failures without rejecting the committed dispatch', () => {
    const firstError = new Error('first listener failed');
    const reported: unknown[] = [];
    const received: ChatActionEnvelope[] = [];
    const manager = new HostStateManager({
      now: () => 'server-time',
      replayCapacity: 2,
      onListenerError: (error) => reported.push(error),
    });
    manager.registerChat(channelA);
    manager.subscribe(() => {
      throw firstError;
    });
    manager.subscribe((envelope) => {
      received.push(envelope);
      expect(Object.isFrozen(envelope)).toBe(true);
    });

    const envelope = manager.dispatch(channelA, turnStarted('turn-a'));

    expect(envelope?.serverSeq).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(envelope);
    expect(reported).toEqual([firstError]);
    expect(manager.serverSeq).toBe(1);
    expect(manager.getState(channelA)?.activeTurn?.id).toBe(createTurnId('turn-a'));
  });

  it('reports async listener failures after synchronous fanout and swallows async reporter failures', async () => {
    const listenerError = new Error('async listener failed');
    const reported: unknown[] = [];
    const firstListener: number[] = [];
    const secondListener: number[] = [];
    const manager = new HostStateManager({
      now: () => 'server-time',
      replayCapacity: 4,
      onListenerError: async (error) => {
        reported.push(error);
        throw new Error('async reporter failed');
      },
    });
    manager.registerChat(channelA);
    manager.registerChat(channelB);
    manager.subscribe(async (envelope) => {
      firstListener.push(envelope.serverSeq);
      if (envelope.serverSeq === 1) {
        manager.dispatch(channelB, turnStarted('turn-b'));
        throw listenerError;
      }
    });
    manager.subscribe((envelope) => secondListener.push(envelope.serverSeq));

    const envelope = manager.dispatch(channelA, turnStarted('turn-a'));

    expect(envelope?.serverSeq).toBe(1);
    expect(firstListener).toEqual([1, 2]);
    expect(secondListener).toEqual([1, 2]);
    expect(reported).toEqual([]);
    expect(manager.serverSeq).toBe(2);

    await Promise.resolve();
    await Promise.resolve();
    expect(reported).toEqual([listenerError]);
  });

  it('does not report fulfilled async listeners', async () => {
    const reported: unknown[] = [];
    const manager = new HostStateManager({
      now: () => 'server-time',
      replayCapacity: 2,
      onListenerError: (error) => reported.push(error),
    });
    manager.registerChat(channelA);
    manager.subscribe(async () => undefined);

    expect(manager.dispatch(channelA, turnStarted('turn-a'))?.serverSeq).toBe(1);
    await Promise.resolve();

    expect(reported).toEqual([]);
  });

  it('swallows reporter failures and isolates multiple listener failures', () => {
    const firstError = new Error('first listener failed');
    const secondError = new Error('second listener failed');
    const reported: unknown[] = [];
    const received: number[] = [];
    const manager = new HostStateManager({
      now: () => 'server-time',
      replayCapacity: 2,
      onListenerError: (error) => {
        reported.push(error);
        throw new Error('reporter failed');
      },
    });
    manager.registerChat(channelA);
    manager.subscribe(() => {
      throw firstError;
    });
    manager.subscribe(() => {
      throw secondError;
    });
    manager.subscribe((envelope) => received.push(envelope.serverSeq));

    const envelope = manager.dispatch(channelA, turnStarted('turn-a'));

    expect(envelope?.serverSeq).toBe(1);
    expect(received).toEqual([1]);
    expect(reported).toEqual([firstError, secondError]);
    expect(manager.serverSeq).toBe(1);
    const replay = manager.reconnect(0, new Set([channelA]));
    expect(replay.type).toBe('replay');
    if (replay.type === 'replay') {
      expect(replay.actions.map((action) => action.serverSeq)).toEqual([1]);
    }
  });

  it('continues queued reentrant dispatches after a throwing listener', () => {
    const firstListener: number[] = [];
    const secondListener: number[] = [];
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);

    manager.subscribe((envelope) => {
      firstListener.push(envelope.serverSeq);
      if (envelope.serverSeq === 1) {
        manager.dispatch(channelB, turnStarted('turn-b'));
        throw new Error('listener failed after reentrant dispatch');
      }
    });
    manager.subscribe((envelope) => secondListener.push(envelope.serverSeq));

    const envelope = manager.dispatch(channelA, turnStarted('turn-a'));

    expect(envelope?.serverSeq).toBe(1);
    expect(firstListener).toEqual([1, 2]);
    expect(secondListener).toEqual([1, 2]);
    expect(manager.serverSeq).toBe(2);
  });

  it('uses a listener snapshot for unsubscribe and subscribe during fanout', () => {
    const receivedByA: number[] = [];
    const receivedByB: number[] = [];
    const receivedByC: number[] = [];
    const manager = new HostStateManager({ now: () => 'server-time', replayCapacity: 4 });
    manager.registerChat(channelA);
    manager.registerChat(channelB);

    let unsubscribeB: (() => void) | undefined;
    manager.subscribe((envelope) => {
      receivedByA.push(envelope.serverSeq);
      if (envelope.serverSeq === 1) {
        unsubscribeB?.();
        manager.subscribe((next) => receivedByC.push(next.serverSeq));
        manager.dispatch(channelB, turnStarted('turn-b'));
      }
    });
    unsubscribeB = manager.subscribe((envelope) => receivedByB.push(envelope.serverSeq));

    manager.dispatch(channelA, turnStarted('turn-a'));

    expect(receivedByA).toEqual([1, 2]);
    expect(receivedByB).toEqual([1]);
    expect(receivedByC).toEqual([2]);
  });
});
