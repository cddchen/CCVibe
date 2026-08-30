import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  authenticateBearer,
  AUTHENTICATION_FAILURE_MESSAGE,
  containsCredentialQuery,
  extractBearerToken,
  safeAuthenticationFailureBody,
} from '../../src/transport/auth.js';
import {
  applySubscriptionLimit,
  assessBufferedAmount,
  assessIncomingFrame,
  assessPendingFrames,
  consumeRateLimit,
  createRateLimitState,
  createSubscriptionLimitState,
} from '../../src/transport/limits.js';
import {
  AUTHENTICATION_FAILURE_STATUS,
  QUEUE_LIMIT_CLOSE_CODE,
  QUEUE_LIMIT_CLOSE_REASON,
  RATE_LIMIT_CLOSE_CODE,
  RATE_LIMIT_CLOSE_REASON,
  SUBSCRIPTION_LIMIT_CLOSE_CODE,
  SUBSCRIPTION_LIMIT_CLOSE_REASON,
  createAgentHostServer,
  type AgentHostProtocolHandler,
  type TransportProtocolConnection,
} from '../../src/transport/fastifyServer.js';

describe('transport authentication and pure limits', () => {
  it('extracts only one bearer header and rejects credential-shaped URLs', () => {
    expect(extractBearerToken('Bearer opaque-token')).toBe('opaque-token');
    expect(extractBearerToken('bearer opaque-token')).toBe('opaque-token');
    expect(extractBearerToken(['Bearer one', 'Bearer two'])).toBeUndefined();
    expect(extractBearerToken('Basic opaque-token')).toBeUndefined();
    expect(containsCredentialQuery('/ws?token=secret')).toBe(true);
    expect(containsCredentialQuery('/ws?access_token=secret')).toBe(true);
    expect(containsCredentialQuery('/ws?session=public')).toBe(false);
  });

  it('collapses missing, invalid and verifier errors to the same safe result', async () => {
    const context = { transport: 'websocket' as const };
    const verifierCalls: string[] = [];
    const verifier = async (token: any): Promise<{ readonly id: string } | null> => {
      verifierCalls.push(token);
      if (token === 'throws') {
        throw new Error('secret verifier detail');
      }
      return token === 'good' ? { id: 'principal-1' } : null;
    };
    const missing = await authenticateBearer({ verifier, required: true, context });
    const invalid = await authenticateBearer({ verifier, required: true, authorization: 'Bearer bad', context });
    const thrown = await authenticateBearer({ verifier, required: true, authorization: 'Bearer throws', context });

    expect(missing).toEqual({ ok: false, error: 'authentication_failed' });
    expect(invalid).toEqual(missing);
    expect(thrown).toEqual(missing);
    expect(JSON.stringify([missing, invalid, thrown])).not.toContain('secret');
    expect(safeAuthenticationFailureBody()).toEqual({ error: AUTHENTICATION_FAILURE_MESSAGE });
    expect(verifierCalls).toEqual(['bad', 'throws']);
  });

  it('uses immutable fixed-window rate decisions without mutating state', () => {
    const initial = createRateLimitState(100);
    const policy = { maxMessages: 2, windowMs: 1_000, maxBytes: 10 };
    const first = consumeRateLimit(initial, { bytes: 4 }, 100, policy);
    const second = consumeRateLimit(first.state, { bytes: 4 }, 200, policy);
    const denied = consumeRateLimit(second.state, { bytes: 1 }, 300, policy);
    const fresh = consumeRateLimit(second.state, { bytes: 1 }, 1_100, policy);
    expect(initial).toEqual({ windowStartedAt: 100, acceptedMessages: 0, acceptedBytes: 0 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(denied).toMatchObject({ allowed: false, reason: 'messages', retryAfterMs: 800 });
    expect(fresh).toMatchObject({ allowed: true, state: { windowStartedAt: 1_100, acceptedMessages: 1 } });
  });

  it('classifies bytes, backpressure and bounded pending work purely', () => {
    expect(assessIncomingFrame('😀', false, 4)).toEqual({ kind: 'text', bytes: 4 });
    expect(assessIncomingFrame('😀', false, 3)).toEqual({ kind: 'too-large', bytes: 4, limit: 3 });
    expect(assessIncomingFrame(new Uint8Array([1]), true, 1)).toEqual({ kind: 'binary', bytes: 1 });
    expect(assessBufferedAmount(5, 5).allowed).toBe(true);
    expect(assessBufferedAmount(6, 5).allowed).toBe(false);
    expect(assessPendingFrames(0, 1)).toMatchObject({ allowed: true, pending: 1 });
    expect(assessPendingFrames(1, 1)).toMatchObject({ allowed: false, reason: 'queue-full' });
  });

  it('keeps subscription accounting bounded and supports unsubscribe', () => {
    const initial = createSubscriptionLimitState();
    const one = applySubscriptionLimit(
      JSON.stringify({ method: 'subscribe', params: { channel: 'chat-1' } }),
      initial,
      1,
    );
    expect(one).toMatchObject({ allowed: true, state: { resources: ['chat-1'] } });
    const denied = applySubscriptionLimit(
      JSON.stringify({ method: 'subscribe', params: { channel: 'chat-2' } }),
      one.state,
      1,
    );
    expect(denied).toMatchObject({ allowed: false, reason: 'subscriptions' });
    const removed = applySubscriptionLimit(
      JSON.stringify({ method: 'unsubscribe', params: { channel: 'chat-1' } }),
      one.state,
      1,
    );
    expect(removed).toMatchObject({ allowed: true, state: { resources: [] } });
  });
});

interface SocketHarness {
  readonly socket: WebSocket;
  readonly close: Promise<{ readonly code: number; readonly reason: string }>;
}

function connect(url: string, headers?: Record<string, string>): Promise<SocketHarness> {
  const socket = new WebSocket(url, { headers });
  const open = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const close = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  return open.then(() => ({ socket, close }));
}

function baseHandler(onHandle: (connection: TransportProtocolConnection, raw: string) => void): AgentHostProtocolHandler {
  return {
    handle: onHandle,
    onConnectionClosed: () => undefined,
  };
}

async function listen(server: Awaited<ReturnType<typeof createAgentHostServer>>): Promise<string> {
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind');
  }
  return `ws://127.0.0.1:${address.port}/ws`;
}

describe('Fastify transport security gates', () => {
  it('rejects unauthenticated upgrades with one safe HTTP response', async () => {
    const server = await createAgentHostServer({
      handler: baseHandler(() => undefined),
      bearerTokenVerifier: async (token) => token === 'good' ? { id: 'principal-1' } : null,
      fastifyOptions: { logger: false },
      heartbeatIntervalMs: 0,
    });
    try {
      const response = await server.inject({ method: 'GET', url: '/ws' });
      expect(response.statusCode).toBe(AUTHENTICATION_FAILURE_STATUS);
      expect(response.json()).toEqual({ error: AUTHENTICATION_FAILURE_MESSAGE });
      expect(response.body).not.toContain('Bearer');
      const queryResponse = await server.inject({ method: 'GET', url: '/ws?token=secret' });
      expect(queryResponse.statusCode).toBe(AUTHENTICATION_FAILURE_STATUS);
      expect(queryResponse.body).not.toContain('secret');
    } finally {
      await server.close();
    }
  });

  it('passes only the verified principal to a valid connection', async () => {
    let received: TransportProtocolConnection | undefined;
    const server = await createAgentHostServer({
      handler: baseHandler((connection) => {
        received = connection;
      }),
      bearerTokenVerifier: async (token, context) => {
        expect(context).toEqual({ transport: 'websocket', remoteAddress: expect.any(String) });
        return token === 'good' ? { id: 'principal-1' } : null;
      },
      fastifyOptions: { logger: false },
      heartbeatIntervalMs: 0,
    });
    let client: SocketHarness | undefined;
    try {
      client = await connect(await listen(server), { authorization: 'Bearer good' });
      client.socket.send('hello');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(received?.authentication).toEqual({ authenticated: true, principal: { id: 'principal-1' }, scheme: 'Bearer' });
      expect(received?.auth).toEqual(received?.authentication);
      expect(received?.principal).toEqual({ id: 'principal-1' });
    } finally {
      client?.socket.close();
      await server.close();
    }
  });

  it('closes a connection after rate, queue, and subscription admission limits', async () => {
    let resolveFirst: (() => void) | undefined;
    const firstWork = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const server = await createAgentHostServer({
      handler: baseHandler(async (_connection, raw) => {
        if (raw === 'first') {
          await firstWork;
        }
      }),
      rateLimit: false,
      maxPendingFrames: 1,
      maxSubscriptions: 1,
      fastifyOptions: { logger: false },
      heartbeatIntervalMs: 0,
    });
    let client: SocketHarness | undefined;
    try {
      client = await connect(await listen(server));
      client.socket.send('first');
      client.socket.send('second');
      await expect(client.close).resolves.toEqual({ code: QUEUE_LIMIT_CLOSE_CODE, reason: QUEUE_LIMIT_CLOSE_REASON });
      resolveFirst?.();
    } finally {
      resolveFirst?.();
      client?.socket.close();
      await server.close();
    }

    const rateServer = await createAgentHostServer({
      handler: baseHandler(() => undefined),
      rateLimit: { maxMessages: 1, windowMs: 10_000 },
      fastifyOptions: { logger: false },
      heartbeatIntervalMs: 0,
    });
    let rateClient: SocketHarness | undefined;
    try {
      rateClient = await connect(await listen(rateServer));
      rateClient.socket.send('first');
      rateClient.socket.send('second');
      await expect(rateClient.close).resolves.toEqual({ code: RATE_LIMIT_CLOSE_CODE, reason: RATE_LIMIT_CLOSE_REASON });
    } finally {
      rateClient?.socket.close();
      await rateServer.close();
    }

    const subscriptionServer = await createAgentHostServer({
      handler: baseHandler(() => undefined),
      maxSubscriptions: 1,
      rateLimit: false,
      fastifyOptions: { logger: false },
      heartbeatIntervalMs: 0,
    });
    let subscriptionClient: SocketHarness | undefined;
    try {
      subscriptionClient = await connect(await listen(subscriptionServer));
      subscriptionClient.socket.send(JSON.stringify({ method: 'initialize', params: { initialSubscriptions: ['a', 'b'] } }));
      await expect(subscriptionClient.close).resolves.toEqual({
        code: SUBSCRIPTION_LIMIT_CLOSE_CODE,
        reason: SUBSCRIPTION_LIMIT_CLOSE_REASON,
      });
    } finally {
      subscriptionClient?.socket.close();
      await subscriptionServer.close();
    }
  });
});
