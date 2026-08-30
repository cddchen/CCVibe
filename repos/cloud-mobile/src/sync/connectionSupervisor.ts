import type { ConnectionConfig, JsonValue } from '../domain/types';
import { normalizeConnectionConfig } from '../protocol/connectionAddress';
import {
  parseHostInitializeResult,
  parseHostReconnectResult,
  parseHostCreateChatResult,
  parseHostDispatchActionResult,
  parseHostInteractionResolutionResult,
  parseHostSubscribeResult,
  parseHostUnsubscribeResult,
  type HostCreateChatParams,
  type HostCreateChatResult,
  type HostDispatchActionParams,
  type HostDispatchActionResult,
  type HostResolveApprovalParams,
  type HostResolveInputParams,
  type HostInteractionResolutionResult,
  type HostNotification,
} from '../protocol/hostWire';
import { parseResourceUri } from '../protocol/resourceUri';
import {
  applyJitter,
  calculateBackoffDelay,
  defaultBackoffPolicy,
  type BackoffPolicy,
} from './backoff';
import {
  createReactNativeSocketFactory,
  JsonRpcTransport,
  type JsonRpcTransportPort,
  type TransportStatusEvent,
  TransportRpcError,
} from './transport';
import {
  createSyncStore,
  type SyncConnectionStatus,
  type SyncState,
  type SyncStore,
} from './syncState';
import { systemTimer, type TimerPort } from './timer';

export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'unknown';

export interface AppStatePort {
  currentState(): AppLifecycleState;
  subscribe(listener: (state: AppLifecycleState) => void): () => void;
}

export interface TransportFactoryContext {
  readonly timer: TimerPort;
}

export type TransportFactory = (
  config: ConnectionConfig,
  context: TransportFactoryContext,
) => JsonRpcTransportPort;

export interface ConnectionSupervisorOptions {
  readonly config: ConnectionConfig;
  readonly clientId: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
    readonly platform: 'ios' | 'android' | 'web' | 'unknown';
  };
  readonly store?: SyncStore;
  readonly initialSubscriptions?: readonly string[];
  readonly capabilities?: {
    readonly partialBlocks: boolean;
    readonly approvalEdits: boolean;
  };
  readonly timer?: TimerPort;
  readonly appState: AppStatePort;
  readonly backoff?: BackoffPolicy | ((attempt: number) => number);
  readonly jitter?: ((delayMs: number, attempt: number) => number);
  readonly transportFactory?: TransportFactory;
}

const CLIENT_REPLACED_CODE = -32003;
const RESOURCE_NOT_FOUND_CODE = -32004;
const INVALID_HOST_EPOCH_CODE = -32006;

export class ConnectionSupervisor {
  private readonly config: ConnectionConfig;
  private readonly clientId: string;
  private readonly clientInfo: ConnectionSupervisorOptions['clientInfo'];
  private readonly capabilities: NonNullable<ConnectionSupervisorOptions['capabilities']>;
  private readonly timer: TimerPort;
  private readonly appState: AppStatePort;
  private readonly backoff: BackoffPolicy | ((attempt: number) => number);
  private readonly jitter: (delayMs: number, attempt: number) => number;
  private readonly transportFactory: TransportFactory;
  private readonly store: SyncStore;
  private readonly initialSubscriptions: readonly string[];
  private transport: JsonRpcTransportPort | undefined;
  private transportGeneration = 0;
  private removeTransportEventListener: (() => void) | undefined;
  private removeTransportStatusListener: (() => void) | undefined;
  private removeAppStateListener: (() => void) | undefined;
  private retryHandle: unknown;
  private attempt = 0;
  private started = false;
  private replacementLocked = false;

