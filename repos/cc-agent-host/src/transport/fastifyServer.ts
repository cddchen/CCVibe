import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
  LogController,
} from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket as WsWebSocket } from 'ws';
import type { ConnectionId } from '../domain/ids.js';
import { createConnectionId } from '../domain/ids.js';
import { MAX_JSON_FRAME_BYTES, MAX_SUBSCRIPTIONS, PROTOCOL_VERSION } from '../protocol/limits.js';
import type { ProtocolConnection } from '../protocol/protocolServerHandler.js';
import {
  authenticateBearer,
  AUTHENTICATION_FAILURE_CLOSE_CODE,
  AUTHENTICATION_FAILURE_CLOSE_REASON,
  AUTHENTICATION_FAILURE_STATUS,
  containsCredentialQuery,
  safeAuthenticationFailureBody,
  type BearerTokenVerifier,
  type TransportAuthenticationContext,
} from './auth.js';
import {
  admitPendingFrame,
  applySubscriptionLimit,
  assessBufferedAmount,
  assessIncomingFrame,
  consumeRateLimit,
  createRateLimitState,
  createSubscriptionLimitState,
  type RateLimitPolicy,
  type RateLimitState,
  type SubscriptionLimitState,
} from './limits.js';

export {
  authenticateBearer,
  AUTHENTICATION_FAILURE,
  AUTHENTICATION_FAILURE_CLOSE_CODE,
  AUTHENTICATION_FAILURE_CLOSE_REASON,
  AUTHENTICATION_FAILURE_MESSAGE,
  AUTHENTICATION_FAILURE_STATUS,
  containsCredentialQuery,
  extractBearerToken,
  safeAuthenticationFailureBody,
} from './auth.js';
export {
  admitPendingFrame,
  applySubscriptionLimit,
  assessBufferedAmount,
  assessIncomingFrame,
  consumeRateLimit,
  createRateLimitState,
  createSubscriptionLimitState,
} from './limits.js';

/** Close code used when a client cannot keep up with the server output. */
export const SLOW_CLIENT_CLOSE_CODE = 1013;
/** Close code used when a transport receives an unsupported binary message. */
export const UNSUPPORTED_DATA_CLOSE_CODE = 1003;
/** Close code used when a WebSocket payload exceeds the protocol limit. */
export const MESSAGE_TOO_LARGE_CLOSE_CODE = 1009;
export const MESSAGE_TOO_LARGE_CLOSE_REASON = 'message exceeds 512 KiB';
/** Close code used when the server is shutting down. */
export const SERVER_SHUTDOWN_CLOSE_CODE = 1001;
/** Close code used when a heartbeat times out. */
export const HEARTBEAT_TIMEOUT_CLOSE_CODE = 1001;
/** Close code used when an authenticated connection exceeds an inbound policy. */
export const RATE_LIMIT_CLOSE_CODE = 1008;
/** Close code used when an inbound work queue reaches its bounded capacity. */
export const QUEUE_LIMIT_CLOSE_CODE = 1013;
/** Close code used when a connection exceeds its subscription admission limit. */
export const SUBSCRIPTION_LIMIT_CLOSE_CODE = 1008;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
export const DEFAULT_SLOW_CLIENT_HIGH_WATER_MARK_BYTES = 2 * MAX_JSON_FRAME_BYTES;
/** Alias used by callers that name the policy as a generic high-water mark. */
export const DEFAULT_HIGH_WATER_MARK_BYTES = DEFAULT_SLOW_CLIENT_HIGH_WATER_MARK_BYTES;
export const DEFAULT_RATE_LIMIT_MAX_MESSAGES = 120;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_PENDING_FRAMES = 128;
export const DEFAULT_MAX_SUBSCRIPTIONS = MAX_SUBSCRIPTIONS;
export const RATE_LIMIT_CLOSE_REASON = 'rate limit exceeded';
export const QUEUE_LIMIT_CLOSE_REASON = 'too many pending frames';
export const SUBSCRIPTION_LIMIT_CLOSE_REASON = 'subscription limit exceeded';

