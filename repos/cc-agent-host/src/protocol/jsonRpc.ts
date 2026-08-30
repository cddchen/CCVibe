import { MAX_JSON_FRAME_BYTES, MAX_METHOD_NAME_BYTES, utf8ByteLength } from './limits.js';

export const JSON_RPC_VERSION = '2.0' as const;
export { MAX_JSON_FRAME_BYTES };

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError;
}

export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params?: P;
}

export type JsonRpcMessage<P = unknown> = JsonRpcRequest<P> | JsonRpcNotification<P>;
export type ParsedJsonRpcRequest = JsonRpcRequest<unknown> | JsonRpcFailure;
export type ParsedJsonRpcNotification = JsonRpcNotification<unknown> | JsonRpcFailure;

export const JSON_RPC_ERROR_CODES = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotInitialized: -32001,
  UnsupportedProtocol: -32002,
  ClientReplaced: -32003,
  ResourceNotFound: -32004,
  CommandRejected: -32005,
  InvalidHostEpoch: -32006,
  /** Authorization failures deliberately have one stable public shape. */
  AuthorizationDenied: -32007,
} as const);

export const JSON_RPC_ERRORS = Object.freeze({
  ParseError: Object.freeze({ code: JSON_RPC_ERROR_CODES.ParseError, message: 'Parse error' }),
  InvalidRequest: Object.freeze({ code: JSON_RPC_ERROR_CODES.InvalidRequest, message: 'Invalid Request' }),
  MethodNotFound: Object.freeze({ code: JSON_RPC_ERROR_CODES.MethodNotFound, message: 'Method not found' }),
  InvalidParams: Object.freeze({ code: JSON_RPC_ERROR_CODES.InvalidParams, message: 'Invalid params' }),
  InternalError: Object.freeze({ code: JSON_RPC_ERROR_CODES.InternalError, message: 'Internal error' }),
  NotInitialized: Object.freeze({ code: JSON_RPC_ERROR_CODES.NotInitialized, message: 'Not initialized' }),
  UnsupportedProtocol: Object.freeze({ code: JSON_RPC_ERROR_CODES.UnsupportedProtocol, message: 'Unsupported protocol' }),
  ClientReplaced: Object.freeze({ code: JSON_RPC_ERROR_CODES.ClientReplaced, message: 'Client replaced' }),
  ResourceNotFound: Object.freeze({ code: JSON_RPC_ERROR_CODES.ResourceNotFound, message: 'Resource not found' }),
  CommandRejected: Object.freeze({ code: JSON_RPC_ERROR_CODES.CommandRejected, message: 'Command rejected' }),
  InvalidHostEpoch: Object.freeze({ code: JSON_RPC_ERROR_CODES.InvalidHostEpoch, message: 'Invalid host epoch' }),
  /** Never attach a resource, principal, tenant, or policy reason here. */
  AuthorizationDenied: Object.freeze({
    code: JSON_RPC_ERROR_CODES.AuthorizationDenied,
    message: 'Authorization denied',
  }),
} as const);

export type JsonRpcErrorName = keyof typeof JSON_RPC_ERRORS;
export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];
export type JsonRpcErrorDescriptor = Readonly<Pick<JsonRpcError, 'code' | 'message'>>;

export function successResponse<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function errorResponse(
  id: JsonRpcId | null,
  error: JsonRpcErrorDescriptor,
  data?: unknown,
): JsonRpcFailure;
export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure;
export function errorResponse(
  id: JsonRpcId | null,
  errorOrCode: JsonRpcErrorDescriptor | number,
  messageOrData?: string | unknown,
  maybeData?: unknown,
): JsonRpcFailure {
  const code = typeof errorOrCode === 'number' ? errorOrCode : errorOrCode.code;
  const message = typeof errorOrCode === 'number' ? String(messageOrData) : errorOrCode.message;
  const data = typeof errorOrCode === 'number' ? maybeData : messageOrData;
  const error: JsonRpcError = data === undefined ? { code, message } : { code, message, data };

  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  };
}

export function notification<P>(method: string, params?: P): JsonRpcNotification<P> {
  return params === undefined
    ? { jsonrpc: JSON_RPC_VERSION, method }
    : { jsonrpc: JSON_RPC_VERSION, method, params };
}

export function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { readonly error?: unknown };
  return typeof candidate.error === 'object' && candidate.error !== null;
}

/**
 * Parse a client request without throwing. Notifications are intentionally not
 * accepted here: every client request must carry a string or numeric id.
 *
 * The returned failure only contains a stable JSON-RPC error. It never echoes
 * the input frame, a Zod error, a stack, or a parser exception.
 */