  public constructor(options: ConnectionSupervisorOptions) {
    this.config = normalizeConnectionConfig(options.config);
    if (typeof options.clientId !== 'string' || options.clientId.trim().length === 0) {
      throw new TypeError('clientId is required');
    }
    this.clientId = options.clientId;
    this.clientInfo = Object.freeze({ ...options.clientInfo });
    this.capabilities = Object.freeze(options.capabilities ?? { partialBlocks: true, approvalEdits: true });
    this.timer = options.timer ?? systemTimer;
    this.appState = options.appState;
    this.backoff = options.backoff ?? defaultBackoffPolicy;
    this.jitter = options.jitter ?? ((delayMs) => applyJitter(delayMs, Math.random));
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
    this.initialSubscriptions = freezeSubscriptions(options.initialSubscriptions ?? ['agent-root://']);
    this.store = options.store ?? createSyncStore({
      address: this.config.address,
      subscriptions: this.initialSubscriptions,
    });
  }

  public getState(): SyncState {
    return this.store.getState();
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.replacementLocked = false;
    this.removeAppStateListener = this.appState.subscribe((state) => this.handleAppState(state));
    if (this.appState.currentState() === 'active') {
      this.beginConnection();
    } else {
      this.dispatchStatus('paused');
    }
  }

  public stop(): void {
    this.started = false;
    this.replacementLocked = false;
    this.clearRetry();
    this.removeAppStateListener?.();
    this.removeAppStateListener = undefined;
    this.detachTransport(true);
    this.dispatchStatus('idle');
  }

  /** Explicit user action for a client/replaced state. */
  public retryNow(): void {
    if (!this.started || this.appState.currentState() !== 'active') return;
    this.replacementLocked = false;
    this.attempt = 0;
    this.clearRetry();
    this.detachTransport(true);
    this.beginConnection();
  }

  public async subscribe(resourceValue: string): Promise<void> {
    const resource = parseResourceUri(resourceValue).uri;
    const transport = this.requireTransport();
    const result = parseHostSubscribeResult(await transport.request('subscribe', { channel: resource }));
    if (result.snapshot.resource !== resource) {
      throw new TypeError('subscribe response resource does not match request');
    }
    this.store.dispatch({ type: 'subscription/succeeded', snapshot: result.snapshot });
  }

  public async unsubscribe(resourceValue: string): Promise<boolean> {
    const resource = parseResourceUri(resourceValue).uri;
    const transport = this.requireTransport();
    const result = parseHostUnsubscribeResult(await transport.request('unsubscribe', { channel: resource }));
    this.store.dispatch({ type: 'subscription/removed', resource });
    return result.removed;
  }

  public async createChat(params: HostCreateChatParams): Promise<HostCreateChatResult> {
    const transport = this.requireTransport();
    const raw = await transport.request('catalog/createChat', params as unknown as JsonValue);
    return parseHostCreateChatResult(raw);
  }

  public async dispatchAction(params: HostDispatchActionParams): Promise<HostDispatchActionResult> {
    const transport = this.requireTransport();
    const raw = await transport.request('dispatchAction', params as unknown as JsonValue);
    return parseHostDispatchActionResult(raw);
  }

  public async resolveApproval(params: HostResolveApprovalParams): Promise<HostInteractionResolutionResult> {
    const transport = this.requireTransport();
    const raw = await transport.request('chat/resolveApproval', params as unknown as JsonValue);
    return parseHostInteractionResolutionResult(raw);
  }

  public async resolveInput(params: HostResolveInputParams): Promise<HostInteractionResolutionResult> {
    const transport = this.requireTransport();
    const raw = await transport.request('chat/resolveInput', params as unknown as JsonValue);
    return parseHostInteractionResolutionResult(raw);
  }

