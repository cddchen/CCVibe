import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  ChatHostStateProvider,
  CommandDeduper,
  createChatUri,
  createClientId,
  createCommandId,
  createConnectionId,
  createRootUri,
  createTurnId,
  FakeChatActor,
  HostStateManager,
  LogicalClientRegistry,
  MAX_JSON_FRAME_BYTES,
  ProtocolServerHandler,
  SequencerByKey,
} from '../../src/index.js';
import {
  createAgentHostServer,
  createWebSocketProtocolConnection,
  HEARTBEAT_TIMEOUT_CLOSE_CODE,
  MESSAGE_TOO_LARGE_CLOSE_CODE,
  MESSAGE_TOO_LARGE_CLOSE_REASON,
  SERVER_SHUTDOWN_CLOSE_CODE,
  SLOW_CLIENT_CLOSE_CODE,
  UNSUPPORTED_DATA_CLOSE_CODE,
} from '../../src/transport/fastifyServer.js';
import type { AgentHostProtocolHandler } from '../../src/transport/fastifyServer.js';

const root = createRootUri();
const chat = createChatUri('session-1', 'chat-1');
const clientId = createClientId('client-a');
const secondClientId = createClientId('client-b');

interface TestHarness {
  readonly host: HostStateManager;
  readonly handler: ProtocolServerHandler;
}

function createHarness(): TestHarness {
  const host = new HostStateManager({ now: () => 'server-time', replayCapacity: 32 });
  host.registerChat(chat);
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
    hostEpoch: 'epoch-1',
    stateProvider: provider,
    clientRegistry: registry,
    chatActor: actor,
  });
  return { host, handler };
}

class WebSocketInbox {
  private readonly messages: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<{
    readonly predicate: (message: Record<string, unknown>) => boolean;
    readonly resolve: (message: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private failure: Error | undefined;

  public constructor(public readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) {
        this.messages.push(message);
        return;
      }
      const waiter = this.waiters.splice(index, 1)[0];
      waiter?.resolve(message);
    });
    socket.on('error', (error) => {
      this.failure = error;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  public next(predicate: (message: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const index = this.messages.findIndex(predicate);
    if (index !== -1) {
      return Promise.resolve(this.messages.splice(index, 1)[0] as Record<string, unknown>);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiters.push({ predicate, resolve, reject });
    });
  }
}

async function openClient(url: string): Promise<WebSocketInbox> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return new WebSocketInbox(socket);
}

function observeClose(socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function getOnlyServerSocket(server: Awaited<ReturnType<typeof createAgentHostServer>>): WebSocket {
  const socket = [...server.websocketServer.clients][0];
  if (socket === undefined) {
    throw new Error('server has no live WebSocket');
  }
  return socket;
}

async function closeClient(client: WebSocketInbox | undefined): Promise<void> {
  if (client === undefined || client.socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    client.socket.once('close', () => resolve());
    client.socket.close();
  });
}

async function closeServer(server: Awaited<ReturnType<typeof createAgentHostServer>> | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await server.close();
}

async function listen(server: Awaited<ReturnType<typeof createAgentHostServer>>): Promise<string> {
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP address');
  }
  return `ws://127.0.0.1:${address.port}/ws`;
}

