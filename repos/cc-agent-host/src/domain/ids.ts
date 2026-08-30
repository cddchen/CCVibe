export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type ClientId = Brand<string, 'ClientId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type SessionUri = Brand<string, 'SessionUri'>;
export type ChatUri = Brand<string, 'ChatUri'>;
export type RootUri = Brand<string, 'RootUri'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ModelId = Brand<string, 'ModelId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type PartId = Brand<string, 'PartId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type InputRequestId = Brand<string, 'InputRequestId'>;

/** Maximum UTF-8 byte length for opaque IDs and URI segments. */
export const MAX_OPAQUE_ID_BYTES = 256;

const OPAQUE_SEGMENT = /^[^\s/?#\\]+$/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function brand<Name extends string>(value: string): Brand<string, Name> {
  return value as Brand<string, Name>;
}

function validateOpaqueId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || !OPAQUE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${label} must be a non-empty opaque identifier`);
  }
  if (utf8ByteLength(value) > MAX_OPAQUE_ID_BYTES) {
    throw new RangeError(`${label} exceeds the maximum identifier length`);
  }
}

export function createClientId(value: string): ClientId {
  validateOpaqueId(value, 'clientId');
  return brand<'ClientId'>(value);
}

export function parseClientId(value: string): ClientId {
  return createClientId(value);
}

export const clientId = createClientId;

export function createCommandId(value: string): CommandId {
  validateOpaqueId(value, 'commandId');
  return brand<'CommandId'>(value);
}

export function parseCommandId(value: string): CommandId {
  return createCommandId(value);
}

export const commandId = createCommandId;

export function createWorkspaceId(value: string): WorkspaceId {
  validateOpaqueId(value, 'workspaceId');
  return brand<'WorkspaceId'>(value);
}

export function parseWorkspaceId(value: string): WorkspaceId {
  return createWorkspaceId(value);
}

export const workspaceId = createWorkspaceId;

export function createModelId(value: string): ModelId {
  validateOpaqueId(value, 'modelId');
  return brand<'ModelId'>(value);
}

export function parseModelId(value: string): ModelId {
  return createModelId(value);
}

export const modelId = createModelId;

export function createConnectionId(value: string): ConnectionId {
  validateOpaqueId(value, 'connectionId');
  return brand<'ConnectionId'>(value);
}

export function parseConnectionId(value: string): ConnectionId {
  return createConnectionId(value);
}

export const connectionId = createConnectionId;

export function createTurnId(value: string): TurnId {
  validateOpaqueId(value, 'turnId');
  return brand<'TurnId'>(value);
}

export function parseTurnId(value: string): TurnId {
  return createTurnId(value);
}

export const turnId = createTurnId;

export function createPartId(value: string): PartId {
  validateOpaqueId(value, 'partId');
  return brand<'PartId'>(value);
}

export function parsePartId(value: string): PartId {
  return createPartId(value);
}

export const partId = createPartId;

export function createToolCallId(value: string): ToolCallId {
  validateOpaqueId(value, 'toolCallId');
  return brand<'ToolCallId'>(value);
}

export function parseToolCallId(value: string): ToolCallId {
  return createToolCallId(value);
}

export const toolCallId = createToolCallId;

export function createApprovalId(value: string): ApprovalId {
  validateOpaqueId(value, 'approvalId');
  return brand<'ApprovalId'>(value);
}

export function parseApprovalId(value: string): ApprovalId {
  return createApprovalId(value);
}

export const approvalId = createApprovalId;

export function createInputRequestId(value: string): InputRequestId {
  validateOpaqueId(value, 'inputRequestId');
  return brand<'InputRequestId'>(value);
}

export function parseInputRequestId(value: string): InputRequestId {
  return createInputRequestId(value);
}

export const inputRequestId = createInputRequestId;
/** Short aliases used by interaction adapters that call the value an input id. */
export const createInputId = createInputRequestId;
export const parseInputId = parseInputRequestId;
export const inputId = createInputRequestId;
