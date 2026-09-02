import { describe, expect, it, vi } from 'vitest';

import {
  CATALOG_ACTION_TYPES,
  ChatHostStateProvider,
  ClaudeChatActor,
  CommandDeduper,
  createModel,
  createModelId,
  createChatUri,
  createClientId,
  createCommandId,
  createConnectionId,
  createRootCatalogState,
  createRootUri,
  createTurnId,
  createWorkspace,
  createWorkspaceId,
  createAccessControlList,
  createPrincipal,
  FakeChatActor,
  HostStateManager,
  HostStateProvider,
  LogicalClientRegistry,
  MAX_HOST_EPOCH_BYTES,
  MAX_PROTOCOL_VERSION_BYTES,
  MAX_PROTOCOL_VERSIONS,
  ProtocolServerHandler,
  SequencerByKey,
  WorkspaceResolverError,
  type AgentResource,
  type AccessControlList,
  type CatalogChatCreator,
  type ChatCommandActor,
  type Principal,
  type ProtocolConnection,
} from '../../src/index.js';
const chat = createChatUri('session-1', 'chat-1');
const otherChat = createChatUri('session-1', 'chat-2');
const missingChat = createChatUri('session-1', 'missing');
const root = createRootUri();
const clientA = createClientId('client-a');
const clientB = createClientId('client-b');

let nextConnectionId = 0;

class MemoryConnection implements ProtocolConnection {
  public readonly id = createConnectionId(`connection-${nextConnectionId += 1}`);
  public readonly sent: string[] = [];
  public readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  public failSends = false;
  public blocked = false;
  private pendingSends: Array<() => void> = [];

  public get bufferedAmount(): number {
    return 0;
  }

  public send(text: string): void | Promise<void> {
    if (this.failSends) {
      throw new Error('send failed');
    }
    if (!this.blocked) {
      this.sent.push(text);
      return;
    }
    return new Promise<void>((resolve) => {
      this.pendingSends.push(() => {
        this.sent.push(text);
        resolve();
      });
    });
  }

  public close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  public releaseSends(): void {
    this.blocked = false;
    const pending = this.pendingSends.splice(0);
    for (const release of pending) {
      release();
    }
  }

  public messages(): readonly Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  public lastResponse(): Record<string, unknown> {
    const response = [...this.messages()].reverse().find((message) => 'id' in message);
    if (response === undefined) {
      throw new Error('no response');
    }
    return response;
  }
}

class AuthenticatedConnection extends MemoryConnection {
  public readonly authentication: {
    readonly authenticated: true;
    readonly principal: Principal;
    readonly scheme: 'Bearer';
  };

  public constructor(principal: Principal) {
    super();
    this.authentication = { authenticated: true, principal, scheme: 'Bearer' };
  }
}

function request(id: string, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function initializeParams(clientId: typeof clientA, initialSubscriptions: readonly unknown[] = [chat]): Record<string, unknown> {
  return {
    channel: root,
    protocolVersions: ['9.0.0', '1.0.0'],
    clientId,
    clientInfo: { name: 'test', version: '1', platform: 'test' },
    capabilities: { partialBlocks: true, approvalEdits: false },
    initialSubscriptions,
  };
}

function createHarness(
  replayCapacity = 8,
  options: {
    readonly hostEpoch?: string;
    readonly protocolVersions?: readonly string[];
    readonly supportedResources?: ReadonlySet<AgentResource>;
    readonly acl?: AccessControlList;
    readonly principal?: Principal;
    readonly requireAuthorization?: boolean;
    readonly supportedCommandsProvider?: (channel: ReturnType<typeof createChatUri>) => Promise<readonly {
      readonly name: string;
      readonly description: string;
      readonly argumentHint: string;
      readonly aliases?: readonly string[];
    }[]>;
  } = {},
): {
  readonly host: HostStateManager;
  readonly handler: ProtocolServerHandler;
  readonly registry: LogicalClientRegistry;
  readonly provider: ChatHostStateProvider;
  readonly actor: FakeChatActor;
} {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity });
  host.registerChat(chat);
  host.registerChat(otherChat);
  const provider = new ChatHostStateProvider(host, 'epoch-1');
  const registry = new LogicalClientRegistry();
  let turnNumber = 0;
  const actor = new FakeChatActor({
    hostStateManager: host,
    sequencer: new SequencerByKey(),
    commandDeduper: new CommandDeduper({ capacity: 64 }),
    nowAction: () => `action-${host.serverSeq + 1}`,
    allocateTurnId: () => {
      turnNumber += 1;
      return createTurnId(`turn-${turnNumber}`);
    },
  });
  const handler = new ProtocolServerHandler({
    hostEpoch: options.hostEpoch ?? 'epoch-1',
    ...(options.protocolVersions === undefined ? {} : { protocolVersions: options.protocolVersions }),
    stateProvider: provider,
    clientRegistry: registry,
    chatActor: actor,
    ...(options.supportedCommandsProvider === undefined ? {} : { supportedCommandsProvider: options.supportedCommandsProvider }),
    ...(options.supportedResources === undefined ? {} : { supportedResources: options.supportedResources }),
    ...(options.acl === undefined ? {} : { acl: options.acl }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.requireAuthorization === undefined ? {} : { requireAuthorization: options.requireAuthorization }),
  });
  return { host, handler, registry, provider, actor };
}

