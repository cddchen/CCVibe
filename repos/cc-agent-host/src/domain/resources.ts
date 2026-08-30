import { MAX_OPAQUE_ID_BYTES, type ChatUri, type RootUri, type SessionUri } from './ids.js';

export type AgentResource = RootUri | SessionUri | ChatUri;
export type ResourceKind = 'root' | 'session' | 'chat';

export const AGENT_ROOT_URI = 'agent-root://' as RootUri;

const OPAQUE_SEGMENT = /^[^\s/?#\\]+$/u;

function validateSegment(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') {
    throw new TypeError(`${label} must be a non-empty URI segment`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_OPAQUE_ID_BYTES) {
    throw new RangeError(`${label} exceeds the maximum URI segment length`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError(`${label} must be a valid URI segment`);
  }

  if (
    !OPAQUE_SEGMENT.test(value) ||
    !OPAQUE_SEGMENT.test(decoded) ||
    decoded === '.' ||
    decoded === '..'
  ) {
    throw new TypeError(`${label} must be a safe opaque URI segment`);
  }
}

function splitResource(value: string, prefix: string, expectedSegments: number): readonly string[] {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.includes('?') || value.includes('#')) {
    throw new TypeError('invalid agent resource URI');
  }

  const remainder = value.slice(prefix.length);
  const segments = remainder.split('/');
  if (segments.length !== expectedSegments || segments.some((segment) => segment.length === 0)) {
    throw new TypeError('invalid agent resource URI');
  }

  for (const [index, segment] of segments.entries()) {
    validateSegment(segment, `segment ${index}`);
  }

  return segments;
}

export function createRootUri(): RootUri {
  return AGENT_ROOT_URI;
}

export function parseRootUri(value: string): RootUri {
  if (value !== AGENT_ROOT_URI) {
    throw new TypeError('invalid agent root URI');
  }
  return AGENT_ROOT_URI;
}

export function createSessionUri(sessionId: string): SessionUri {
  validateSegment(sessionId, 'sessionId');
  return `agent-session://${sessionId}` as SessionUri;
}

export function parseSessionUri(value: string): SessionUri {
  splitResource(value, 'agent-session://', 1);
  return value as SessionUri;
}

export function createChatUri(sessionId: string, chatId: string): ChatUri {
  validateSegment(sessionId, 'sessionId');
  validateSegment(chatId, 'chatId');
  return `agent-chat://${sessionId}/${chatId}` as ChatUri;
}

export function parseChatUri(value: string): ChatUri {
  splitResource(value, 'agent-chat://', 2);
  return value as ChatUri;
}

export interface ParsedRootResource {
  readonly kind: 'root';
  readonly uri: RootUri;
}

export interface ParsedSessionResource {
  readonly kind: 'session';
  readonly uri: SessionUri;
  readonly sessionId: string;
}

export interface ParsedChatResource {
  readonly kind: 'chat';
  readonly uri: ChatUri;
  readonly sessionId: string;
  readonly chatId: string;
}

export type ParsedResource = ParsedRootResource | ParsedSessionResource | ParsedChatResource;

export function parseResourceUri(value: string): ParsedResource {
  if (value === AGENT_ROOT_URI) {
    return { kind: 'root', uri: AGENT_ROOT_URI };
  }

  if (value.startsWith('agent-session://')) {
    const sessionUri = parseSessionUri(value);
    const segments = splitResource(value, 'agent-session://', 1);
    const sessionId = segments[0];
    if (sessionId === undefined) {
      throw new TypeError('invalid agent session URI');
    }
    return { kind: 'session', uri: sessionUri, sessionId };
  }

  if (value.startsWith('agent-chat://')) {
    const chatUri = parseChatUri(value);
    const segments = splitResource(value, 'agent-chat://', 2);
    const sessionId = segments[0];
    const chatId = segments[1];
    if (sessionId === undefined || chatId === undefined) {
      throw new TypeError('invalid agent chat URI');
    }
    return { kind: 'chat', uri: chatUri, sessionId, chatId };
  }

  throw new TypeError('invalid agent resource URI');
}

export function resourceKind(value: string): ResourceKind {
  return parseResourceUri(value).kind;
}

export function isResourceUri(value: string): value is AgentResource {
  try {
    parseResourceUri(value);
    return true;
  } catch {
    return false;
  }
}
