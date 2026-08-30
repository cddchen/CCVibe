export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type ConnectionId = Brand<string, 'ConnectionId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ChatId = Brand<string, 'ChatId'>;
export type TurnId = Brand<string, 'TurnId'>;

export const MAX_OPAQUE_ID_BYTES = 256;

const OPAQUE_SEGMENT = /^[^\s/?#\\]+$/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertOpaqueId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || !OPAQUE_SEGMENT.test(value)) {
    throw new TypeError(`${label} must be a non-empty opaque identifier`);
  }
  if (utf8ByteLength(value) > MAX_OPAQUE_ID_BYTES) {
    throw new RangeError(`${label} exceeds the maximum identifier length`);
  }
}

function brand<Name extends string>(value: string): Brand<string, Name> {
  return value as Brand<string, Name>;
}

export function createConnectionId(value: string): ConnectionId {
  assertOpaqueId(value, 'connectionId');
  return brand<'ConnectionId'>(value);
}

export function createSessionId(value: string): SessionId {
  assertOpaqueId(value, 'sessionId');
  return brand<'SessionId'>(value);
}

export function createChatId(value: string): ChatId {
  assertOpaqueId(value, 'chatId');
  return brand<'ChatId'>(value);
}

export function createTurnId(value: string): TurnId {
  assertOpaqueId(value, 'turnId');
  return brand<'TurnId'>(value);
}
