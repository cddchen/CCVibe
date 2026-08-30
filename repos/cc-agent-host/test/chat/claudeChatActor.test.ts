import { describe, expect, it } from 'vitest';

import {
  ClaudeChatActor,
  ClaudeRuntimeActionBridge,
  CommandDeduper,
  HostStateManager,
  SequencerByKey,
  createChatUri,
  createApprovalId,
  createClientId,
  createCommandId,
  createTurnId,
} from '../../src/index.js';
import type { ChatUri, TurnId } from '../../src/domain/ids.js';

const chat = createChatUri('session-actor', 'chat-actor');
const clientA = createClientId('actor-client-a');
const clientB = createClientId('actor-client-b');

class FakeRegistry {
  public readonly sendCalls: Array<{ readonly chatUri: ChatUri; readonly turnId: TurnId; readonly prompt: string }> = [];
  public readonly interruptCalls: TurnId[] = [];
  public sendError: unknown;
  public onInterrupt: ((turnId: TurnId) => void) | undefined;

  public send(chatUri: ChatUri, turnId: TurnId, prompt: string): Promise<unknown> {
    this.sendCalls.push({ chatUri, turnId, prompt });
    return this.sendError === undefined ? Promise.resolve({ turnId }) : Promise.reject(this.sendError);
  }

  public interrupt(_chatUri: ChatUri, turnId: TurnId): Promise<unknown | undefined> {
    this.interruptCalls.push(turnId);
    this.onInterrupt?.(turnId);
    return Promise.resolve({ still_queued: [] });
  }
}

function makeHarness(options: { readonly sendError?: unknown } = {}): {
  readonly host: HostStateManager;
  readonly registry: FakeRegistry;
  readonly actor: ClaudeChatActor;
} {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 32 });
  host.registerChat(chat);
  const registry = new FakeRegistry();
  registry.sendError = options.sendError;
  let turnNumber = 0;
  const actor = new ClaudeChatActor({
    hostStateManager: host,
    registry,
    sequencer: new SequencerByKey<ChatUri>(),
    commandDeduper: new CommandDeduper({ capacity: 32 }),
    nowAction: () => `action-${host.serverSeq + 1}`,
    allocateTurnId: () => createTurnId(`actor-turn-${turnNumber += 1}`),
  });
  return { host, registry, actor };
}

describe('ClaudeChatActor', () => {
  it('resolves SDK interactions through the shared command deduper', async () => {
    const { host } = makeHarness();
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('interaction-turn'),
      prompt: 'waiting',
      timestamp: 'turn-started',
    });
    let resolverCalls = 0;
    const interactionActor = new ClaudeChatActor({
      hostStateManager: host,
      registry: {
        send: async () => undefined,
        interrupt: async () => undefined,
      },
      sequencer: new SequencerByKey<ChatUri>(),
      commandDeduper: new CommandDeduper({ capacity: 32 }),
      nowAction: () => 'resolution-time',
      allocateTurnId: () => createTurnId('unused-turn'),
      interactionResolver: {
        resolveApproval: ({ approvalId }) => {
          resolverCalls += 1;
          return {
            status: resolverCalls === 1 ? 'resolved' : 'already_resolved',
            kind: 'approval',
            id: approvalId,
          };
        },
        resolveInput: ({ inputId }) => ({ status: 'already_resolved', kind: 'input', id: inputId }),
      },
    });
    const approvalId = createApprovalId('approval-actor');
    const commandId = createCommandId('resolve-actor');
    const first = await interactionActor.resolveApproval(
      clientA,
      1,
      commandId,
      chat,
      { approvalId, decision: 'allow' },
    );
    const retry = await interactionActor.resolveApproval(
      clientA,
      2,
      commandId,
      chat,
      { approvalId, decision: 'deny' },
    );

    expect(first).toEqual({
      status: 'accepted',
      value: { status: 'resolved', kind: 'approval', id: approvalId, acceptedAtSeq: 1 },
    });
    expect(retry).toBe(first);
    expect(resolverCalls).toBe(1);
  });

  it('accepts one turn with command origin, deduplicates retries, and coordinates two clients', async () => {
    const { actor, host, registry } = makeHarness();
    const first = await actor.dispatch(
      clientA,
      7,
      createCommandId('send-command'),
      chat,
      { type: 'chat/send', prompt: 'same prompt' },
    );

    expect(first).toEqual({
      status: 'accepted',
      value: { acceptedAtSeq: 1, turnId: createTurnId('actor-turn-1') },
    });
    expect(host.reconnect(0, new Set([chat]))).toMatchObject({
      type: 'replay',
      actions: [{
        serverSeq: 1,
        origin: { clientId: clientA, clientSeq: 7, commandId: createCommandId('send-command') },
      }],
    });
    expect(registry.sendCalls).toHaveLength(1);

    const retry = await actor.dispatch(
      clientA,
      99,
      createCommandId('send-command'),
      chat,
      { type: 'chat/send', prompt: 'must not run again' },
    );
    expect(retry).toBe(first);

    await expect(actor.dispatch(
      clientB,
      1,
      createCommandId('busy-command'),
      chat,
      { type: 'chat/send', prompt: 'busy' },
    )).resolves.toEqual({
      status: 'rejected',
      code: 'CHAT_BUSY',
      message: 'chat already has an active turn',
    });
    expect(host.serverSeq).toBe(1);
  });

  it('commits started and failed actions but keeps an installation failure accepted', async () => {
    const secret = new Error('secret installation detail');
    const { actor, host, registry } = makeHarness({ sendError: secret });

    const receipt = await actor.dispatch(
      clientA,
      1,
      createCommandId('failed-install'),
      chat,
      { type: 'chat/send', prompt: 'accept then fail' },
    );

    expect(receipt).toEqual({
      status: 'accepted',
      value: { acceptedAtSeq: 1, turnId: createTurnId('actor-turn-1') },
    });
    expect(registry.sendCalls).toHaveLength(1);
    expect(host.serverSeq).toBe(2);
    expect(host.getState(chat)?.turns).toEqual([
      expect.objectContaining({
        id: createTurnId('actor-turn-1'),
        status: 'failed',
        error: 'chat runtime failed',
      }),
    ]);
    expect(JSON.stringify(host.getState(chat))).not.toContain('secret installation detail');
  });

  it('interrupts directly and uses the bridge watermark without duplicating the terminal action', async () => {
    const { actor, host, registry } = makeHarness();
    const send = await actor.dispatch(
      clientA,
      1,
      createCommandId('send'),
      chat,
      { type: 'chat/send', prompt: 'interrupt me' },
    );
    if (send.status !== 'accepted' || send.value.turnId === undefined) {
      throw new Error('expected an accepted turn');
    }

    const bridge = new ClaudeRuntimeActionBridge({
      hostStateManager: host,
      nowAction: () => 'interrupt-time',
    });
    registry.onInterrupt = (turnId) => {
      bridge.handle(chat, {
        type: 'turn/result',
        generation: 1,
        turnId,
        outcome: { status: 'interrupted' },
      });
    };

    const interrupt = await actor.dispatch(
      clientB,
      2,
      createCommandId('interrupt'),
      chat,
      { type: 'chat/interrupt', turnId: send.value.turnId },
    );

    expect(interrupt).toEqual({ status: 'accepted', value: { acceptedAtSeq: 2 } });
    expect(registry.interruptCalls).toEqual([send.value.turnId]);
    expect(host.serverSeq).toBe(2);
    expect(host.getState(chat)?.turns).toEqual([
      expect.objectContaining({ id: send.value.turnId, status: 'interrupted' }),
    ]);
  });
});