function createRootHarness(): {
  readonly host: HostStateManager;
  readonly handler: ProtocolServerHandler;
} {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 8 });
  host.registerCatalog(root, createRootCatalogState({
    resource: root,
    host: { id: 'host-a', displayName: 'Host A' },
    modifiedAt: 'catalog-0',
  }));
  const provider = new HostStateProvider(host, 'epoch-1');
  const registry = new LogicalClientRegistry();
  const actor = new FakeChatActor({
    hostStateManager: host,
    sequencer: new SequencerByKey(),
    commandDeduper: new CommandDeduper({ capacity: 64 }),
    nowAction: () => `action-${host.serverSeq + 1}`,
    allocateTurnId: () => createTurnId('root-test-turn'),
  });
  const handler = new ProtocolServerHandler({
    hostEpoch: 'epoch-1',
    stateProvider: provider,
    clientRegistry: registry,
    chatActor: actor,
  });
  return { host, handler };
}

async function initialize(
  handler: ProtocolServerHandler,
  connection: MemoryConnection,
  clientId: typeof clientA = clientA,
  subscriptions: readonly unknown[] = [chat],
): Promise<Record<string, unknown>> {
  await handler.handle(connection, request('initialize', 'initialize', initializeParams(clientId, subscriptions)));
  return connection.lastResponse();
}

function actionMessage(connection: MemoryConnection): Record<string, unknown> | undefined {
  return connection.messages().find((message) => message.method === 'state/action');
}

