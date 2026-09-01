import { z } from 'zod';

import type { JsonObject, JsonValue } from '../domain/types';
import {
  parseChatUri,
  parseResourceUri,
  parseRootUri,
  type AgentResource,
  type ChatUri,
  type RootUri,
} from './resourceUri';

const MAX_OPAQUE_BYTES = 256;
const MAX_RESOURCE_BYTES = 1024;
const MAX_HOST_EPOCH_BYTES = 256;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(maxBytes: number, minimumLength = 0): z.ZodString {
  return z.string().min(minimumLength).refine((value) => byteLength(value) <= maxBytes);
}

const textSchema = boundedText(512 * 1024);
const requiredTextSchema = boundedText(512 * 1024, 1);
const opaqueIdSchema = boundedText(MAX_OPAQUE_BYTES, 1);
const hostEpochSchema = boundedText(MAX_HOST_EPOCH_BYTES, 1);

const rootUriValueSchema = boundedText(MAX_RESOURCE_BYTES).transform((value, context) => {
  try {
    return parseRootUri(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid root URI' });
    return z.NEVER;
  }
});

const chatUriValueSchema = boundedText(MAX_RESOURCE_BYTES).transform((value, context) => {
  try {
    return parseChatUri(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid chat URI' });
    return z.NEVER;
  }
});

const agentResourceValueSchema = boundedText(MAX_RESOURCE_BYTES).transform((value, context) => {
  try {
    return parseResourceUri(value).uri;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid resource URI' });
    return z.NEVER;
  }
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const hostIdentitySchema = z.object({
  id: requiredTextSchema,
  displayName: requiredTextSchema,
}).strict();

const connectionStateSchema = z.object({
  status: z.enum(['connected', 'degraded', 'disconnected']),
  displayStatus: z.enum(['online', 'degraded', 'offline']),
}).strict();

const workspaceSchema = z.object({
  id: opaqueIdSchema,
  path: textSchema,
  displayName: requiredTextSchema,
  status: z.enum(['available', 'unavailable']),
}).strict();

const modelSchema = z.object({
  id: opaqueIdSchema,
  displayName: requiredTextSchema,
  description: textSchema.optional(),
  capabilities: z.array(z.enum(['effort', 'adaptive-thinking', 'fast-mode', 'auto-mode'])).readonly(),
}).strict();

const catalogSessionSchema = z.object({
  chatUri: chatUriValueSchema,
  sdkSessionRef: textSchema,
  workspaceId: opaqueIdSchema,
  title: requiredTextSchema,
  updatedAt: requiredTextSchema,
  status: z.enum(['idle', 'in_progress', 'input_needed', 'error']),
  archived: z.boolean(),
}).strict();

export const hostRootCatalogStateSchema = z.object({
  resource: rootUriValueSchema,
  host: hostIdentitySchema,
  connection: connectionStateSchema,
  workspaces: z.array(workspaceSchema).readonly(),
  sessions: z.array(catalogSessionSchema).readonly(),
  models: z.array(modelSchema).readonly(),
  defaultModelId: opaqueIdSchema.optional(),
  modifiedAt: textSchema,
}).strict();

const toolCallSchema = z.object({
  id: opaqueIdSchema,
  name: textSchema,
  input: textSchema,
  status: z.enum(['started', 'ready', 'completed']),
  startedAt: textSchema,
  readyAt: textSchema.optional(),
  completedAt: textSchema.optional(),
  result: textSchema.optional(),
  error: textSchema.optional(),
}).strict();

const markdownPartSchema = z.object({
  kind: z.literal('markdown'),
  id: opaqueIdSchema,
  content: z.string(),
}).strict();

const reasoningPartSchema = z.object({
  kind: z.literal('reasoning'),
  id: opaqueIdSchema,
  content: z.string(),
}).strict();

const toolCallPartSchema = z.object({
  kind: z.literal('tool_call'),
  id: opaqueIdSchema,
  toolCall: toolCallSchema,
}).strict();

const responsePartSchema = z.discriminatedUnion('kind', [
  markdownPartSchema,
  reasoningPartSchema,
  toolCallPartSchema,
]);

const activeTurnSchema = z.object({
  id: opaqueIdSchema,
  prompt: textSchema,
  status: z.literal('active'),
  parts: z.array(responsePartSchema).readonly(),
  startedAt: textSchema,
}).strict();

const turnSchema = z.object({
  id: opaqueIdSchema,
  prompt: textSchema,
  status: z.enum(['active', 'complete', 'failed', 'interrupted']),
  parts: z.array(responsePartSchema).readonly(),
  startedAt: textSchema,
  completedAt: textSchema.optional(),
  error: textSchema.optional(),
}).strict();

const matchedAskRuleSchema = z.object({
  source: textSchema,
  toolName: textSchema,
  ruleContent: textSchema.optional(),
}).strict();

const pendingApprovalSchema = z.object({
  id: opaqueIdSchema,
  turnId: opaqueIdSchema,
  toolCallId: opaqueIdSchema.optional(),
  toolName: textSchema.optional(),
  input: jsonObjectSchema.optional(),
  title: textSchema.optional(),
  displayName: textSchema.optional(),
  description: textSchema.optional(),
  suggestions: z.array(jsonObjectSchema).readonly().optional(),
  requestId: textSchema.optional(),
  sdkRequestId: textSchema.optional(),
  toolUseId: textSchema.optional(),
  toolUseID: textSchema.optional(),
  agentId: textSchema.optional(),
  agentID: textSchema.optional(),
  blockedPath: textSchema.optional(),
  decisionReason: textSchema.optional(),
  matchedAskRule: matchedAskRuleSchema.optional(),
  requestedAt: textSchema,
}).strict();

const inputQuestionOptionSchema = z.object({
  label: textSchema,
  description: textSchema,
  preview: textSchema.optional(),
}).strict();

const inputQuestionSchema = z.object({
  question: textSchema,
  header: textSchema,
  options: z.array(inputQuestionOptionSchema).min(2).max(4).readonly(),
  multiSelect: z.boolean(),
}).strict();

const pendingInputSchema = z.object({
  id: opaqueIdSchema,
  turnId: opaqueIdSchema,
  questions: z.array(inputQuestionSchema).min(1).max(4).readonly(),
  requestedAt: textSchema,
}).strict();

export const hostChatStateSchema = z.object({
  resource: chatUriValueSchema.optional(),
  status: z.enum(['idle', 'in_progress', 'input_needed', 'error']),
  turns: z.array(turnSchema).readonly(),
  activeTurn: activeTurnSchema.optional(),
  pendingApprovals: z.array(pendingApprovalSchema).readonly(),
  pendingInputs: z.array(pendingInputSchema).readonly().optional(),
  modifiedAt: textSchema,
}).strict();

const timestamped = { timestamp: textSchema } as const;

const catalogActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('catalog/hostUpdated'), host: hostIdentitySchema, connection: connectionStateSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/workspacesReplaced'), workspaces: z.array(workspaceSchema).readonly(), ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/modelsReplaced'), models: z.array(modelSchema).readonly(), defaultModelId: opaqueIdSchema.optional(), ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/sessionsReplaced'), sessions: z.array(catalogSessionSchema).readonly(), ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/chatCreated'), session: catalogSessionSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/chatUpdated'), session: catalogSessionSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('catalog/chatRemoved'), chatUri: chatUriValueSchema, ...timestamped }).strict(),
]);