/** The transport-independent methods required from the protocol layer. */
export interface AgentHostProtocolHandler {
  handle(connection: ProtocolConnection, raw: string): Promise<void> | void;
  onConnectionClosed(connectionId: ConnectionId): void;
  dispose?(): void | Promise<void>;
}

export type ConnectionIdAllocator = () => ConnectionId | string;

export interface AgentHostAuthenticationOptions<TPrincipal = unknown> {
  /** Product-specific verifier; the transport does not inspect its principal. */
  readonly verifier?: BearerTokenVerifier<TPrincipal>;
  readonly bearerTokenVerifier?: BearerTokenVerifier<TPrincipal>;
  readonly verifyBearerToken?: BearerTokenVerifier<TPrincipal>;
  readonly verify?: BearerTokenVerifier<TPrincipal>;
  /** Defaults to true whenever a verifier is supplied. */
  readonly required?: boolean;
}

/** A bounded inbound rate policy applied independently to each connection. */
export interface AgentHostRateLimitOptions extends Partial<RateLimitPolicy> {
  /** Descriptive aliases for maxMessages/windowMs used by configuration loaders. */
  readonly maxFrames?: number;
  readonly maxRequests?: number;
  readonly requestsPerWindow?: number;
  readonly intervalMs?: number;
  readonly bytesPerWindow?: number;
}

