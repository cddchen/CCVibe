import type { JsonValue } from '../domain/types';
import { encodeJsonRpcEnvelope, parseJsonRpcEnvelope, type JsonRpcFailure, type JsonRpcId } from '../protocol/jsonRpc';
import { parseHostNotification, type HostNotification } from '../protocol/hostWire';
import { systemTimer, type TimerPort } from './timer';

export interface SocketLike {
  readonly readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
}

export interface SocketFactoryOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export type SocketFactory = (url: string, options: SocketFactoryOptions) => SocketLike;

export interface JsonRpcTransportOptions {
  readonly address: string;
  readonly token: string;
  readonly socketFactory: SocketFactory;
  readonly timer?: TimerPort;
  readonly requestTimeoutMs?: number;
  readonly createRequestId?: () => JsonRpcId;
  readonly onProtocolError?: (error: TransportProtocolError) => void;
}

export interface JsonRpcTransportPort {
  open(): Promise<void>;
  request(method: string, params?: JsonValue): Promise<JsonValue>;
  onEvent(listener: (event: HostNotification) => void): () => void;
  onStatus(listener: (status: TransportStatusEvent) => void): () => void;
  close(code?: number, reason?: string): void;
}

export type TransportStatusEvent =
  | { readonly type: 'closed'; readonly code: number; readonly reason: string }
  | { readonly type: 'error' };

export class TransportRpcError extends Error {
  public readonly kind = 'rpc' as const;
  public readonly code: number;
  public readonly data: JsonValue | undefined;

  public constructor(error: JsonRpcFailure['error']) {
    super(error.message);
    this.name = 'TransportRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class TransportTimeoutError extends Error {
  public readonly kind = 'timeout' as const;
  public readonly method: string;
  public readonly id: JsonRpcId;

  public constructor(method: string, id: JsonRpcId) {
    super(`RPC request timed out: ${method}`);
    this.name = 'TransportTimeoutError';
    this.method = method;
    this.id = id;
  }
}

export class TransportClosedError extends Error {
  public readonly kind = 'closed' as const;
  public readonly code: number;
  public readonly reason: string;

  public constructor(code: number, reason: string) {
    super('WebSocket closed');
    this.name = 'TransportClosedError';
    this.code = code;
    this.reason = reason;
  }
}

export class TransportNotOpenError extends Error {
  public readonly kind = 'not_open' as const;

  public constructor() {
    super('WebSocket is not open');
    this.name = 'TransportNotOpenError';
  }
}

export class TransportConnectionError extends Error {
  public readonly kind = 'connection' as const;

  public constructor() {
    super('WebSocket connection failed');
    this.name = 'TransportConnectionError';
  }
}

export class TransportProtocolError extends Error {
  public readonly kind = 'protocol' as const;

  public constructor() {
    super('invalid protocol message');
    this.name = 'TransportProtocolError';
  }
}

interface PendingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  timeoutHandle: unknown;
}