  private beginConnection(): void {
    if (!this.started || this.appState.currentState() !== 'active' || this.transport !== undefined || this.retryHandle !== undefined || this.replacementLocked) {
      return;
    }
    this.clearRetry();
    const generation = ++this.transportGeneration;
    const state = this.store.getState();
    const isReconnect = state.hostEpoch !== undefined;
    this.dispatchStatus(isReconnect ? 'reconnecting' : 'connecting');
    let transport: JsonRpcTransportPort;
    try {
      transport = this.transportFactory(this.config, { timer: this.timer });
    } catch {
      this.handleConnectionFailure(generation, undefined, 'FACTORY');
      return;
    }
    this.transport = transport;
    this.removeTransportEventListener = transport.onEvent((event) => this.handleTransportEvent(generation, transport, event));
    this.removeTransportStatusListener = transport.onStatus((status) => this.handleTransportStatus(generation, transport, status));
    void this.runConnection(generation, transport, isReconnect);
  }

  private async runConnection(
    generation: number,
    transport: JsonRpcTransportPort,
    reconnect: boolean,
  ): Promise<void> {
    try {
      await transport.open();
      if (!this.isCurrent(generation, transport)) return;
      const state = this.store.getState();
      if (reconnect && state.hostEpoch !== undefined) {
        try {
          const raw = await transport.request('reconnect', {
            channel: 'agent-root://',
            clientId: this.clientId,
            hostEpoch: state.hostEpoch,
            lastSeenServerSeq: state.lastSeenServerSeq,
            subscriptions: state.subscriptions,
          });
          const result = parseHostReconnectResult(raw);
          if (!this.isCurrent(generation, transport)) return;
          this.store.dispatch({ type: 'reconnect/succeeded', result });
        } catch (error) {
          if (!isColdStartRequired(error)) throw error;
          await this.initializeTransport(generation, transport);
        }
      } else {
        await this.initializeTransport(generation, transport);
      }
      this.attempt = 0;
      this.replacementLocked = false;
      this.dispatchStatus('connected');
    } catch (error) {
      if (!this.isCurrent(generation, transport)) return;
      const code = error instanceof TransportRpcError && error.code === CLIENT_REPLACED_CODE
        ? 'CLIENT_REPLACED'
        : errorCode(error);
      if (code === 'CLIENT_REPLACED') {
        this.replacementLocked = true;
        this.dispatchStatus('replaced', code);
        this.detachTransport(true);
      } else {
        this.handleConnectionFailure(generation, transport, code);
      }
    }
  }

  private async initializeTransport(
    generation: number,
    transport: JsonRpcTransportPort,
  ): Promise<void> {
    const raw = await transport.request('initialize', {
      channel: 'agent-root://',
      protocolVersions: ['1.0.0'],
      clientId: this.clientId,
      clientInfo: this.clientInfo,
      capabilities: this.capabilities,
      initialSubscriptions: this.initialSubscriptions,
    });
    const result = parseHostInitializeResult(raw);
    if (!this.isCurrent(generation, transport)) return;
    this.store.dispatch({
      type: 'initialize/succeeded',
      result,
      requestedSubscriptions: this.initialSubscriptions,
    });
  }

  private handleTransportEvent(generation: number, transport: JsonRpcTransportPort, event: HostNotification): void {
    if (!this.isCurrent(generation, transport)) return;
    if (event.type === 'state/action') {
      this.store.dispatch({ type: 'state/action', envelope: event.envelope });
      return;
    }
    this.replacementLocked = true;
    this.clearRetry();
    this.store.dispatch({ type: 'client/replaced', reason: event.reason });
    this.detachTransport(true);
  }

  private handleTransportStatus(generation: number, transport: JsonRpcTransportPort, status: TransportStatusEvent): void {
    if (!this.isCurrent(generation, transport)) return;
    if (status.type === 'closed') {
      this.handleConnectionFailure(generation, transport, `CLOSED_${status.code}`);
    } else if (this.store.getState().status === 'connected') {
      this.handleConnectionFailure(generation, transport, 'TRANSPORT');
    }
  }