export interface AgentHostTimer {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface AgentHostServerOptions<TPrincipal = unknown> {
  /** The already-constructed protocol handler. The transport never owns host state. */
  readonly handler?: AgentHostProtocolHandler;
  /** Descriptive aliases for callers that name the protocol layer explicitly. */
  readonly protocolServerHandler?: AgentHostProtocolHandler;
  readonly protocolHandler?: AgentHostProtocolHandler;
  /** Fastify constructor options, such as logger configuration. */
  readonly fastifyOptions?: FastifyServerOptions;
  readonly heartbeatIntervalMs?: number;
  /** Maximum time without a pong before a live transport is closed. */
  readonly heartbeatTimeoutMs?: number;
  /** Optional clock/timer ports for deterministic heartbeat lifecycle tests. */
  readonly timer?: AgentHostTimer;
  readonly clock?: () => number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Preferred name for the outgoing buffered-byte high-water mark. */
  readonly highWaterMarkBytes?: number;
  /** Backward-compatible descriptive alias for highWaterMarkBytes. */
  readonly slowClientHighWaterMarkBytes?: number;
  /** Preferred allocator option. */
  readonly connectionIdAllocator?: ConnectionIdAllocator;
  /** Descriptive alias for the injected allocator. */
  readonly allocateConnectionId?: ConnectionIdAllocator;
  /** Short alias for connectionIdAllocator. */
  readonly connectionId?: ConnectionIdAllocator;
  /** Handler disposal is opt-in because the handler may be shared by hosts. */
  readonly disposeHandlerOnClose?: boolean;
  readonly disposeHandler?: boolean;
  readonly ownsHandler?: boolean;
  /** Strict bearer gate. Supplying a verifier implies required=true by default. */
  readonly bearerTokenVerifier?: BearerTokenVerifier<TPrincipal>;
  /** Alias for bearerTokenVerifier. */
  readonly verifyBearerToken?: BearerTokenVerifier<TPrincipal>;
  readonly bearerVerifier?: BearerTokenVerifier<TPrincipal>;
  readonly authenticator?: BearerTokenVerifier<TPrincipal>;
  /** Structured alias for callers that group transport authentication config. */
  readonly authentication?: AgentHostAuthenticationOptions<TPrincipal>;
  /** Short alias for authentication. */
  readonly auth?: AgentHostAuthenticationOptions<TPrincipal>;
  /** Explicitly allow anonymous connections only when set to false. */
  readonly requireAuthentication?: boolean;
  readonly authenticationRequired?: boolean;
  /** Maximum UTF-8 byte size accepted for one incoming text frame. */
  readonly maxFrameBytes?: number;
  /** Descriptive aliases for maxFrameBytes. */
  readonly frameLimitBytes?: number;
  readonly maxIncomingFrameBytes?: number;
  /** Per-connection inbound rate policy; false disables it explicitly. */
  readonly rateLimit?: AgentHostRateLimitOptions | false;
  readonly inboundRateLimit?: AgentHostRateLimitOptions | false;
  readonly maxMessagesPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly maxBytesPerWindow?: number;
  /** Bounded handler work queued behind the current frame. */
  readonly maxPendingFrames?: number;
  readonly maxQueuedFrames?: number;
  readonly pendingFrameLimit?: number;
  /** Maximum active resources tracked by the transport admission gate. */
  readonly maxSubscriptions?: number;
  readonly maxActiveSubscriptions?: number;
}

/** Explicit factory-name alias for package consumers. */
export type CreateAgentHostServerOptions<TPrincipal = unknown> = AgentHostServerOptions<TPrincipal>;

/** Protocol connection enriched by the transport authentication boundary. */
export interface TransportProtocolConnection<TPrincipal = unknown> extends ProtocolConnection {
  readonly authentication: TransportAuthenticationContext<TPrincipal>;
  /** Alias retained for handlers that call the context `auth`. */
  readonly auth: TransportAuthenticationContext<TPrincipal>;
  /** Present only for an authenticated connection. */
  readonly principal?: TPrincipal;
}

/** A small structural socket contract used by the adapter-level tests. */
export interface WebSocketTransportSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(text: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketProtocolConnectionOptions<TPrincipal = unknown> {
  readonly highWaterMarkBytes?: number;
  /** Called when the adapter has isolated a transport send failure. */
  readonly onTransportFailure?: () => void;
  readonly authentication?: TransportAuthenticationContext<TPrincipal>;
}

class SlowClientError extends Error {
  public constructor() {
    super('client output buffer exceeded high water mark');
    this.name = 'SlowClientError';
  }
}

/**
 * Adapt one ws socket to the narrow ProtocolConnection contract.
 *
 * The optional transport-failure callback lets the Fastify shell detach the
 * socket before rejecting a send, while keeping the adapter independently
 * testable and free of protocol-handler ownership.
 */
export function createWebSocketProtocolConnection(
  socket: WebSocketTransportSocket,
  id: ConnectionId,
  options: WebSocketProtocolConnectionOptions = {},
): TransportProtocolConnection {
  const highWaterMarkBytes = options.highWaterMarkBytes ?? DEFAULT_SLOW_CLIENT_HIGH_WATER_MARK_BYTES;
  assertHighWaterMark(highWaterMarkBytes);
  const authentication = options.authentication ?? Object.freeze({
    authenticated: false as const,
    scheme: 'Anonymous' as const,
  });
  const base: TransportProtocolConnection = {
    id,
    authentication,
    auth: authentication,
    ...(authentication.authenticated ? { principal: authentication.principal } : {}),
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
    send(text: string): Promise<void> {
      const buffered = assessBufferedAmount(socket.bufferedAmount, highWaterMarkBytes);
      if (socket.readyState !== 1) {
        options.onTransportFailure?.();
        return Promise.reject(new Error('WebSocket is not open'));
      }
      if (!buffered.allowed) {
        options.onTransportFailure?.();
        closeSocket(socket, SLOW_CLIENT_CLOSE_CODE, 'slow client');
        return Promise.reject(new SlowClientError());
      }

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const rejectSlowClient = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          options.onTransportFailure?.();
          closeSocket(socket, SLOW_CLIENT_CLOSE_CODE, 'slow client');
          reject(new SlowClientError());
        };
        const callback = (error?: Error): void => {
          if (settled) {
            return;
          }
          if (error != null) {
            settled = true;
            options.onTransportFailure?.();
            reject(error);
            return;
          }
          if (socket.bufferedAmount > highWaterMarkBytes) {
            rejectSlowClient();
            return;
          }
          settled = true;
          resolve();
        };

        try {
          socket.send(text, callback);
        } catch (error) {
          if (!settled) {
            settled = true;
            options.onTransportFailure?.();
            reject(error);
          }
          return;
        }

        // A deterministic adapter-level check also handles transports whose
        // send callback is delayed while their kernel buffer is already full.
        if (socket.bufferedAmount > highWaterMarkBytes) {
          rejectSlowClient();
        }
      });
    },
    close(code: number, reason: string): void {
      closeSocket(socket, code, reason);
    },
  };

  return base;
}