const OPEN = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class JsonRpcTransport implements JsonRpcTransportPort {
  private readonly address: string;
  private readonly token: string;
  private readonly socketFactory: SocketFactory;
  private readonly timer: TimerPort;
  private readonly requestTimeoutMs: number;
  private readonly createRequestId: () => JsonRpcId;
  private readonly onProtocolError: ((error: TransportProtocolError) => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: HostNotification) => void>();
  private readonly statusListeners = new Set<(status: TransportStatusEvent) => void>();
  private socket: SocketLike | undefined;
  private opening: Promise<void> | undefined;
  private openingResolve: (() => void) | undefined;
  private openingReject: ((error: Error) => void) | undefined;
  private closed = false;

  public constructor(options: JsonRpcTransportOptions) {
    if (options.token.trim().length === 0) {
      throw new TypeError('transport token is required');
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) || (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) <= 0) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer');
    }
    this.address = options.address;
    this.token = options.token;
    this.socketFactory = options.socketFactory;
    this.timer = options.timer ?? systemTimer;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? defaultRequestId;
    this.onProtocolError = options.onProtocolError;
  }

  public open(): Promise<void> {
    if (this.isOpen()) {
      return Promise.resolve();
    }
    if (this.opening !== undefined) {
      return this.opening;
    }
    this.closed = false;
    this.opening = new Promise<void>((resolve, reject) => {
      this.openingResolve = resolve;
      this.openingReject = reject;
    });
    try {
      const socket = this.socketFactory(this.address, {
        headers: Object.freeze({ Authorization: `Bearer ${this.token}` }),
      });
      this.socket = socket;
      socket.onopen = () => this.handleOpen();
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => this.handleError();
      socket.onclose = (event) => this.handleClose(event.code, event.reason);
    } catch {
      this.handleError();
    }
    return this.opening;
  }

  public request(method: string, params?: JsonValue): Promise<JsonValue> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== OPEN || this.closed) {
      return Promise.reject(new TransportNotOpenError());
    }

    const id = this.createRequestId();
    const key = idKey(id);
    if (this.pending.has(key)) {
      return Promise.reject(new Error('duplicate JSON-RPC request id'));
    }

    const request = params === undefined
      ? { jsonrpc: '2.0' as const, id, method }
      : { jsonrpc: '2.0' as const, id, method, params };
    const encoded = encodeJsonRpcEnvelope(request);
    return new Promise<JsonValue>((resolve, reject) => {
      const pending: PendingRequest = { id, method, resolve, reject, timeoutHandle: undefined };
      pending.timeoutHandle = this.timer.setTimeout(() => {
        if (!this.pending.delete(key)) return;
        reject(new TransportTimeoutError(method, id));
      }, this.requestTimeoutMs);
      this.pending.set(key, pending);
      try {
        socket.send(encoded);
      } catch (error) {
        this.settlePending(key, undefined, errorToError(error));
      }
    });
  }

  public onEvent(listener: (event: HostNotification) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public onStatus(listener: (status: TransportStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public close(code = 1000, reason = 'client closed'): void {
    this.closed = true;
    const socket = this.socket;
    if (socket === undefined) {
      this.handleClose(code, reason);
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      this.handleClose(code, reason);
    }
  }

  private isOpen(): boolean {
    return this.socket?.readyState === OPEN && !this.closed;
  }

  private handleOpen(): void {
    this.closed = false;
    const resolve = this.openingResolve;
    this.opening = undefined;
    this.openingResolve = undefined;
    this.openingReject = undefined;
    resolve?.();
  }

  private handleError(): void {
    const reject = this.openingReject;
    this.opening = undefined;
    this.openingResolve = undefined;
    this.openingReject = undefined;
    reject?.(new TransportConnectionError());
    this.notifyStatus({ type: 'error' });
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    this.socket = undefined;
    const reject = this.openingReject;
    this.opening = undefined;
    this.openingResolve = undefined;
    this.openingReject = undefined;
    reject?.(new TransportClosedError(code, reason));
    const error = new TransportClosedError(code, reason);
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      this.timer.clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
    this.notifyStatus({ type: 'closed', code, reason });
  }

  private handleMessage(input: unknown): void {
    const parsed = parseJsonRpcEnvelope(input);
    if (!parsed.ok) {
      this.reportProtocolError();
      return;
    }
    const value = parsed.value;
    if ('id' in value && ('result' in value || 'error' in value)) {
      if (value.id === null) return;
      const key = idKey(value.id);
      const pending = this.pending.get(key);
      if (pending === undefined) return;
      if ('error' in value) {
        this.settlePending(key, undefined, new TransportRpcError(value.error));
      } else {
        this.settlePending(key, value.result, undefined);
      }
      return;
    }
    if ('method' in value && !('id' in value)) {
      try {
        const event = parseHostNotification(value);
        if (event !== undefined) {
          for (const listener of [...this.eventListeners]) listener(event);
        }
      } catch {
        this.reportProtocolError();
      }
    }
  }

  private settlePending(key: string, value: JsonValue | undefined, error: Error | undefined): void {
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    this.timer.clearTimeout(pending.timeoutHandle);
    if (error === undefined && value !== undefined) {
      pending.resolve(value);
    } else {
      pending.reject(error ?? new Error('RPC result is missing'));
    }
  }

  private reportProtocolError(): void {
    const error = new TransportProtocolError();
    try {
      this.onProtocolError?.(error);
    } catch {
      // A diagnostic listener cannot change transport lifecycle.
    }
  }

  private notifyStatus(status: TransportStatusEvent): void {
    for (const listener of [...this.statusListeners]) listener(status);
  }
}

export function createReactNativeSocketFactory(): SocketFactory {
  const constructor = globalThis.WebSocket as unknown as {
    new (url: string, protocols?: readonly string[], options?: { readonly headers?: Readonly<Record<string, string>> }): SocketLike;
  };
  return (url, options) => new constructor(url, [], options);
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

let fallbackRequestId = 0;

function defaultRequestId(): string {
  fallbackRequestId += 1;
  return `rpc-${fallbackRequestId}`;
}

function errorToError(error: unknown): Error {
  return error instanceof Error ? error : new Error('WebSocket send failed');
}