const responsePartWithoutToolSchema = z.discriminatedUnion('kind', [markdownPartSchema, reasoningPartSchema]);

const chatActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat/turnStarted'), turnId: opaqueIdSchema, prompt: textSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/responsePartAdded'), turnId: opaqueIdSchema, part: responsePartWithoutToolSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/responsePartDelta'), turnId: opaqueIdSchema, partId: opaqueIdSchema, delta: z.string(), ...timestamped }).strict(),
  z.object({ type: z.literal('chat/toolCallStarted'), turnId: opaqueIdSchema, partId: opaqueIdSchema, toolCallId: opaqueIdSchema, name: textSchema, input: textSchema.optional(), ...timestamped }).strict(),
  z.object({ type: z.literal('chat/toolCallInputDelta'), turnId: opaqueIdSchema, partId: opaqueIdSchema, toolCallId: opaqueIdSchema, delta: z.string(), ...timestamped }).strict(),
  z.object({ type: z.literal('chat/toolCallReady'), turnId: opaqueIdSchema, partId: opaqueIdSchema, toolCallId: opaqueIdSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/toolCallCompleted'), turnId: opaqueIdSchema, partId: opaqueIdSchema, toolCallId: opaqueIdSchema, result: textSchema.optional(), error: textSchema.optional(), ...timestamped }).strict(),
  z.object({ type: z.literal('chat/inputRequested'), turnId: opaqueIdSchema, inputId: opaqueIdSchema, questions: z.array(inputQuestionSchema).min(1).max(4).readonly(), requestedAt: textSchema.optional(), ...timestamped }).strict(),
  z.object({ type: z.literal('chat/inputResolved'), turnId: opaqueIdSchema, inputId: opaqueIdSchema, answers: z.record(z.string(), z.string()).readonly().optional(), ...timestamped }).strict(),
  z.object({
    type: z.literal('chat/approvalRequested'),
    turnId: opaqueIdSchema,
    approvalId: opaqueIdSchema,
    toolCallId: opaqueIdSchema.optional(),
    toolName: textSchema,
    input: jsonObjectSchema,
    title: textSchema.optional(),
    displayName: textSchema.optional(),
    description: textSchema.optional(),
    suggestions: z.array(jsonObjectSchema).readonly().optional(),
    requestId: textSchema.optional(),
    sdkRequestId: textSchema.optional(),
    toolUseId: textSchema.optional(),
    toolUseID: textSchema.optional(),
    agentId: textSchema.optional(),
    agentID: textSchema.optional(),
    blockedPath: textSchema.optional(),
    decisionReason: textSchema.optional(),
    matchedAskRule: matchedAskRuleSchema.optional(),
    requestedAt: textSchema.optional(),
    ...timestamped,
  }).strict(),
  z.object({
    type: z.literal('chat/approvalResolved'),
    turnId: opaqueIdSchema,
    approvalId: opaqueIdSchema,
    decision: z.enum(['allow', 'deny']),
    updatedInput: jsonObjectSchema.optional(),
    updatedPermissions: z.array(jsonObjectSchema).readonly().optional(),
    decisionClassification: z.enum(['user_temporary', 'user_permanent', 'user_reject']).optional(),
    message: textSchema.optional(),
    interrupt: z.boolean().optional(),
    ...timestamped,
  }).strict(),
  z.object({ type: z.literal('chat/turnCompleted'), turnId: opaqueIdSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/turnFailed'), turnId: opaqueIdSchema, error: textSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/turnInterrupted'), turnId: opaqueIdSchema, ...timestamped }).strict(),
  z.object({ type: z.literal('chat/turnsLoaded'), turns: z.array(turnSchema).readonly(), ...timestamped }).strict(),
]);