  private handleConnectionFailure(generation: number, transport: JsonRpcTransportPort | undefined, code: string): void {
    if (!this.started || generation !== this.transportGeneration || (transport !== undefined && transport !== this.transport)) return;
    this.detachTransport(true);
    if (this.appState.currentState() !== 'active') {
      this.dispatchStatus('paused', code);
      return;
    }
    this.dispatchStatus('error', code);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.started || this.replacementLocked || this.appState.currentState() !== 'active' || this.retryHandle !== undefined) return;
    const attempt = this.attempt;
    this.attempt += 1;
    const baseDelay = typeof this.backoff === 'function'
      ? this.backoff(attempt)
      : calculateBackoffDelay(attempt, this.backoff);
    const delay = this.jitter(baseDelay, attempt);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError('jitter must return a non-negative finite delay');
    }
    this.dispatchStatus('reconnecting');
    this.retryHandle = this.timer.setTimeout(() => {
      this.retryHandle = undefined;
      this.beginConnection();
    }, Math.round(delay));
  }

  private handleAppState(state: AppLifecycleState): void {
    if (!this.started) return;
    if (state !== 'active') {
      this.clearRetry();
      this.detachTransport(true);
      this.dispatchStatus('paused');
      return;
    }
    if (!this.replacementLocked && this.transport === undefined && this.retryHandle === undefined) {
      this.beginConnection();
    }
  }

  private requireTransport(): JsonRpcTransportPort {
    if (this.transport === undefined || this.store.getState().status !== 'connected') {
      throw new Error('connection is not ready');
    }
    return this.transport;
  }

  private isCurrent(generation: number, transport: JsonRpcTransportPort): boolean {
    return this.started && generation === this.transportGeneration && this.transport === transport;
  }

  private detachTransport(close: boolean): void {
    const transport = this.transport;
    this.transport = undefined;
    this.removeTransportEventListener?.();
    this.removeTransportEventListener = undefined;
    this.removeTransportStatusListener?.();
    this.removeTransportStatusListener = undefined;
    if (close && transport !== undefined) {
      try {
        transport.close(1000, 'connection supervisor detached');
      } catch {
        // Closing an already failed socket is best effort.
      }
    }
  }

  private clearRetry(): void {
    if (this.retryHandle !== undefined) {
      this.timer.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
  }

  private dispatchStatus(status: SyncConnectionStatus, errorCode?: string): void {
    this.store.dispatch({
      type: 'connection/status',
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
      updatedAt: new Date(this.timer.now()).toISOString(),
    });
  }
}

function defaultTransportFactory(config: ConnectionConfig, context: TransportFactoryContext): JsonRpcTransportPort {
  return new JsonRpcTransport({
    address: config.address,
    token: config.token,
    socketFactory: createReactNativeSocketFactory(),
    timer: context.timer,
  });
}

function freezeSubscriptions(values: readonly string[]): readonly string[] {
  return Object.freeze(values.map((value) => parseResourceUri(value).uri));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TransportTimeoutError') return 'TIMEOUT';
  if (error instanceof Error && error.name === 'TransportConnectionError') return 'CONNECTION';
  if (error instanceof Error && error.name === 'TransportClosedError') return 'CLOSED';
  if (error instanceof Error && error.name === 'TransportProtocolError') return 'PROTOCOL';
  return 'UNKNOWN';
}

function isColdStartRequired(error: unknown): boolean {
  return error instanceof TransportRpcError
    && (error.code === RESOURCE_NOT_FOUND_CODE || error.code === INVALID_HOST_EPOCH_CODE);
}

export function createReactNativeAppStatePort(nativeAppState: {
  readonly currentState: string;
  addEventListener(event: 'change', listener: (state: string) => void): { remove(): void };
}): AppStatePort {
  return Object.freeze({
    currentState: () => normalizeAppState(nativeAppState.currentState),
    subscribe: (listener: (state: AppLifecycleState) => void) => {
      const subscription = nativeAppState.addEventListener('change', (state) => listener(normalizeAppState(state)));
      return () => subscription.remove();
    },
  });
}

function normalizeAppState(value: string): AppLifecycleState {
  return value === 'active' || value === 'background' || value === 'inactive' ? value : 'unknown';
}
