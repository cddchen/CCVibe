import { describe, expect, it } from 'vitest';

import {
  createChatUri,
  createClientId,
  createConnectionId,
  createRootUri,
  createSessionUri,
  LogicalClientRegistry,
} from '../../src/index.js';

const clientId = createClientId('client-1');
const connectionA = createConnectionId('connection-a');
const connectionB = createConnectionId('connection-b');
const chat = createChatUri('session-1', 'chat-1');
const session = createSessionUri('session-1');
const root = createRootUri();

describe('LogicalClientRegistry', () => {
  it('separates stable logical identity from replacement connection identity', () => {
    const registry = new LogicalClientRegistry();
    const initial = registry.register({
      clientId,
      connectionId: connectionA,
      capabilities: { partialBlocks: true, approvalEdits: false },
      subscriptions: [chat],
    });

    expect(initial.replacedConnectionId).toBeUndefined();
    expect(initial.client.clientId).toBe(clientId);
    expect(initial.client.activeConnectionId).toBe(connectionA);
    expect(initial.client.subscriptions).toEqual([chat]);

    const replacement = registry.replace({
      clientId,
      connectionId: connectionB,
      capabilities: { partialBlocks: false, approvalEdits: true },
    });

    expect(replacement.replacedConnectionId).toBe(connectionA);
    expect(registry.isActive(clientId, connectionA)).toBe(false);
    expect(registry.fence(clientId, connectionA)).toBe(false);
    expect(registry.isFenced(connectionA)).toBe(true);
    expect(registry.isActive(clientId, connectionB)).toBe(true);
    expect(() => registry.register(clientId, connectionA)).toThrow('fenced');
    expect(replacement.client.subscriptions).toEqual([chat]);
    expect(replacement.client.capabilities).toEqual({ partialBlocks: false, approvalEdits: true });
  });

  it('makes stale close callbacks harmless and retains the process-lifetime logical record', () => {
    const registry = new LogicalClientRegistry();
    registry.register(clientId, connectionA);
    registry.replace(clientId, connectionB);

    expect(registry.close(connectionA)).toBe(false);
    expect(registry.isActive(clientId, connectionB)).toBe(true);
    expect(registry.close(clientId, connectionB)).toBe(true);
    expect(registry.isActive(clientId, connectionB)).toBe(false);
    expect(registry.snapshot(clientId)?.activeConnectionId).toBeUndefined();
    expect(registry.cacheLifetime).toBe('process');
    expect(registry.size).toBe(1);
  });

  it('fences transport-bound mutations while allowing logical-only subscription updates', () => {
    const registry = new LogicalClientRegistry();
    registry.register(clientId, connectionA);

    registry.replaceSubscriptions(clientId, connectionA, [chat, session, chat]);
    expect(registry.getSubscriptions(clientId)).toEqual([chat, session]);
    expect(registry.addSubscription(clientId, connectionA, root)).toBe(true);
    expect(registry.addSubscription(clientId, connectionA, root)).toBe(false);
    expect(registry.removeSubscription(clientId, connectionA, session)).toBe(true);
    expect(registry.getSubscriptions(clientId)).toEqual([chat, root]);

    registry.replace(clientId, connectionB);
    expect(() => registry.addSubscription(clientId, connectionA, session)).toThrow('fenced');
    expect(() => registry.recordClientSeq(clientId, connectionA, 4)).toThrow('fenced');
  });

  it('records only the maximum client sequence while command identity remains separate', () => {
    const registry = new LogicalClientRegistry();
    registry.register(clientId, connectionA);

    expect(registry.recordClientSeq(clientId, connectionA, 4)).toBe(4);
    expect(registry.recordClientSeq(clientId, connectionA, 2)).toBe(4);
    expect(registry.acceptClientSeq(clientId, connectionA, 7)).toBe(true);
    expect(registry.acceptClientSeq(clientId, connectionA, 3)).toBe(false);
    expect(registry.getMaxAcceptedClientSeq(clientId)).toBe(7);
    registry.close(connectionA);
    expect(registry.recordProcessedClientSeq(clientId, 9)).toBe(9);
    expect(registry.snapshot(clientId)?.maxAcceptedClientSeq).toBe(9);
    expect(() => registry.recordClientSeq(clientId, connectionA, 0)).toThrow();
    expect(() => registry.recordProcessedClientSeq(clientId, 0)).toThrow(RangeError);
  });

  it('returns defensive readonly snapshots without exposing registry collections', () => {
    const capabilities = { partialBlocks: true, approvalEdits: false };
    const registry = new LogicalClientRegistry();
    registry.register({ clientId, connectionId: connectionA, capabilities, subscriptions: [chat] });
    capabilities.partialBlocks = false;

    const first = registry.snapshot(clientId);
    const second = registry.snapshot(clientId);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }

    expect(first).not.toBe(second);
    expect(first).not.toBe(registry.get(clientId));
    expect(first.capabilities).toEqual({ partialBlocks: true, approvalEdits: false });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.subscriptions)).toBe(true);
    expect(Object.isFrozen(first.capabilities)).toBe(true);
    expect(Object.isFrozen(registry.snapshots())).toBe(true);
  });
});