const chatInterruptActionSchema = z.object({
  type: z.literal('chat/interrupt'),
  turnId: opaqueIdSchema,
}).strict();

export const clientChatActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat/send'), prompt: textSchema }).strict(),
  chatInterruptActionSchema,
]);

const actionOriginSchema = z.object({
  clientId: opaqueIdSchema,
  clientSeq: z.number().int().safe().positive(),
  commandId: opaqueIdSchema,
}).strict();

const sequenceSchema = z.number().int().safe().nonnegative();
const baseEnvelopeSchema = z.object({
  channel: agentResourceValueSchema,
  serverSeq: sequenceSchema,
  serverTime: textSchema,
  origin: actionOriginSchema.optional(),
}).strict();

export type HostRootCatalogState = z.infer<typeof hostRootCatalogStateSchema>;
export type HostChatState = z.infer<typeof hostChatStateSchema>;
export type HostCatalogAction = z.infer<typeof catalogActionSchema>;
export type HostChatAction = z.infer<typeof chatActionSchema>;
export type HostClientChatAction = z.infer<typeof clientChatActionSchema>;
export type HostAction = HostCatalogAction | HostChatAction;

export type HostStateSnapshot =
  | { readonly resource: RootUri; readonly state: HostRootCatalogState; readonly fromSeq: number }
  | { readonly resource: ChatUri; readonly state: HostChatState; readonly fromSeq: number };

export type HostActionEnvelope =
  | {
      readonly channel: RootUri;
      readonly action: HostCatalogAction;
      readonly serverSeq: number;
      readonly serverTime: string;
      readonly origin?: z.infer<typeof actionOriginSchema>;
    }
  | {
      readonly channel: ChatUri;
      readonly action: HostChatAction;
      readonly serverSeq: number;
      readonly serverTime: string;
      readonly origin?: z.infer<typeof actionOriginSchema>;
    };