/** Build and configure a Fastify/WSS host without listening on any port. */
export async function createAgentHostServer(
  options: AgentHostServerOptions,
): Promise<FastifyInstance> {
  const handler = resolveHandler(options);
  const allocator = resolveAllocator(options);
  const authentication = resolveAuthentication(options);
  const frameLimitBytes = resolveFrameLimit(options);
  const rateLimit = resolveRateLimit(options);
  const maxPendingFrames = resolvePositiveLimit(
    options.maxPendingFrames ?? options.maxQueuedFrames ?? options.pendingFrameLimit ?? DEFAULT_MAX_PENDING_FRAMES,
    'maxPendingFrames',
  );
  const maxSubscriptions = resolvePositiveLimit(
    options.maxSubscriptions ?? options.maxActiveSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
    'maxSubscriptions',
  );
  const disposeHandlerOnClose = options.disposeHandlerOnClose
    ?? options.disposeHandler
    ?? options.ownsHandler
    ?? false;
  const highWaterMarkBytes = resolveHighWaterMark(options);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  assertHeartbeatInterval(heartbeatIntervalMs);
  assertHeartbeatTimeout(heartbeatTimeoutMs);
  if (heartbeatIntervalMs > 0 && heartbeatTimeoutMs < heartbeatIntervalMs) {
    throw new RangeError('heartbeatTimeoutMs must be greater than or equal to heartbeatIntervalMs');
  }
  const timer = resolveTimer(options);

  // Request logging is disabled at this shell boundary. Fastify's default
  // request log contains req.url, and a malicious/legacy client may still
  // send a credential-shaped query even though this server rejects it.
  // LogController is the non-deprecated Fastify 5 API for this setting.
  const server = Fastify({
    ...options.fastifyOptions,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const authenticatedRequests = new WeakMap<object, TransportAuthenticationContext<unknown>>();
  const liveConnections = new Map<ConnectionId, LiveTransport>();
  let heartbeatRunning = false;
  let heartbeatTimer: unknown;
  let serverClosing = false;
  let handlerDisposePromise: Promise<void> | undefined;

  const markDetached = (transport: LiveTransport): boolean => {
    if (transport.detached) {
      return false;
    }
    transport.detached = true;
    liveConnections.delete(transport.connection.id);
    transport.socket.removeListener('message', transport.onMessage);
    transport.socket.removeListener('pong', transport.onPong);
    transport.socket.removeListener('close', transport.onClose);
    transport.socket.removeListener('error', transport.onError);
    if (liveConnections.size === 0) {
      stopHeartbeat();
    }
    return true;
  };

  const detach = (transport: LiveTransport): boolean => {
    if (!markDetached(transport)) {
      return false;
    }
    try {
      handler.onConnectionClosed(transport.connection.id);
    } catch {
      // A transport lifecycle callback must not become an uncaught event error.
    }
    return true;
  };

  const closeTransport = (transport: LiveTransport, code: number, reason: string): void => {
    closeSocket(transport.socket, code, reason);
  };

  const detachAndClose = (transport: LiveTransport, code: number, reason: string): void => {
    detach(transport);
    closeTransport(transport, code, reason);
  };

  const onSocketError = (transport: LiveTransport, error: Error): void => {
    if (isPayloadTooLargeError(error)) {
      detachAndClose(transport, MESSAGE_TOO_LARGE_CLOSE_CODE, MESSAGE_TOO_LARGE_CLOSE_REASON);
    } else {
      detachAndClose(transport, 1011, 'transport error');
    }
  };

  const onSocketClose = (transport: LiveTransport): void => {
    detach(transport);
  };

  const startHeartbeat = (): void => {
    if (heartbeatIntervalMs === 0 || heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    try {
      heartbeatTimer = timer.setInterval(() => {
        const now = timer.now();
        for (const transport of [...liveConnections.values()]) {
          if (transport.detached) {
            continue;
          }
          if (now - transport.lastPongAt >= heartbeatTimeoutMs) {
            detachAndClose(transport, HEARTBEAT_TIMEOUT_CLOSE_CODE, 'heartbeat timeout');
            continue;
          }

          transport.isAlive = false;
          try {
            transport.socket.ping();
          } catch (error) {
            onSocketError(transport, error instanceof Error ? error : new Error('heartbeat failed'));
          }
        }
      }, heartbeatIntervalMs);
    } catch (error) {
      heartbeatRunning = false;
      heartbeatTimer = undefined;
      throw error;
    }
    if (typeof (heartbeatTimer as { readonly unref?: () => void } | undefined)?.unref === 'function') {
      (heartbeatTimer as { unref(): void }).unref();
    }
  };

  const stopHeartbeat = (): void => {
    if (!heartbeatRunning) {
      return;
    }
    heartbeatRunning = false;
    timer.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const closeLiveConnections = (): void => {
    if (serverClosing) {
      return;
    }
    serverClosing = true;
    stopHeartbeat();
    for (const transport of [...liveConnections.values()]) {
      detachAndClose(transport, SERVER_SHUTDOWN_CLOSE_CODE, 'server shutting down');
    }
    liveConnections.clear();
    for (const socket of server.websocketServer.clients) {
      closeSocket(socket, SERVER_SHUTDOWN_CLOSE_CODE, 'server shutting down');
    }
  };

  const disposeOwnedHandler = async (): Promise<void> => {
    if (!disposeHandlerOnClose) {
      return;
    }
    if (handlerDisposePromise === undefined) {
      handlerDisposePromise = Promise.resolve().then(async () => {
        await handler.dispose?.();
      });
    }
    try {
      await handlerDisposePromise;
    } catch {
      // Disposal belongs to an injected orchestration boundary. Transport close
      // must remain deterministic after sockets and timers have been cleaned.
    }
  };

  // Register this before @fastify/websocket so it starts the close handshake
  // before the plugin's default preClose hook calls client.close() with 1000.
  server.addHook('preClose', closeLiveConnections);

  // Credential-shaped query strings are rejected before route handling. This
  // applies to health and future HTTP routes as well as `/ws`, so a token can
  // never become an accepted URL credential by accident.
  server.addHook('onRequest', async (request, reply) => {
    if (containsCredentialQuery(request.url)) {
      sendAuthenticationFailure(reply);
      return;
    }
    if (request.url.split('?', 1)[0] !== '/ws') {
      return;
    }
    const result = await authenticateBearer({
      verifier: authentication.verifier,
      required: authentication.required,
      authorization: request.headers.authorization,
      url: request.url,
      context: {
        transport: 'websocket',
        remoteAddress: request.ip,
      },
    });
    if (!result.ok) {
      sendAuthenticationFailure(reply);
      return;
    }
    authenticatedRequests.set(request, result.context);
  });

  // This registration intentionally precedes all websocket routes. The plugin
  // installs its upgrade hook through the same Fastify router as HTTP routes.
  await server.register(fastifyWebsocket, {
    options: { maxPayload: frameLimitBytes },
  });

  server.get('/health', async () => ({
    status: 'ok',
    protocolVersions: [PROTOCOL_VERSION],
  }));

  server.get('/ws', {
    websocket: true,
  }, (socket, request) => {
    if (serverClosing) {
      closeSocket(socket, SERVER_SHUTDOWN_CLOSE_CODE, 'server shutting down');
      return;
    }

    const authenticationContext = authenticatedRequests.get(request);
    if (authenticationContext === undefined && authentication.required) {
      closeSocket(socket, AUTHENTICATION_FAILURE_CLOSE_CODE, AUTHENTICATION_FAILURE_CLOSE_REASON);
      return;
    }

    let id: ConnectionId;
    try {
      id = normalizeAllocatedConnectionId(allocator());
    } catch {
      closeSocket(socket, 1011, 'connection id allocation failed');
      return;
    }

    if (liveConnections.has(id)) {
      closeSocket(socket, 1011, 'duplicate connection id');
      return;
    }

    ensurePayloadCloseReason(socket);
    let transport: LiveTransport;
    const connection = createWebSocketProtocolConnection(socket, id, {
      highWaterMarkBytes,
      authentication: authenticationContext ?? { authenticated: false, scheme: 'Anonymous' },
      onTransportFailure: () => detach(transport),
    });
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (transport.detached || serverClosing) {
        return;
      }
      const frame = assessIncomingFrame(data, isBinary, frameLimitBytes);
      if (frame.kind === 'binary') {
        detachAndClose(transport, UNSUPPORTED_DATA_CLOSE_CODE, 'binary messages are not supported');
        return;
      }
      if (frame.kind === 'too-large') {
        detachAndClose(transport, MESSAGE_TOO_LARGE_CLOSE_CODE, MESSAGE_TOO_LARGE_CLOSE_REASON);
        return;
      }

      if (rateLimit !== undefined) {
        const rateDecision = consumeRateLimit(transport.rateLimitState, { bytes: frame.bytes }, timer.now(), rateLimit);
        if (!rateDecision.allowed) {
          detachAndClose(transport, RATE_LIMIT_CLOSE_CODE, RATE_LIMIT_CLOSE_REASON);
          return;
        }
        transport.rateLimitState = rateDecision.state;
      }

      const text = rawDataToText(data);
      const subscriptionDecision = applySubscriptionLimit(
        text,
        transport.subscriptionState,
        maxSubscriptions,
      );
      if (!subscriptionDecision.allowed) {
        detachAndClose(transport, SUBSCRIPTION_LIMIT_CLOSE_CODE, SUBSCRIPTION_LIMIT_CLOSE_REASON);
        return;
      }
      transport.subscriptionState = subscriptionDecision.state;

      const queueDecision = admitPendingFrame(transport.pendingFrames, maxPendingFrames);
      if (!queueDecision.allowed) {
        detachAndClose(transport, QUEUE_LIMIT_CLOSE_CODE, QUEUE_LIMIT_CLOSE_REASON);
        return;
      }
      transport.pendingFrames = queueDecision.pending;
      try {
        const result = handler.handle(connection, text);
        void Promise.resolve(result)
          .catch(() => {
            // ProtocolServerHandler normally absorbs request failures. Keep a
            // custom handler from creating an unhandled rejection in the callback.
            detachAndClose(transport, 1011, 'handler failed');
          })
          .finally(() => {
            transport.pendingFrames = Math.max(0, transport.pendingFrames - 1);
          });
      } catch {
        transport.pendingFrames = Math.max(0, transport.pendingFrames - 1);
        detachAndClose(transport, 1011, 'handler failed');
      }
    };
    const onPong = (): void => {
      transport.isAlive = true;
      transport.lastPongAt = timer.now();
    };
    const onClose = (): void => {
      onSocketClose(transport);
    };
    const onError = (error: Error): void => {
      onSocketError(transport, error);
    };
    transport = {
      socket,
      connection,
      detached: false,
      isAlive: true,
      lastPongAt: timer.now(),
      onMessage,
      onPong,
      onClose,
      onError,
      rateLimitState: rateLimit === undefined ? createRateLimitState(timer.now()) : createRateLimitState(timer.now()),
      subscriptionState: createSubscriptionLimitState(),
      pendingFrames: 0,
    };
    liveConnections.set(id, transport);

    // Attach all listeners synchronously, as required by @fastify/websocket.
    socket.on('message', onMessage);
    socket.on('pong', onPong);
    socket.on('close', onClose);
    socket.on('error', onError);
    startHeartbeat();
  });

  server.addHook('onClose', async () => {
    closeLiveConnections();
    await disposeOwnedHandler();
  });

  await server.ready();
  return server;
}

interface LiveTransport {
  readonly socket: WebSocketTransportSocket & {
    on(event: string, listener: (...args: any[]) => void): unknown;
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
    ping(): void;
    terminate(): void;
  };
  readonly connection: TransportProtocolConnection;
  readonly onMessage: (data: RawData, isBinary: boolean) => void;
  readonly onPong: () => void;
  readonly onClose: () => void;
  readonly onError: (error: Error) => void;
  detached: boolean;
  isAlive: boolean;
  lastPongAt: number;
  pendingFrames: number;
  rateLimitState: RateLimitState;
  subscriptionState: SubscriptionLimitState;
}

function resolveHandler(options: AgentHostServerOptions): AgentHostProtocolHandler {
  const handler = options.handler ?? options.protocolServerHandler ?? options.protocolHandler;
  if (handler === undefined) {
    throw new TypeError('handler is required');
  }
  return handler;
}

interface ResolvedAuthentication {
  readonly verifier: BearerTokenVerifier<unknown> | undefined;
  readonly required: boolean;
}

function resolveAuthentication(options: AgentHostServerOptions): ResolvedAuthentication {
  const structured = options.authentication ?? options.auth;
  const structuredVerifier = structured?.verifier
    ?? structured?.bearerTokenVerifier
    ?? structured?.verifyBearerToken
    ?? structured?.verify;
  const directVerifier = options.bearerTokenVerifier
    ?? options.verifyBearerToken
    ?? options.bearerVerifier
    ?? options.authenticator;
  if (structured !== undefined && options.authentication !== undefined && options.auth !== undefined) {
    if (resolveStructuredVerifier(options.authentication) !== resolveStructuredVerifier(options.auth)) {
      throw new TypeError('authentication and auth verifier options must match');
    }
  }
  if (structuredVerifier !== undefined && directVerifier !== undefined && structuredVerifier !== directVerifier) {
    throw new TypeError('authentication and bearer verifier options must match');
  }
  const verifier = structuredVerifier ?? directVerifier;
  const explicitRequired = options.requireAuthentication
    ?? options.authenticationRequired
    ?? structured?.required;
  if (options.requireAuthentication !== undefined && structured?.required !== undefined
    && options.requireAuthentication !== structured.required) {
    throw new TypeError('requireAuthentication and authentication.required must match');
  }
  return {
    verifier,
    required: explicitRequired ?? verifier !== undefined,
  };
}

function resolveStructuredVerifier<TPrincipal>(
  options: AgentHostAuthenticationOptions<TPrincipal>,
): BearerTokenVerifier<TPrincipal> | undefined {
  return options.verifier
    ?? options.bearerTokenVerifier
    ?? options.verifyBearerToken
    ?? options.verify;
}

function resolveFrameLimit(options: AgentHostServerOptions): number {
  const values = [options.maxFrameBytes, options.frameLimitBytes, options.maxIncomingFrameBytes]
    .filter((value): value is number => value !== undefined);
  if (values.length > 1 && values.some((value) => value !== values[0])) {
    throw new TypeError('frame limit aliases must match');
  }
  const value = values[0] ?? MAX_JSON_FRAME_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxFrameBytes must be a positive safe integer');
  }
  return value;
}

function resolveRateLimit(options: AgentHostServerOptions): RateLimitPolicy | undefined {
  const structured = options.rateLimit ?? options.inboundRateLimit;
  if (options.rateLimit !== undefined && options.inboundRateLimit !== undefined
    && options.rateLimit !== options.inboundRateLimit) {
    throw new TypeError('rateLimit and inboundRateLimit must match');
  }
  if (structured === false) {
    return undefined;
  }
  const policy = structured ?? {};
  const maxMessages = policy.maxMessages
    ?? policy.maxFrames
    ?? policy.maxRequests
    ?? policy.requestsPerWindow
    ?? options.maxMessagesPerWindow
    ?? DEFAULT_RATE_LIMIT_MAX_MESSAGES;
  const windowMs = policy.windowMs
    ?? policy.intervalMs
    ?? options.rateWindowMs
    ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxBytes = policy.maxBytes
    ?? policy.bytesPerWindow
    ?? options.maxBytesPerWindow;
  const resolved = { maxMessages, windowMs, ...(maxBytes === undefined ? {} : { maxBytes }) };
  assertRatePolicy(resolved);
  return Object.freeze(resolved);
}

function assertRatePolicy(policy: RateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.maxMessages) || policy.maxMessages <= 0) {
    throw new RangeError('rate limit maxMessages must be a positive safe integer');
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
    throw new RangeError('rate limit windowMs must be a positive safe integer');
  }
  if (policy.maxBytes !== undefined && (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0)) {
    throw new RangeError('rate limit maxBytes must be a positive safe integer');
  }
}

function resolvePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sendAuthenticationFailure(reply: FastifyReply): void {
  // Keep status, body and content type constant across missing/malformed/
  // invalid/verifier-error credentials. Never include a verifier error or the
  // bearer value in a response.
  void reply
    .code(AUTHENTICATION_FAILURE_STATUS)
    .header('www-authenticate', 'Bearer')
    .header('cache-control', 'no-store')
    .type('application/json')
    .send(safeAuthenticationFailureBody());
}

function resolveAllocator(options: AgentHostServerOptions): ConnectionIdAllocator {
  const allocator = options.connectionIdAllocator ?? options.allocateConnectionId ?? options.connectionId;
  return allocator ?? (() => randomUUID());
}

function resolveHighWaterMark(options: AgentHostServerOptions): number {
  const preferred = options.highWaterMarkBytes;
  const alias = options.slowClientHighWaterMarkBytes;
  if (preferred !== undefined && alias !== undefined && preferred !== alias) {
    throw new TypeError('highWaterMarkBytes and slowClientHighWaterMarkBytes must match');
  }
  const value = preferred ?? alias ?? DEFAULT_SLOW_CLIENT_HIGH_WATER_MARK_BYTES;
  assertHighWaterMark(value);
  return value;
}

function normalizeAllocatedConnectionId(value: ConnectionId | string): ConnectionId {
  if (typeof value !== 'string') {
    throw new TypeError('connection allocator must return a string');
  }
  return createConnectionId(value);
}

