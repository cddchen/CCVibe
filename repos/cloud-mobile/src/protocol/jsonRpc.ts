import { z } from 'zod';

import type { JsonValue } from '../domain/types';

export const JSON_RPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: JsonValue;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcEnvelope = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcParseError {
  readonly kind: 'parse_error' | 'invalid_request';
  readonly code: -32700 | -32600;
  readonly message: 'Parse error' | 'Invalid Request';
}

export type JsonRpcParseResult =
  | { readonly ok: true; readonly value: JsonRpcEnvelope }
  | { readonly ok: false; readonly error: JsonRpcParseError };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const jsonRpcIdSchema: z.ZodType<JsonRpcId> = z.union([z.string(), z.number().finite()]);
const paramsSchema = z.union([z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]);
const requestSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: paramsSchema.optional(),
}).strict();
const notificationSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1),
  params: paramsSchema.optional(),
}).strict();
const successSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  result: jsonValueSchema,
}).strict();
const errorBodySchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
  data: jsonValueSchema.optional(),
}).strict();
const failureSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: z.union([jsonRpcIdSchema, z.null()]),
  error: errorBodySchema,
}).strict();
const envelopeSchema = z.union([requestSchema, notificationSchema, successSchema, failureSchema]);

export function encodeJsonRpcEnvelope(envelope: JsonRpcEnvelope): string {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new TypeError('cannot encode an invalid JSON-RPC envelope');
  }
  return JSON.stringify(envelope);
}

export function parseJsonRpcEnvelope(input: unknown): JsonRpcParseResult {
  if (typeof input === 'string') {
    if (hasDuplicateObjectKeys(input)) {
      return invalidRequest();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(input) as unknown;
    } catch {
      return parseError();
    }
    return validateEnvelope(decoded);
  }
  return validateEnvelope(input);
}

function validateEnvelope(input: unknown): JsonRpcParseResult {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    return invalidRequest();
  }
  return Object.freeze({ ok: true, value: deepFreeze(parsed.data) });
}

function parseError(): { readonly ok: false; readonly error: JsonRpcParseError } {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ kind: 'parse_error', code: -32700, message: 'Parse error' }),
  });
}

function invalidRequest(): { readonly ok: false; readonly error: JsonRpcParseError } {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ kind: 'invalid_request', code: -32600, message: 'Invalid Request' }),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const child of Object.values(record)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

/** JSON.parse collapses duplicate keys, so detect them before Zod sees the value. */
function hasDuplicateObjectKeys(text: string): boolean {
  let index = 0;

  try {
    const duplicate = parseValue();
    skipWhitespace();
    return duplicate || index !== text.length;
  } catch {
    return false;
  }

  function parseValue(): boolean {
    skipWhitespace();
    const character = text[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') {
      parseString();
      return false;
    }
    parsePrimitive();
    return false;
  }

  function parseObject(): boolean {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[index] === '}') {
      index += 1;
      return false;
    }
    while (index < text.length) {
      skipWhitespace();
      if (text[index] !== '"') throw new Error('object key expected');
      const key = parseString();
      if (keys.has(key)) return true;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') throw new Error('object colon expected');
      index += 1;
      if (parseValue()) return true;
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return false;
      }
      if (text[index] !== ',') throw new Error('object separator expected');
      index += 1;
    }
    throw new Error('object terminator expected');
  }

  function parseArray(): boolean {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return false;
    }
    while (index < text.length) {
      if (parseValue()) return true;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return false;
      }
      if (text[index] !== ',') throw new Error('array separator expected');
      index += 1;
    }
    throw new Error('array terminator expected');
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

  function parsePrimitive(): void {
    const start = index;
    while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? '')) {
      index += 1;
    }
    if (start === index) throw new Error('primitive expected');
  }

  function skipWhitespace(): void {
    while (index < text.length && /\s/u.test(text[index] ?? '')) {
      index += 1;
    }
  }
}