export type HostInitializeResult = {
  readonly protocolVersion: '1.0.0';
  readonly hostEpoch: string;
  readonly serverSeq: number;
  readonly snapshots: readonly HostStateSnapshot[];
  readonly missing: readonly AgentResource[];
};

export type HostReconnectResult =
  | {
      readonly type: 'replay';
      readonly hostEpoch: string;
      readonly actions: readonly HostActionEnvelope[];
      readonly missing: readonly AgentResource[];
      readonly throughSeq: number;
      readonly serverSeq: number;
    }
  | {
      readonly type: 'snapshot';
      readonly hostEpoch: string;
      readonly snapshots: readonly HostStateSnapshot[];
      readonly missing: readonly AgentResource[];
      readonly throughSeq: number;
      readonly serverSeq: number;
    };

export type HostNotification =
  | { readonly type: 'state/action'; readonly envelope: HostActionEnvelope }
  | { readonly type: 'client/replaced'; readonly reason: string };

export interface HostCreateChatParams {
  readonly channel: RootUri;
  readonly workspaceId: string;
  readonly modelId: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly initialPrompt?: string;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface HostDispatchActionParams {
  readonly channel: ChatUri;
  readonly clientSeq: number;
  readonly commandId: string;
  readonly action: HostClientChatAction;
}

export interface HostSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases?: readonly string[];
}

export interface HostSupportedCommandsResult {
  readonly commands: readonly HostSlashCommand[];
}

export interface HostResolveApprovalParams {
  readonly channel: ChatUri;
  readonly clientSeq: number;
  readonly commandId: string;
  readonly approvalId: string;
  readonly decision: 'allow' | 'deny';
  readonly updatedInput?: JsonObject;
  readonly updatedPermissions?: readonly JsonObject[];
  readonly decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  readonly message?: string;
  readonly interrupt?: boolean;
}

export interface HostResolveInputParams {
  readonly channel: ChatUri;
  readonly clientSeq: number;
  readonly commandId: string;
  readonly inputId: string;
  readonly answers?: Readonly<Record<string, string>>;
}

export type HostCommandReceipt<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

export type HostCreateChatReceipt = HostCommandReceipt<{ readonly chatUri: ChatUri }>;
export type HostDispatchActionReceipt = HostCommandReceipt<{
  readonly acceptedAtSeq: number;
  readonly turnId?: string;
}>;

export interface HostCreateChatResult {
  readonly receipt: HostCreateChatReceipt;
}

export interface HostDispatchActionResult {
  readonly receipt: HostDispatchActionReceipt;
}

export type HostInteractionResolutionValue = {
  readonly status: 'resolved' | 'already_resolved';
  readonly kind: 'approval' | 'input';
  readonly id: string;
};

export interface HostInteractionResolutionResult {
  readonly receipt: HostCommandReceipt<HostInteractionResolutionValue>;
}

const rpcResultObjectSchema = z.object({}).passthrough();

const acceptedCommandReceiptSchema = z.object({
  status: z.literal('accepted'),
  value: z.unknown(),
}).strict();

const rejectedCommandReceiptSchema = z.object({
  status: z.literal('rejected'),
  code: requiredTextSchema,
  message: requiredTextSchema,
}).strict();

const commandReceiptSchema = z.discriminatedUnion('status', [
  acceptedCommandReceiptSchema,
  rejectedCommandReceiptSchema,
]);

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`invalid ${label}`);
  }
  return deepFreeze(parsed.data);
}

export function parseHostRootCatalogState(value: unknown): HostRootCatalogState {
  return parseWithSchema(hostRootCatalogStateSchema, value, 'Host RootCatalogState');
}

export function parseHostChatState(value: unknown): HostChatState {
  return parseWithSchema(hostChatStateSchema, value, 'Host ChatState');
}