export function parseJsonRpcMessage(text: string): ParsedJsonRpcRequest {
  return parseJsonRpcEnvelope(text, 'request') as ParsedJsonRpcRequest;
}

/** Parse a client request under an explicit name. */
export function parseJsonRpcRequest(text: string): ParsedJsonRpcRequest {
  return parseJsonRpcMessage(text);
}

/** Parse a server-style notification when a transport needs to validate one. */
export function parseJsonRpcNotification(text: string): ParsedJsonRpcNotification {
  return parseJsonRpcEnvelope(text, 'notification') as ParsedJsonRpcNotification;
}

function parseJsonRpcEnvelope(
  text: string,
  kind: 'request' | 'notification',
): JsonRpcRequest<unknown> | JsonRpcNotification<unknown> | JsonRpcFailure {
  if (typeof text !== 'string' || utf8ByteLength(text) > MAX_JSON_FRAME_BYTES) {
    return errorResponse(null, JSON_RPC_ERRORS.ParseError);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(null, JSON_RPC_ERRORS.ParseError);
  }

  if (hasDuplicateObjectKeys(text)) {
    return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
  }

  if (!isRecord(parsed) || !hasOnlyKeys(parsed, kind === 'request' ? REQUEST_KEYS : NOTIFICATION_KEYS)) {
    return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
  }

  if (
    parsed.jsonrpc !== JSON_RPC_VERSION ||
    typeof parsed.method !== 'string' ||
    parsed.method.length === 0 ||
    utf8ByteLength(parsed.method) > MAX_METHOD_NAME_BYTES
  ) {
    return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
  }

  const hasId = hasOwn(parsed, 'id');
  if (kind === 'request') {
    if (!hasId || !isJsonRpcId(parsed.id)) {
      return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
    }
  } else if (hasId) {
    return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
  }

  if (hasOwn(parsed, 'params') && !isStructuredParams(parsed.params)) {
    return errorResponse(null, JSON_RPC_ERRORS.InvalidRequest);
  }

  if (kind === 'request') {
    const request: JsonRpcRequest<unknown> = {
      jsonrpc: JSON_RPC_VERSION,
      id: parsed.id as JsonRpcId,
      method: parsed.method,
    };
    return hasOwn(parsed, 'params') ? { ...request, params: parsed.params } : request;
  }

  const serverNotification: JsonRpcNotification<unknown> = {
    jsonrpc: JSON_RPC_VERSION,
    method: parsed.method,
  };
  return hasOwn(parsed, 'params') ? { ...serverNotification, params: parsed.params } : serverNotification;
}

const REQUEST_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);
const NOTIFICATION_KEYS = new Set(['jsonrpc', 'method', 'params']);

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' || typeof value === 'number') && (typeof value !== 'number' || Number.isFinite(value));
}

function isStructuredParams(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * JSON.parse keeps the last value for duplicate object keys. The protocol
 * rejects that ambiguity, so scan the already-valid JSON for duplicate names.
 */
function hasDuplicateObjectKeys(text: string): boolean {
  let index = 0;

  try {
    const duplicate = parseValue();
    if (duplicate) {
      return true;
    }
    skipWhitespace();
    return false;
  } catch {
    // JSON.parse already classified malformed syntax as a parse error. This
    // scanner only runs after JSON.parse succeeds, so malformed scanner input
    // is conservatively treated as having no duplicate keys.
    return false;
  }

  function parseValue(): boolean {
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      return parseObject();
    }
    if (character === '[') {
      return parseArray();
    }
    if (character === '"') {
      parseString();
      return false;
    }
    return parsePrimitive();
  }

  function parseObject(): boolean {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[index] === '}') {
      index += 1;
      return false;
    }

    while (true) {
      skipWhitespace();
      if (text[index] !== '"') {
        throw new Error('object key expected');
      }
      const key = parseString();
      if (keys.has(key)) {
        return true;
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') {
        throw new Error('object colon expected');
      }
      index += 1;
      if (parseValue()) {
        return true;
      }
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return false;
      }
      if (text[index] !== ',') {
        throw new Error('object separator expected');
      }
      index += 1;
    }
  }

  function parseArray(): boolean {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return false;
    }

    while (true) {
      if (parseValue()) {
        return true;
      }
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return false;
      }
      if (text[index] !== ',') {
        throw new Error('array separator expected');
      }
      index += 1;
    }
  }

  function parseString(): string {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error('unterminated string');
  }

  function parsePrimitive(): boolean {
    const remainder = text.slice(index);
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remainder);
    if (match === null) {
      throw new Error('primitive expected');
    }
    index += match[0].length;
    return false;
  }

  function skipWhitespace(): void {
    while (index < text.length && /[\t\n\r ]/u.test(text[index] ?? '')) {
      index += 1;
    }
  }
}