function request(id: string, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function call(
  client: WebSocketInbox,
  id: string,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  client.socket.send(request(id, method, params));
  return client.next((message) => message.id === id);
}

function initializeParams(
  initialSubscriptions: readonly unknown[] = [],
  logicalClientId: typeof clientId = clientId,
): Record<string, unknown> {
  return {
    channel: root,
    protocolVersions: ['1.0.0'],
    clientId: logicalClientId,
    clientInfo: { name: 'transport-test', version: '1', platform: 'node' },
    capabilities: { partialBlocks: true, approvalEdits: false },
    initialSubscriptions,
  };
}

describe('Fastify/WSS transport shell', () => {
  it('serves health and completes an actual loopback protocol round trip', async () => {
    const { handler, host } = createHarness();
    const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
    let first: WebSocketInbox | undefined;
    let second: WebSocketInbox | undefined;
    try {
      const wsUrl = await listen(server);
      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', protocolVersions: ['1.0.0'] });

      first = await openClient(wsUrl);
      second = await openClient(wsUrl);
      expect((await call(first, 'initialize-1', 'initialize', initializeParams())).result).toMatchObject({
        protocolVersion: '1.0.0',
        snapshots: [],
      });
      expect((await call(second, 'initialize-2', 'initialize', initializeParams([chat], secondClientId))).result).toMatchObject({
        protocolVersion: '1.0.0',
        snapshots: [{ resource: chat }],
      });
      expect((await call(first, 'subscribe', 'subscribe', { channel: chat })).result).toMatchObject({
        snapshot: { resource: chat },
      });

      first.socket.send(request('dispatch', 'dispatchAction', {
        channel: chat,
        clientSeq: 1,
        commandId: createCommandId('command-1'),
        action: { type: 'chat/send', prompt: 'loopback prompt' },
      }));
      const firstAction = await first.next((message) => message.method === 'state/action');
      const secondAction = await second.next((message) => message.method === 'state/action');
      const receipt = await first.next((message) => message.id === 'dispatch');
      expect(firstAction).toEqual(secondAction);
      expect(firstAction).toMatchObject({
        method: 'state/action',
        params: {
          channel: chat,
          action: { type: 'chat/turnStarted', prompt: 'loopback prompt' },
          origin: { clientId, clientSeq: 1, commandId: createCommandId('command-1') },
        },
      });
      expect(receipt).toMatchObject({ result: { receipt: { status: 'accepted' } } });
      expect(host.serverSeq).toBe(1);
    } finally {
      await closeClient(first);
      await closeClient(second);
      await closeServer(server);
    }
  });

  it('forwards malformed JSON to the protocol handler instead of parsing in transport', async () => {
    const { handler } = createHarness();
    const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      client.socket.send('{not json');
      await expect(client.next((message) => message.error !== undefined)).resolves.toMatchObject({
        id: null,
        error: { code: -32700 },
      });
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('closes binary and oversized frames before they reach the handler', async () => {
    const { handler } = createHarness();
    let handledCount = 0;
    let closedCount = 0;
    const trackedHandler: AgentHostProtocolHandler = {
      handle: (connection, raw) => {
        handledCount += 1;
        return handler.handle(connection, raw);
      },
      onConnectionClosed: (connectionId) => {
        closedCount += 1;
        handler.onConnectionClosed(connectionId);
      },
    };
    const server = await createAgentHostServer({
      handler: trackedHandler,
      heartbeatIntervalMs: 0,
      fastifyOptions: { logger: false },
    });
    let binaryClient: WebSocketInbox | undefined;
    let oversizedClient: WebSocketInbox | undefined;
    try {
      const wsUrl = await listen(server);
      binaryClient = await openClient(wsUrl);
      const binaryServerSocket = getOnlyServerSocket(server);
      const binaryClose = observeClose(binaryClient.socket);
      binaryClient.socket.send(Buffer.from('binary'));
      await expect(binaryClose).resolves.toEqual({
        code: UNSUPPORTED_DATA_CLOSE_CODE,
        reason: 'binary messages are not supported',
      });
      binaryServerSocket.emit('message', 'after-binary', false);
      expect(handledCount).toBe(0);
      expect(closedCount).toBe(1);

      oversizedClient = await openClient(wsUrl);
      const oversizedServerSocket = getOnlyServerSocket(server);
      const oversizedClose = observeClose(oversizedClient.socket);
      oversizedClient.socket.send('x'.repeat(MAX_JSON_FRAME_BYTES + 1));
      await expect(oversizedClose).resolves.toEqual({
        code: MESSAGE_TOO_LARGE_CLOSE_CODE,
        reason: MESSAGE_TOO_LARGE_CLOSE_REASON,
      });
      oversizedServerSocket.emit('message', 'after-oversized', false);
      expect(handledCount).toBe(0);
      expect(closedCount).toBe(2);
    } finally {
      await closeClient(binaryClient);
      await closeClient(oversizedClient);
      await closeServer(server);
    }
  });

  it('detaches before closing a manually oversized frame', async () => {
    let handledCount = 0;
    let closedCount = 0;
    const handler: AgentHostProtocolHandler = {
      handle: () => {
        handledCount += 1;
      },
      onConnectionClosed: () => {
        closedCount += 1;
      },
    };
    const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      const serverSocket = getOnlyServerSocket(server);
      const close = observeClose(client.socket);
      serverSocket.emit('message', Buffer.alloc(MAX_JSON_FRAME_BYTES + 1), false);
      serverSocket.emit('message', 'after-manual-oversize', false);

      await expect(close).resolves.toEqual({
        code: MESSAGE_TOO_LARGE_CLOSE_CODE,
        reason: MESSAGE_TOO_LARGE_CLOSE_REASON,
      });
      expect(handledCount).toBe(0);
      expect(closedCount).toBe(1);
      expect(serverSocket.listenerCount('message')).toBe(0);
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('detaches before synchronous and asynchronous handler failures', async () => {
    const failures: Array<{ readonly name: string; readonly handle: AgentHostProtocolHandler['handle'] }> = [
      {
        name: 'synchronous',
        handle: () => {
          throw new Error('sync failure');
        },
      },
      {
        name: 'asynchronous',
        handle: async () => {
          throw new Error('async failure');
        },
      },
    ];

    for (const failure of failures) {
      let handledCount = 0;
      let closedCount = 0;
      const handler: AgentHostProtocolHandler = {
        handle: (...args) => {
          handledCount += 1;
          return failure.handle(...args);
        },
        onConnectionClosed: () => {
          closedCount += 1;
        },
      };
      const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
      let client: WebSocketInbox | undefined;
      try {
        client = await openClient(await listen(server));
        const serverSocket = getOnlyServerSocket(server);
        const close = observeClose(client.socket);
        client.socket.send('first-frame');
        await expect(close).resolves.toEqual({ code: 1011, reason: 'handler failed' });
        serverSocket.emit('message', 'after-handler-failure', false);

        expect(handledCount).toBe(1);
        expect(closedCount).toBe(1);
        expect(serverSocket.listenerCount('message')).toBe(0);
      } finally {
        await closeClient(client);
        await closeServer(server);
      }
    }
  });

  it('detaches before closing a WebSocket payload error', async () => {
    let handledCount = 0;
    let closedCount = 0;
    const handler: AgentHostProtocolHandler = {
      handle: () => {
        handledCount += 1;
      },
      onConnectionClosed: () => {
        closedCount += 1;
      },
    };
    const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      const serverSocket = getOnlyServerSocket(server);
      const close = observeClose(client.socket);
      const error = Object.assign(new Error('Max payload size exceeded'), {
        code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
      });
      serverSocket.emit('error', error);
      serverSocket.emit('message', 'after-payload-error', false);

      await expect(close).resolves.toEqual({
        code: MESSAGE_TOO_LARGE_CLOSE_CODE,
        reason: MESSAGE_TOO_LARGE_CLOSE_REASON,
      });
      expect(handledCount).toBe(0);
      expect(closedCount).toBe(1);
      expect(serverSocket.listenerCount('message')).toBe(0);
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('rejects a duplicate injected connection id deterministically', async () => {
    const { handler } = createHarness();
    const server = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 0,
      fastifyOptions: { logger: false },
      connectionIdAllocator: () => createConnectionId('same-transport-id'),
    });
    let first: WebSocketInbox | undefined;
    let second: WebSocketInbox | undefined;
    try {
      const wsUrl = await listen(server);
      first = await openClient(wsUrl);
      second = await openClient(wsUrl);
      const closeCode = new Promise<number>((resolve) => second?.socket.once('close', (code) => resolve(code)));
      await expect(closeCode).resolves.toBe(1011);
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await closeClient(first);
      await closeClient(second);
      await closeServer(server);
    }
  });

  it('closes a slow client through the adapter without blocking send', async () => {
    const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
    let transportFailures = 0;
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 10,
      send: (_text: string, callback?: (error?: Error) => void): void => callback?.(),
      close: (code?: number, reason?: string): void => {
        closes.push({ code, reason });
      },
    };
    const connection = createWebSocketProtocolConnection(socket, createConnectionId('adapter-test'), {
      highWaterMarkBytes: 5,
      onTransportFailure: () => {
        transportFailures += 1;
      },
    });

    await expect(connection.send('blocked')).rejects.toThrow('high water mark');
    expect(transportFailures).toBe(1);
    expect(closes).toEqual([{ code: SLOW_CLIENT_CLOSE_CODE, reason: 'slow client' }]);
  });

  it('detaches exactly once when a live client becomes slow', async () => {
    const { handler, host } = createHarness();
    let closedCount = 0;
    let handledCount = 0;
    const trackedHandler: AgentHostProtocolHandler = {
      handle: (connection, raw) => {
        handledCount += 1;
        return handler.handle(connection, raw);
      },
      onConnectionClosed: (connectionId) => {
        closedCount += 1;
        handler.onConnectionClosed(connectionId);
      },
    };
    const server = await createAgentHostServer({
      handler: trackedHandler,
      heartbeatIntervalMs: 0,
      highWaterMarkBytes: 0,
      fastifyOptions: { logger: false },
    });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      await expect(call(client, 'initialize-slow', 'initialize', initializeParams())).resolves.toMatchObject({
        result: { protocolVersion: '1.0.0' },
      });
      await expect(call(client, 'subscribe-slow', 'subscribe', { channel: chat })).resolves.toMatchObject({
        result: { snapshot: { resource: chat } },
      });
      const serverSocket = getOnlyServerSocket(server);
      Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, value: 1 });
      const handledBeforeClose = handledCount;
      const close = observeClose(client.socket);
      host.dispatch(chat, {
        type: 'chat/turnStarted',
        turnId: createTurnId('slow-client-turn'),
        prompt: 'slow client',
        timestamp: 'slow-client-action',
      });

      await expect(close).resolves.toEqual({ code: SLOW_CLIENT_CLOSE_CODE, reason: 'slow client' });
      serverSocket.emit('message', 'after-slow-client', false);
      expect(handledCount).toBe(handledBeforeClose);
      expect(closedCount).toBe(1);
      expect(serverSocket.listenerCount('message')).toBe(0);
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('server close sends the shutdown close code and reason before detaching once', async () => {
    let closedCount = 0;
    const handler: AgentHostProtocolHandler = {
      handle: () => undefined,
      onConnectionClosed: () => {
        closedCount += 1;
      },
    };
    const server = await createAgentHostServer({ handler, heartbeatIntervalMs: 0, fastifyOptions: { logger: false } });
    let first: WebSocketInbox | undefined;
    let second: WebSocketInbox | undefined;
    try {
      const wsUrl = await listen(server);
      first = await openClient(wsUrl);
      second = await openClient(wsUrl);
      const serverSockets = [...server.websocketServer.clients];
      const firstClose = observeClose(first.socket);
      const secondClose = observeClose(second.socket);
      await server.close();

      await expect(firstClose).resolves.toEqual({
        code: SERVER_SHUTDOWN_CLOSE_CODE,
        reason: 'server shutting down',
      });
      await expect(secondClose).resolves.toEqual({
        code: SERVER_SHUTDOWN_CLOSE_CODE,
        reason: 'server shutting down',
      });
      expect(closedCount).toBe(2);
      expect(serverSockets).toHaveLength(2);
      for (const socket of serverSockets) {
        expect(socket.listenerCount('message')).toBe(0);
      }
      await server.close();
      expect(closedCount).toBe(2);
    } finally {
      await closeClient(first);
      await closeClient(second);
      await closeServer(server);
    }
  });

  it('validates heartbeat timeout against the enabled interval boundary', async () => {
    const { handler } = createHarness();

    await expect(createAgentHostServer({
      handler,
      heartbeatIntervalMs: 30,
      heartbeatTimeoutMs: 29,
      fastifyOptions: { logger: false },
    })).rejects.toThrow('heartbeatTimeoutMs must be greater than or equal to heartbeatIntervalMs');

    const equalBoundary = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 30,
      heartbeatTimeoutMs: 30,
      fastifyOptions: { logger: false },
    });
    await equalBoundary.close();

    const disabledHeartbeat = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 1,
      fastifyOptions: { logger: false },
    });
    await disabledHeartbeat.close();
  });

  it('starts heartbeat on first socket and clears an injected timer on close', async () => {
    const { handler } = createHarness();
    let intervalCallback: (() => void) | undefined;
    let clearCalls = 0;
    const timerHandle = {};
    const server = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
      timer: {
        now: () => 0,
        setInterval: (callback) => {
          intervalCallback = callback;
          return timerHandle;
        },
        clearInterval: (handle) => {
          expect(handle).toBe(timerHandle);
          clearCalls += 1;
        },
      },
      fastifyOptions: { logger: false },
    });
    let client: WebSocketInbox | undefined;
    try {
      expect(intervalCallback).toBeUndefined();
      client = await openClient(await listen(server));
      expect(intervalCallback).toBeDefined();
      await server.close();
      expect(clearCalls).toBe(1);
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('detaches exactly once before a heartbeat timeout close', async () => {
    let now = 0;
    let intervalCallback: (() => void) | undefined;
    let closedCount = 0;
    const handler: AgentHostProtocolHandler = {
      handle: () => undefined,
      onConnectionClosed: () => {
        closedCount += 1;
      },
    };
    const server = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
      timer: {
        now: () => now,
        setInterval: (callback) => {
          intervalCallback = callback;
          return {};
        },
        clearInterval: () => undefined,
      },
      fastifyOptions: { logger: false },
    });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      const serverSocket = getOnlyServerSocket(server);
      expect(intervalCallback).toBeDefined();
      now = 30;
      const close = observeClose(client.socket);
      intervalCallback?.();
      serverSocket.emit('message', 'after-heartbeat-timeout', false);

      await expect(close).resolves.toEqual({
        code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
        reason: 'heartbeat timeout',
      });
      expect(closedCount).toBe(1);
      expect(serverSocket.listenerCount('message')).toBe(0);
    } finally {
      await closeClient(client);
      await closeServer(server);
    }
  });

  it('keeps heartbeat running when an injected interval has no handle', async () => {
    let intervalCalls = 0;
    let clearCalls = 0;
    const { handler } = createHarness();
    const server = await createAgentHostServer({
      handler,
      heartbeatIntervalMs: 10,
      timer: {
        now: () => 0,
        setInterval: () => {
          intervalCalls += 1;
          return undefined;
        },
        clearInterval: (handle) => {
          expect(handle).toBeUndefined();
          clearCalls += 1;
        },
      },
      fastifyOptions: { logger: false },
    });
    let first: WebSocketInbox | undefined;
    let second: WebSocketInbox | undefined;
    try {
      const wsUrl = await listen(server);
      first = await openClient(wsUrl);
      second = await openClient(wsUrl);
      expect(intervalCalls).toBe(1);
      await server.close();
      expect(clearCalls).toBe(1);
      await server.close();
      expect(clearCalls).toBe(1);
    } finally {
      await closeClient(first);
      await closeClient(second);
      await closeServer(server);
    }
  });

  it('keeps heartbeat alive and cleans up transports and timers on server close', async () => {
    const { handler } = createHarness();
    let closedCount = 0;
    let disposedCount = 0;
    let disposeCompleted = false;
    const trackedHandler: AgentHostProtocolHandler = {
      handle: handler.handle.bind(handler),
      onConnectionClosed: (connectionId) => {
        closedCount += 1;
        handler.onConnectionClosed(connectionId);
      },
      dispose: async () => {
        disposedCount += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        handler.dispose();
        disposeCompleted = true;
      },
    };
    const server = await createAgentHostServer({
      handler: trackedHandler,
      heartbeatIntervalMs: 10,
      disposeHandlerOnClose: true,
      fastifyOptions: { logger: false },
    });
    let client: WebSocketInbox | undefined;
    try {
      client = await openClient(await listen(server));
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      await server.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closedCount).toBe(1);
      expect(disposedCount).toBe(1);
      expect(disposeCompleted).toBe(true);
      await server.close();
      expect(disposedCount).toBe(1);
    } finally {
      await closeClient(client);
      // Fastify close is idempotent, but this also handles assertion failures.
      await closeServer(server);
    }
  });
});