export function parseHostStateSnapshot(value: unknown): HostStateSnapshot {
  const base = parseWithSchema(z.object({
    resource: agentResourceValueSchema,
    state: z.unknown(),
    fromSeq: sequenceSchema,
  }).strict(), value, 'Host state snapshot');

  if (base.resource === 'agent-root://') {
    const resource = base.resource as RootUri;
    const state = parseHostRootCatalogState(base.state);
    if (state.resource !== resource) {
      throw new TypeError('root snapshot resource does not match state resource');
    }
    return deepFreeze({ resource, state, fromSeq: base.fromSeq });
  }

  if (base.resource.startsWith('agent-chat://')) {
    const resource = parseChatUri(base.resource);
    const state = parseHostChatState(base.state);
    if (state.resource !== undefined && state.resource !== resource) {
      throw new TypeError('chat snapshot resource does not match state resource');
    }
    return deepFreeze({ resource, state, fromSeq: base.fromSeq });
  }

  throw new TypeError('Host snapshots cannot contain session resources');
}

export function parseHostActionEnvelope(value: unknown): HostActionEnvelope {
  const base = parseWithSchema(baseEnvelopeSchema.extend({ action: z.unknown() }), value, 'Host action envelope');
  if (base.channel === 'agent-root://') {
    const channel = base.channel as RootUri;
    return deepFreeze({
      channel,
      action: parseWithSchema(catalogActionSchema, base.action, 'Host CatalogAction'),
      serverSeq: base.serverSeq,
      serverTime: base.serverTime,
      ...(base.origin === undefined ? {} : { origin: base.origin }),
    });
  }

  if (base.channel.startsWith('agent-chat://')) {
    const channel = parseChatUri(base.channel);
    return deepFreeze({
      channel,
      action: parseWithSchema(chatActionSchema, base.action, 'Host ChatAction'),
      serverSeq: base.serverSeq,
      serverTime: base.serverTime,
      ...(base.origin === undefined ? {} : { origin: base.origin }),
    });
  }

  throw new TypeError('Host action envelopes cannot target session resources');
}

const initializeResultBaseSchema = z.object({
  protocolVersion: z.literal('1.0.0'),
  hostEpoch: hostEpochSchema,
  serverSeq: sequenceSchema,
  snapshots: z.array(z.unknown()).readonly(),
  missing: z.array(agentResourceValueSchema).readonly(),
}).strict();

export function parseHostInitializeResult(value: unknown): HostInitializeResult {
  const base = parseWithSchema(initializeResultBaseSchema, value, 'initialize result');
  return deepFreeze({
    protocolVersion: base.protocolVersion,
    hostEpoch: base.hostEpoch,
    serverSeq: base.serverSeq,
    snapshots: base.snapshots.map(parseHostStateSnapshot),
    missing: base.missing,
  });
}

const reconnectResultBaseSchema = z.object({
  type: z.enum(['replay', 'snapshot']),
  hostEpoch: hostEpochSchema,
  actions: z.array(z.unknown()).readonly().optional(),
  snapshots: z.array(z.unknown()).readonly().optional(),
  missing: z.array(agentResourceValueSchema).readonly(),
  throughSeq: sequenceSchema,
  serverSeq: sequenceSchema,
}).strict();

export function parseHostReconnectResult(value: unknown): HostReconnectResult {
  const base = parseWithSchema(reconnectResultBaseSchema, value, 'reconnect result');
  if (base.throughSeq !== base.serverSeq) {
    throw new TypeError('reconnect result sequence cut is inconsistent');
  }
  if (base.type === 'replay') {
    if (base.actions === undefined || base.snapshots !== undefined) {
      throw new TypeError('replay reconnect result has invalid fields');
    }
    return deepFreeze({
      type: 'replay',
      hostEpoch: base.hostEpoch,
      actions: base.actions.map(parseHostActionEnvelope),
      missing: base.missing,
      throughSeq: base.throughSeq,
      serverSeq: base.serverSeq,
    });
  }

  if (base.snapshots === undefined || base.actions !== undefined) {
    throw new TypeError('snapshot reconnect result has invalid fields');
  }
  return deepFreeze({
    type: 'snapshot',
    hostEpoch: base.hostEpoch,
    snapshots: base.snapshots.map(parseHostStateSnapshot),
    missing: base.missing,
    throughSeq: base.throughSeq,
    serverSeq: base.serverSeq,
  });
}