describe('ProtocolServerHandler', () => {
  it('returns the subscribed chat slash commands from the Host provider', async () => {
    const { handler } = createHarness(8, {
      supportedCommandsProvider: async (channel) => {
        expect(channel).toBe(chat);
        return [{ name: 'animate', description: 'Add motion', argumentHint: '<target>', aliases: ['motion'] }];
      },
    });
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, [chat]);

    await handler.handle(connection, request('commands', 'chat/supportedCommands', { channel: chat }));

    expect(connection.lastResponse()).toEqual({
      jsonrpc: '2.0',
      id: 'commands',
      result: { commands: [{ name: 'animate', description: 'Add motion', argumentHint: '<target>', aliases: ['motion'] }] },
    });
  });

  it('routes catalog/createChat and publishes the accepted chat to root subscribers', async () => {
    const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 8 });
    host.registerCatalog(root, createRootCatalogState({
      resource: root,
      host: { id: 'host-a', displayName: 'Host A' },
      workspaces: [createWorkspace({
        id: createWorkspaceId('workspace-a'),
        path: '/tmp/workspace-a',
        displayName: 'Workspace A',
      })],
      models: [createModel({ id: createModelId('model-a'), displayName: 'Model A' })],
      modifiedAt: 'catalog-0',
    }));
    const provider = new HostStateProvider(host, 'epoch-1');
    const registry = new LogicalClientRegistry();
    const actor = new FakeChatActor({
      hostStateManager: host,
      sequencer: new SequencerByKey(),
      commandDeduper: new CommandDeduper({ capacity: 8 }),
      nowAction: () => 'action-time',
      allocateTurnId: () => createTurnId('unused-create-turn'),
    });
    const createdChat = createChatUri('workspace-a', 'created-chat');
    const creator: CatalogChatCreator = {
      createChat: async () => ({
        status: 'accepted',
        value: { chatUri: createdChat },
      }),
    };
    const handler = new ProtocolServerHandler({
      hostEpoch: 'epoch-1',
      stateProvider: provider,
      clientRegistry: registry,
      chatActor: actor,
      catalogChatCreator: creator,
    });
    const connection = new MemoryConnection();

    await initialize(handler, connection, clientA, [root]);
    connection.sent.length = 0;
    await handler.handle(connection, request('create', 'catalog/createChat', {
      channel: root,
      workspaceId: createWorkspaceId('workspace-a'),
      modelId: createModelId('model-a'),
      clientSeq: 1,
      commandId: createCommandId('create-chat-1'),
    }));

    expect(connection.lastResponse()).toMatchObject({
      id: 'create',
      result: { receipt: { status: 'accepted', value: { chatUri: createdChat } } },
    });
  });

  it('resolves a workspace through the injected host resolver and returns its catalog projection', async () => {
    const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 8 });
    host.registerCatalog(root, createRootCatalogState({
      resource: root,
      host: { id: 'host-a', displayName: 'Host A' },
      modifiedAt: 'catalog-0',
    }));
    const provider = new HostStateProvider(host, 'epoch-1');
    const registry = new LogicalClientRegistry();
    const actor = new FakeChatActor({
      hostStateManager: host,
      sequencer: new SequencerByKey(),
      commandDeduper: new CommandDeduper({ capacity: 8 }),
      nowAction: () => 'action-time',
      allocateTurnId: () => createTurnId('unused-resolve-turn'),
    });
    const workspace = createWorkspace({
      id: createWorkspaceId('workspace-resolved'),
      path: '/tmp/resolved-workspace',
      displayName: 'Resolved Workspace',
    });
    const handler = new ProtocolServerHandler({
      hostEpoch: 'epoch-1',
      stateProvider: provider,
      clientRegistry: registry,
      chatActor: actor,
      workspaceResolver: async (channel, path) => {
        expect(channel).toBe(root);
        expect(path).toBe('/tmp/input-workspace');
        host.dispatchCatalog(channel, {
          type: CATALOG_ACTION_TYPES.workspaceUpserted,
          workspace,
          timestamp: 'catalog-workspace',
        });
        return workspace;
      },
    });
    const connection = new MemoryConnection();

    await initialize(handler, connection, clientA, [root]);
    connection.sent.length = 0;
    await handler.handle(connection, request('resolve', 'catalog/resolveWorkspace', {
      channel: root,
      path: '/tmp/input-workspace',
    }));

    expect(connection.lastResponse()).toEqual({
      jsonrpc: '2.0',
      id: 'resolve',
      result: { workspace },
    });
    expect(host.getCatalogState(root)?.workspaces).toEqual([workspace]);
    expect(actionMessage(connection)).toMatchObject({
      params: { action: { type: 'catalog/workspaceUpserted', workspace } },
    });
  });

  it('exposes stable workspace resolver failures without leaking filesystem details', async () => {
    const { host } = createRootHarness();
    const provider = new HostStateProvider(host, 'epoch-1');
    const registry = new LogicalClientRegistry();
    const actor = new FakeChatActor({
      hostStateManager: host,
      sequencer: new SequencerByKey(),
      commandDeduper: new CommandDeduper({ capacity: 8 }),
      nowAction: () => 'action-time',
      allocateTurnId: () => createTurnId('unused-error-turn'),
    });
    const secret = '/private/secret/path';
    const handler = new ProtocolServerHandler({
      hostEpoch: 'epoch-1',
      stateProvider: provider,
      clientRegistry: registry,
      chatActor: actor,
      workspaceResolver: async () => {
        throw new WorkspaceResolverError('WORKSPACE_NOT_FOUND');
      },
    });
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, [root]);
    await handler.handle(connection, request('resolve-error', 'catalog/resolveWorkspace', {
      channel: root,
      path: secret,
    }));

    const response = connection.lastResponse();
    expect(response.error).toEqual({ code: -32004, message: 'Resource not found', data: { code: 'WORKSPACE_NOT_FOUND' } });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('returns a stable workspace path code for protocol-level absolute-path violations', async () => {
    const { handler } = createRootHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, [root]);

    await handler.handle(connection, request('resolve-invalid', 'catalog/resolveWorkspace', {
      channel: root,
      path: 'relative/path',
    }));

    expect(connection.lastResponse().error).toEqual({
      code: -32602,
      message: 'Invalid params',
      data: { code: 'WORKSPACE_PATH_INVALID' },
    });
  });

  it('returns root snapshots through initialize and subscribe', async () => {
    const { handler, host } = createRootHarness();
    const connection = new MemoryConnection();

    const initialized = await initialize(handler, connection, clientA, [root]);
    expect(initialized.result).toMatchObject({
      snapshots: [{ resource: root, fromSeq: 0, state: { host: { id: 'host-a' } } }],
      missing: [],
    });

    await handler.handle(connection, request('root-unsubscribe', 'unsubscribe', { channel: root }));

    await handler.handle(connection, request('root-subscribe', 'subscribe', { channel: root }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'root-subscribe',
      result: {
        snapshot: {
          resource: root,
          fromSeq: 0,
          state: { host: { id: 'host-a', displayName: 'Host A' } },
        },
      },
    });
    expect(JSON.stringify(connection.lastResponse())).not.toContain('missing');

    connection.sent.length = 0;
    host.dispatchCatalog(root, {
      type: CATALOG_ACTION_TYPES.hostUpdated,
      host: { id: 'host-a', displayName: 'Host A' },
      connection: { status: 'degraded', displayStatus: 'degraded' },
      timestamp: 'catalog-1',
    });
    await Promise.resolve();
    expect(actionMessage(connection)).toMatchObject({
      method: 'state/action',
      params: { channel: root, serverSeq: 1 },
    });
  });

  it('enforces initialize and validates method/params without leaking input', async () => {
    const { handler } = createHarness();
    const connection = new MemoryConnection();

    await handler.handle(connection, request('1', 'subscribe', { channel: chat }));
    expect(connection.lastResponse().error).toMatchObject({ code: -32001 });

    await handler.handle(connection, request('2', 'unknown/method', {}));
    expect(connection.lastResponse().error).toMatchObject({ code: -32601 });

    const secret = 'very-secret-prompt';
    await handler.handle(connection, request('3', 'initialize', {
      ...initializeParams(clientA),
      initialSubscriptions: [secret],
    }));
    const invalid = connection.lastResponse();
    expect(invalid.error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(invalid)).not.toContain(secret);
  });

  it('negotiates server preference and makes initialization idempotence explicit', async () => {
    const { handler } = createHarness();
    const connection = new MemoryConnection();
    const initialized = await initialize(handler, connection);
    expect(initialized.result).toMatchObject({ protocolVersion: '1.0.0', hostEpoch: 'epoch-1' });

    await handler.handle(connection, request('2', 'initialize', initializeParams(clientA)));
    expect(connection.lastResponse().error).toMatchObject({ code: -32600 });

    const unsupported = new MemoryConnection();
    await handler.handle(unsupported, request('unsupported', 'initialize', {
      ...initializeParams(clientB),
      protocolVersions: ['9.0.0'],
    }));
    expect(unsupported.lastResponse().error).toMatchObject({ code: -32002 });
  });

  it('validates handler epoch bytes and configured protocol versions', () => {
    expect(() => createHarness(8, { hostEpoch: 'é'.repeat(Math.floor(MAX_HOST_EPOCH_BYTES / 2)) })).not.toThrow();
    expect(() => createHarness(8, { hostEpoch: '😀'.repeat(Math.floor(MAX_HOST_EPOCH_BYTES / 4) + 1) })).toThrow(RangeError);
    expect(() => createHarness(8, { hostEpoch: '' })).toThrow(TypeError);
    expect(() => createHarness(8, { protocolVersions: [] })).toThrow(RangeError);
    expect(() => createHarness(8, {
      protocolVersions: null as unknown as readonly string[],
    })).toThrow(TypeError);
    expect(() => createHarness(8, { protocolVersions: ['2.0.0'] })).toThrow(RangeError);
    expect(() => createHarness(8, { protocolVersions: ['x'.repeat(MAX_PROTOCOL_VERSION_BYTES + 1)] })).toThrow(RangeError);
    expect(() => createHarness(8, {
      protocolVersions: Array.from({ length: MAX_PROTOCOL_VERSIONS + 1 }, () => '1.0.0'),
    })).toThrow(RangeError);
    expect(() => createHarness(8, { protocolVersions: [1 as unknown as string] })).toThrow(TypeError);
    expect(() => createHarness(8, { protocolVersions: ['1.0.0'] })).not.toThrow();
  });

  it('returns missing resources instead of fabricating root/session/chat state', async () => {
    const { handler, registry } = createHarness();
    const connection = new MemoryConnection();
    const response = await initialize(handler, connection, clientA, [chat, root, missingChat, chat]);
    expect(response.result).toMatchObject({ missing: [root, missingChat] });
    expect((response.result as { snapshots: readonly unknown[] }).snapshots).toHaveLength(1);
    expect(registry.getSubscriptions(clientA)).toEqual([chat]);

    await handler.handle(connection, request('subscribe-missing', 'subscribe', { channel: missingChat }));
    expect(connection.lastResponse().error).toMatchObject({ code: -32004 });
  });

  it('enforces supportedResources during initialize, subscribe, and dispatch', async () => {
    const { handler, registry } = createHarness(8, { supportedResources: new Set([chat]) });
    const connection = new MemoryConnection();
    const initialized = await initialize(handler, connection, clientA, [chat, otherChat]);
    expect(initialized.result).toMatchObject({ missing: [otherChat] });
    expect(registry.getSubscriptions(clientA)).toEqual([chat]);

    await handler.handle(connection, request('unsupported-subscribe', 'subscribe', { channel: otherChat }));
    expect(connection.lastResponse().error).toMatchObject({ code: -32004 });
    await handler.handle(connection, request('unsupported-dispatch', 'dispatchAction', {
      channel: otherChat,
      clientSeq: 1,
      commandId: createCommandId('unsupported-dispatch'),
      action: { type: 'chat/send', prompt: 'must not dispatch' },
    }));
    expect(connection.lastResponse().error).toMatchObject({ code: -32004 });
    expect(registry.getSubscriptions(clientA)).toEqual([chat]);

    const seededConnection = createConnectionId('seeded-unsupported-initialize');
    registry.register({ clientId: clientB, connectionId: seededConnection, subscriptions: [otherChat] });
    registry.close(seededConnection);
    const replacement = new MemoryConnection();
    const replacementResult = await initialize(handler, replacement, clientB, [otherChat]);
    expect(replacementResult.result).toMatchObject({ missing: [otherChat], snapshots: [] });
    expect(registry.getSubscriptions(clientB)).toEqual([]);
  });

  it('enforces supportedResources during reconnect and snapshot fallback', async () => {
    const { handler, registry } = createHarness(8, { supportedResources: new Set([chat]) });
    const seededConnection = createConnectionId('seeded-unsupported-client');
    registry.register({
      clientId: clientA,
      connectionId: seededConnection,
      subscriptions: [otherChat],
    });
    registry.close(seededConnection);

    const connection = new MemoryConnection();
    await handler.handle(connection, request('unsupported-reconnect', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [otherChat],
    }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'unsupported-reconnect',
      result: { type: 'replay', missing: [otherChat], actions: [] },
    });
    expect(registry.getSubscriptions(clientA)).toEqual([]);

    registry.replaceSubscriptions(clientA, connection.id, [otherChat]);
    await handler.handle(connection, request('unsupported-epoch-fallback', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'old-epoch',
      lastSeenServerSeq: 0,
      subscriptions: [otherChat],
    }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'unsupported-epoch-fallback',
      result: { type: 'snapshot', missing: [otherChat], snapshots: [] },
    });
    expect(registry.getSubscriptions(clientA)).toEqual([]);
  });

  it('fans out one committed action with the same origin to two clients', async () => {
    const { handler } = createHarness();
    const first = new MemoryConnection();
    const second = new MemoryConnection();
    await initialize(handler, first, clientA);
    await initialize(handler, second, clientB);
    first.sent.length = 0;
    second.sent.length = 0;

    await handler.handle(first, request('send', 'dispatchAction', {
      channel: chat,
      clientSeq: 7,
      commandId: createCommandId('command-1'),
      action: { type: 'chat/send', prompt: 'same prompt' },
    }));

    const firstAction = actionMessage(first);
    const secondAction = actionMessage(second);
    expect(firstAction).toBeDefined();
    expect(secondAction).toBeDefined();
    expect(firstAction?.params).toEqual(secondAction?.params);
    expect(firstAction?.params).toMatchObject({
      channel: chat,
      action: { type: 'chat/turnStarted', prompt: 'same prompt', turnId: createTurnId('turn-1') },
      serverSeq: 1,
      origin: { clientId: clientA, clientSeq: 7, commandId: createCommandId('command-1') },
    });
    expect(first.lastResponse().result).toEqual({
      receipt: { status: 'accepted', value: { acceptedAtSeq: 1, turnId: createTurnId('turn-1') } },
    });
  });

  it('accepts the SDK-free Claude actor through the same protocol handler contract', async () => {
    const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 8 });
    host.registerChat(chat);
    const provider = new ChatHostStateProvider(host, 'epoch-claude-actor');
    const logicalClients = new LogicalClientRegistry();
    const actor: ChatCommandActor = new ClaudeChatActor({
      hostStateManager: host,
      registry: {
        send: async () => ({ installed: true }),
        interrupt: async () => ({ still_queued: [] }),
      },
      sequencer: new SequencerByKey(),
      commandDeduper: new CommandDeduper({ capacity: 8 }),
      nowAction: () => 'actor-time',
      allocateTurnId: () => createTurnId('claude-actor-turn'),
    });
    const handler = new ProtocolServerHandler({
      hostEpoch: 'epoch-claude-actor',
      stateProvider: provider,
      clientRegistry: logicalClients,
      chatActor: actor,
    });
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA);
    connection.sent.length = 0;

    await handler.handle(connection, request('claude-send', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('claude-send-command'),
      action: { type: 'chat/send', prompt: 'through shared contract' },
    }));

    expect(connection.lastResponse().result).toEqual({
      receipt: {
        status: 'accepted',
        value: { acceptedAtSeq: 1, turnId: createTurnId('claude-actor-turn') },
      },
    });
    expect(actionMessage(connection)).toMatchObject({
      params: {
        action: { type: 'chat/turnStarted', prompt: 'through shared contract' },
        origin: { clientId: clientA, clientSeq: 1, commandId: createCommandId('claude-send-command') },
      },
    });
  });

  it('threads an authenticated principal through the connection and authorizes chat send', async () => {
    const alice = createPrincipal({
      principalId: 'alice',
      tenantId: 'tenant-a',
      capabilities: ['subscribe', 'send'],
    });
    const acl = createAccessControlList([{
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'alice', capabilities: ['subscribe', 'send'] }],
    }]);
    const { handler, host, actor } = createHarness(8, { acl });
    const dispatch = vi.spyOn(actor, 'dispatch');
    const connection = new AuthenticatedConnection(alice);

    const initialized = await initialize(handler, connection, clientA);
    expect(initialized.result).toMatchObject({ snapshots: [{ resource: chat }] });

    await handler.handle(connection, request('authorized-send', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('authorized-send-command'),
      action: { type: 'chat/send', prompt: 'authorized' },
    }));

    expect(connection.lastResponse().result).toMatchObject({ receipt: { status: 'accepted' } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(host.serverSeq).toBe(1);
  });

  it('filters cross-tenant initial subscriptions without exposing resource existence', async () => {
    const bob = createPrincipal({
      principalId: 'bob',
      tenantId: 'tenant-b',
      capabilities: ['subscribe', 'send', 'approve'],
    });
    const acl = createAccessControlList([{
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'alice', capabilities: ['subscribe', 'send', 'approve'] }],
    }]);
    const { handler, registry } = createHarness(8, { acl });
    const connection = new AuthenticatedConnection(bob);

    const initialized = await initialize(handler, connection, clientA, [chat]);
    expect(initialized).toMatchObject({ result: { snapshots: [], missing: [] } });
    expect(registry.getSubscriptions(clientA)).toEqual([]);
    expect(JSON.stringify(initialized)).not.toContain('tenant-a');
  });

  it('denies send, interrupt, and interaction resolution before actor or client sequence changes', async () => {
    const alice = createPrincipal({
      principalId: 'alice',
      tenantId: 'tenant-a',
      capabilities: ['subscribe'],
    });
    const acl = createAccessControlList([{
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'alice', capabilities: ['subscribe'] }],
    }]);
    const { handler, host, actor, registry } = createHarness(8, { acl });
    const dispatch = vi.spyOn(actor, 'dispatch');
    const connection = new AuthenticatedConnection(alice);
    await initialize(handler, connection, clientA);
    connection.sent.length = 0;

    await handler.handle(connection, request('denied-send', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('denied-send-command'),
      action: { type: 'chat/send', prompt: 'must not reach actor' },
    }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'denied-send',
      error: { code: -32007, message: 'Authorization denied' },
    });

    await handler.handle(connection, request('denied-interrupt', 'dispatchAction', {
      channel: chat,
      clientSeq: 2,
      commandId: createCommandId('denied-interrupt-command'),
      action: { type: 'chat/interrupt', turnId: createTurnId('not-active') },
    }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'denied-interrupt',
      error: { code: -32007, message: 'Authorization denied' },
    });

    await handler.handle(connection, request('denied-approval', 'chat/resolveApproval', {
      channel: chat,
      clientSeq: 3,
      commandId: createCommandId('denied-approval-command'),
      approvalId: 'approval-denied',
      decision: 'allow',
    }));
    expect(connection.lastResponse()).toMatchObject({
      id: 'denied-approval',
      error: { code: -32007, message: 'Authorization denied' },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(host.serverSeq).toBe(0);
    expect(registry.getMaxAcceptedClientSeq(clientA)).toBe(0);
    expect(JSON.stringify(connection.messages())).not.toContain('must not reach actor');
  });

  it('deduplicates commands and rejects busy/wrong-turn commands without new sequence values', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection);
    connection.sent.length = 0;

    const send = {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('send-command'),
      action: { type: 'chat/send', prompt: 'running' },
    };
    await handler.handle(connection, request('send-1', 'dispatchAction', send));
    const firstAction = actionMessage(connection);
    const accepted = connection.lastResponse();
    await handler.handle(connection, request('send-2', 'dispatchAction', {
      ...send,
      clientSeq: 99,
      action: { type: 'chat/send', prompt: 'must dedupe' },
    }));
    expect(connection.lastResponse().result).toEqual(accepted.result);
    expect(host.serverSeq).toBe(1);
    expect(actionMessage(connection)).toEqual(firstAction);

    await handler.handle(connection, request('busy', 'dispatchAction', {
      channel: chat,
      clientSeq: 2,
      commandId: createCommandId('busy-command'),
      action: { type: 'chat/send', prompt: 'blocked' },
    }));
    expect(connection.lastResponse().result).toEqual({
      receipt: { status: 'rejected', code: 'CHAT_BUSY', message: 'chat already has an active turn' },
    });
    await handler.handle(connection, request('wrong', 'dispatchAction', {
      channel: chat,
      clientSeq: 3,
      commandId: createCommandId('wrong-command'),
      action: { type: 'chat/interrupt', turnId: createTurnId('wrong-turn') },
    }));
    expect(connection.lastResponse().result).toEqual({
      receipt: { status: 'rejected', code: 'TURN_NOT_ACTIVE', message: 'turn is not active' },
    });
    expect(host.serverSeq).toBe(1);

    await handler.handle(connection, request('interrupt', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('interrupt-command'),
      action: { type: 'chat/interrupt', turnId: createTurnId('turn-1') },
    }));
    expect(connection.lastResponse().result).toEqual({
      receipt: { status: 'accepted', value: { acceptedAtSeq: 2 } },
    });
    expect(host.serverSeq).toBe(2);
  });

  it('replaces an old connection and makes stale close callbacks harmless', async () => {
    const { handler, registry } = createHarness();
    const oldConnection = new MemoryConnection();
    const newConnection = new MemoryConnection();
    await initialize(handler, oldConnection, clientA);
    await initialize(handler, newConnection, clientA);

    expect(oldConnection.messages().some((message) => message.method === 'client/replaced')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    const oldMessageCount = oldConnection.sent.length;
    await handler.handle(oldConnection, request('old', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('old-command'),
      action: { type: 'chat/send', prompt: 'old must fail' },
    }));
    if (oldConnection.sent.length > oldMessageCount) {
      expect(oldConnection.lastResponse().error).toMatchObject({ code: -32003 });
    }
    expect(oldConnection.closes).toContainEqual({ code: 4001, reason: 'client replaced' });
    handler.onConnectionClosed(oldConnection.id);
    expect(registry.isActive(clientA, newConnection.id)).toBe(true);

    await handler.handle(newConnection, request('new', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('new-command'),
      action: { type: 'chat/send', prompt: 'new works' },
    }));
    expect(newConnection.lastResponse().result).toMatchObject({ receipt: { status: 'accepted' } });
  });

  it('holds actions behind an async subscribe snapshot response and flushes only post-cut actions', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, []);
    connection.sent.length = 0;
    connection.blocked = true;
    const subscribe = handler.handle(connection, request('subscribe', 'subscribe', { channel: chat }));
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('external-turn'),
      prompt: 'after snapshot',
      timestamp: 'external-action',
    });
    expect(connection.sent).toEqual([]);
    connection.releaseSends();
    await subscribe;
    const messages = connection.messages();
    expect(messages[0]).toMatchObject({ id: 'subscribe', result: { snapshot: { fromSeq: 0 } } });
    expect(messages[1]).toMatchObject({ method: 'state/action', params: { serverSeq: 1 } });
  });

  it('flushes held actions after a missing subscribe error in response order exactly once', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA);
    connection.sent.length = 0;
    connection.blocked = true;

    const subscribe = handler.handle(connection, request('missing-subscribe', 'subscribe', { channel: missingChat }));
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('held-existing-turn'),
      prompt: 'held while missing response is pending',
      timestamp: 'held-action',
    });

    expect(connection.sent).toEqual([]);
    connection.releaseSends();
    await subscribe;

    const messages = connection.messages();
    expect(messages[0]).toMatchObject({
      id: 'missing-subscribe',
      error: { code: -32004 },
    });
    expect(messages.filter((message) => message.method === 'state/action')).toHaveLength(1);
    expect(messages[1]).toMatchObject({
      method: 'state/action',
      params: { channel: chat, serverSeq: 1 },
    });
  });

  it('does not fan out held actions after the subscribe transport closes', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA);
    connection.sent.length = 0;
    connection.blocked = true;

    const subscribe = handler.handle(connection, request('closed-subscribe', 'subscribe', { channel: missingChat }));
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('held-closed-turn'),
      prompt: 'must not fan out after close',
      timestamp: 'held-closed-action',
    });

    handler.onConnectionClosed(connection.id);
    connection.releaseSends();
    await subscribe;

    expect(connection.messages().filter((message) => message.method === 'state/action')).toHaveLength(0);
  });

  it('rolls back a provider-throwing subscribe and flushes existing actions after its error', async () => {
    const secret = 'provider-secret-error';
    const { handler, host, provider, registry } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA);
    provider.snapshot = () => {
      throw new Error(secret);
    };
    connection.sent.length = 0;
    connection.blocked = true;

    const subscribe = handler.handle(connection, request('provider-error', 'subscribe', { channel: otherChat }));
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('held-provider-error-turn'),
      prompt: 'existing subscription survives provider error',
      timestamp: 'held-provider-error-action',
    });

    connection.releaseSends();
    await subscribe;
    const messages = connection.messages();
    expect(messages[0]).toMatchObject({ id: 'provider-error', error: { code: -32603 } });
    expect(JSON.stringify(messages[0])).not.toContain(secret);
    expect(messages.filter((message) => message.method === 'state/action')).toHaveLength(1);
    expect(registry.getSubscriptions(clientA)).toEqual([chat]);

    connection.sent.length = 0;
    host.dispatch(otherChat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('not-subscribed-after-provider-error'),
      prompt: 'must not fan out',
      timestamp: 'not-subscribed',
    });
    expect(actionMessage(connection)).toBeUndefined();
  });

  it('restores an active subscription after a duplicate subscribe setup error', async () => {
    const secret = 'duplicate-provider-secret';
    const { handler, host, provider, registry } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA);
    provider.snapshot = () => {
      throw new Error(secret);
    };
    connection.sent.length = 0;
    connection.blocked = true;

    const subscribe = handler.handle(connection, request('duplicate-provider-error', 'subscribe', { channel: chat }));
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('held-duplicate-provider-error-turn'),
      prompt: 'active subscription survives duplicate setup error',
      timestamp: 'held-duplicate-provider-error-action',
    });

    connection.releaseSends();
    await subscribe;
    const messages = connection.messages();
    expect(messages[0]).toMatchObject({ id: 'duplicate-provider-error', error: { code: -32603 } });
    expect(JSON.stringify(messages[0])).not.toContain(secret);
    expect(messages.filter((message) => message.method === 'state/action')).toHaveLength(1);
    expect(registry.getSubscriptions(clientA)).toEqual([chat]);
  });

  it('unsubscribes only fanout and leaves host state intact', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection);
    connection.sent.length = 0;
    await handler.handle(connection, request('unsubscribe', 'unsubscribe', { channel: chat }));
    expect(connection.lastResponse().result).toEqual({ removed: true });
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('external-turn'),
      prompt: 'not delivered',
      timestamp: 'external-action',
    });
    expect(actionMessage(connection)).toBeUndefined();
    expect(host.serverSeq).toBe(1);
  });

  it('replays same-epoch actions and falls back to a fresh snapshot on overwindow or epoch mismatch', async () => {
    const { handler, host } = createHarness(1);
    const connection = new MemoryConnection();
    await initialize(handler, connection);
    host.dispatch(chat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('replay-turn'),
      prompt: 'replay',
      timestamp: 'action-1',
    });
    connection.sent.length = 0;
    await handler.handle(connection, request('replay', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [chat],
    }));
    expect(connection.lastResponse().result).toMatchObject({
      type: 'replay',
      hostEpoch: 'epoch-1',
      throughSeq: 1,
      actions: [{ serverSeq: 1 }],
    });

    host.dispatch(otherChat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('other-turn'),
      prompt: 'window',
      timestamp: 'action-2',
    });
    connection.sent.length = 0;
    await handler.handle(connection, request('window', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [chat],
    }));
    expect(connection.lastResponse().result).toMatchObject({ type: 'snapshot', hostEpoch: 'epoch-1' });

    connection.sent.length = 0;
    await handler.handle(connection, request('epoch', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'old-epoch',
      lastSeenServerSeq: 2,
      subscriptions: [chat],
    }));
    expect(connection.lastResponse().result).toMatchObject({ type: 'snapshot', hostEpoch: 'epoch-1' });
  });

  it('reconnect restores only the declared prior-baseline subscriptions', async () => {
    const { handler, host } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, [chat, otherChat]);
    connection.sent.length = 0;

    await handler.handle(connection, request('reconnect-subset', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [chat],
    }));
    connection.sent.length = 0;
    host.dispatch(otherChat, {
      type: 'chat/turnStarted',
      turnId: createTurnId('omitted-turn'),
      prompt: 'must not fan out',
      timestamp: 'omitted-action',
    });
    expect(actionMessage(connection)).toBeUndefined();
  });

  it('binds a fresh transport directly through reconnect using only prior subscriptions', async () => {
    const { handler, registry } = createHarness();
    const first = new MemoryConnection();
    await initialize(handler, first, clientA, [chat]);
    handler.onConnectionClosed(first.id);

    const replacement = new MemoryConnection();
    await handler.handle(replacement, request('reconnect', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [chat],
    }));
    expect(replacement.lastResponse().result).toMatchObject({
      type: 'snapshot',
      hostEpoch: 'epoch-1',
      throughSeq: 0,
    });
    expect(registry.isActive(clientA, replacement.id)).toBe(true);

    await handler.handle(replacement, request('new-resource', 'reconnect', {
      channel: root,
      clientId: clientA,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [chat, otherChat],
    }));
    expect(replacement.lastResponse().error).toMatchObject({ code: -32004 });
  });

  it('serializes requests and async sends in request order', async () => {
    const { handler } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection, clientA, []);
    connection.sent.length = 0;
    connection.blocked = true;

    const subscribe = handler.handle(connection, request('first', 'subscribe', { channel: chat }));
    const unsubscribe = handler.handle(connection, request('second', 'unsubscribe', { channel: chat }));
    await Promise.resolve();
    expect(connection.sent).toEqual([]);
    connection.releaseSends();
    await Promise.all([subscribe, unsubscribe]);

    expect(connection.messages().filter((message) => 'id' in message).map((message) => message.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('isolates async send failure after commit and leaves the host recoverable', async () => {
    const { handler, host, registry } = createHarness();
    const connection = new MemoryConnection();
    await initialize(handler, connection);
    connection.failSends = true;

    await handler.handle(connection, request('send', 'dispatchAction', {
      channel: chat,
      clientSeq: 1,
      commandId: createCommandId('committed-before-send-failure'),
      action: { type: 'chat/send', prompt: 'committed' },
    }));

    expect(host.serverSeq).toBe(1);
    expect(host.getState(chat)?.activeTurn?.prompt).toBe('committed');
    expect(connection.closes).toContainEqual({ code: 1011, reason: 'send failed' });
    expect(registry.isActive(clientA, connection.id)).toBe(false);
    expect(registry.getMaxAcceptedClientSeq(clientA)).toBe(1);
  });
});