function assertHighWaterMark(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('highWaterMarkBytes must be a non-negative safe integer');
  }
}

function assertHeartbeatInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('heartbeatIntervalMs must be a non-negative safe integer');
  }
}

function assertHeartbeatTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('heartbeatTimeoutMs must be a positive safe integer');
  }
}

function resolveTimer(options: AgentHostServerOptions): AgentHostTimer {
  if (options.timer !== undefined) {
    return options.timer;
  }
  return {
    now: options.clock ?? (() => Date.now()),
    setInterval: options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds)),
    clearInterval: options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)),
  };
}

function ensurePayloadCloseReason(socket: WsWebSocket): void {
  const originalClose = socket.close.bind(socket);
  socket.close = ((code?: number, reason?: string | Buffer) => {
    if (code === MESSAGE_TOO_LARGE_CLOSE_CODE && reason === undefined) {
      return originalClose(code, MESSAGE_TOO_LARGE_CLOSE_REASON);
    }
    return originalClose(code, reason);
  }) as WsWebSocket['close'];
}

function closeSocket(socket: { readyState: number; close(code?: number, reason?: string): void }, code: number, reason: string): void {
  if (socket.readyState === 3) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    // Closing a socket is best effort during error/lifecycle paths.
  }
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

function isPayloadTooLargeError(error: Error & { readonly code?: string }): boolean {
  return error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' || error.message === 'Max payload size exceeded';
}