export function parseHostSubscribeResult(value: unknown): { readonly snapshot: HostStateSnapshot } {
  const base = parseWithSchema(z.object({ snapshot: z.unknown() }).strict(), value, 'subscribe result');
  return deepFreeze({ snapshot: parseHostStateSnapshot(base.snapshot) });
}

export function parseHostUnsubscribeResult(value: unknown): { readonly removed: boolean } {
  return parseWithSchema(z.object({ removed: z.boolean() }).strict(), value, 'unsubscribe result');
}

export function parseHostCreateChatResult(value: unknown): HostCreateChatResult {
  const base = parseWithSchema(z.object({ receipt: commandReceiptSchema }).strict(), value, 'catalog/createChat result');
  if (base.receipt.status === 'rejected') {
    return deepFreeze({ receipt: base.receipt });
  }
  const accepted = parseWithSchema(z.object({
    status: z.literal('accepted'),
    value: z.object({ chatUri: chatUriValueSchema }).strict(),
  }).strict(), base.receipt, 'catalog/createChat receipt');
  return deepFreeze({ receipt: accepted });
}

export function parseHostDispatchActionResult(value: unknown): HostDispatchActionResult {
  const base = parseWithSchema(z.object({ receipt: commandReceiptSchema }).strict(), value, 'dispatchAction result');
  if (base.receipt.status === 'rejected') {
    return deepFreeze({ receipt: base.receipt });
  }
  const accepted = parseWithSchema(z.object({
    status: z.literal('accepted'),
    value: z.object({
      acceptedAtSeq: z.number().int().safe().nonnegative(),
      turnId: opaqueIdSchema.optional(),
    }).strict(),
  }).strict(), base.receipt, 'dispatchAction receipt');
  return deepFreeze({ receipt: accepted });
}

export function parseHostSupportedCommandsResult(value: unknown): HostSupportedCommandsResult {
  return deepFreeze(parseWithSchema(z.object({
    commands: z.array(z.object({
      name: requiredTextSchema,
      description: textSchema,
      argumentHint: textSchema,
      aliases: z.array(requiredTextSchema).readonly().optional(),
    }).strict()).readonly(),
  }).strict(), value, 'chat/supportedCommands result'));
}

export function parseHostInteractionResolutionResult(value: unknown): HostInteractionResolutionResult {
  const base = parseWithSchema(z.object({ receipt: commandReceiptSchema }).strict(), value, 'interaction resolution result');
  if (base.receipt.status === 'rejected') {
    return deepFreeze({ receipt: base.receipt });
  }
  const accepted = parseWithSchema(z.object({
    status: z.literal('accepted'),
    value: z.object({
      status: z.enum(['resolved', 'already_resolved']),
      kind: z.enum(['approval', 'input']),
      id: opaqueIdSchema,
    }).strict(),
  }).strict(), base.receipt, 'interaction resolution receipt');
  return deepFreeze({ receipt: accepted });
}

export function parseHostNotification(value: unknown): HostNotification | undefined {
  const base = parseWithSchema(z.object({
    jsonrpc: z.literal('2.0'),
    method: z.string(),
    params: z.unknown().optional(),
  }).strict(), value, 'Host notification');

  if (base.method === 'state/action') {
    return deepFreeze({ type: 'state/action', envelope: parseHostActionEnvelope(base.params) });
  }
  if (base.method === 'client/replaced') {
    const params = parseWithSchema(z.object({ reason: textSchema }).strict(), base.params, 'client/replaced notification');
    return deepFreeze({ type: 'client/replaced', reason: params.reason });
  }
  return undefined;
}

export function parseHostRpcResult(method: string, value: unknown): unknown {
  switch (method) {
    case 'initialize':
      return parseHostInitializeResult(value);
    case 'reconnect':
      return parseHostReconnectResult(value);
    case 'subscribe':
      return parseHostSubscribeResult(value);
    case 'unsubscribe':
      return parseHostUnsubscribeResult(value);
    case 'catalog/createChat':
      return parseHostCreateChatResult(value);
    case 'dispatchAction':
      return parseHostDispatchActionResult(value);
    case 'chat/supportedCommands':
      return parseHostSupportedCommandsResult(value);
    case 'chat/resolveApproval':
    case 'chat/resolveInput':
      return parseHostInteractionResolutionResult(value);
    default:
      return deepFreeze(parseWithSchema(rpcResultObjectSchema, value, `${method} result`));
  }
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
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}
