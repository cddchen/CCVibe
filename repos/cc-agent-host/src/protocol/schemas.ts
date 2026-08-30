import { z } from 'zod';

import type { CommandReceipt } from '../chat/commandDeduper.js';
import {
  parseApprovalId,
  parseClientId,
  parseCommandId,
  parseConnectionId,
  parseInputRequestId,
  parseModelId,
  parseTurnId,
  parseWorkspaceId,
} from '../domain/ids.js';
import type { ChatUri, TurnId } from '../domain/ids.js';
import type { JsonValue } from '../domain/chat.js';
import type { ChatState } from '../domain/chat.js';
import {
  parseChatUri,
  parseResourceUri,
  parseRootUri,
  type AgentResource,
} from '../domain/resources.js';
import type { StateSnapshot } from './types.js';
import {
  MAX_CLIENT_INFO_FIELD_BYTES,
  MAX_HOST_EPOCH_BYTES,
  MAX_METHOD_NAME_BYTES,
  MAX_OPAQUE_ID_BYTES,
  MAX_PROMPT_BYTES,
  MAX_PROTOCOL_VERSION_BYTES,
  MAX_PROTOCOL_VERSIONS,
  MAX_RESOURCE_URI_BYTES,
  MAX_SUBSCRIPTIONS,
  PROTOCOL_VERSION,
  utf8ByteLength,
} from './limits.js';

export {
  MAX_CLIENT_INFO_FIELD_BYTES,
  MAX_HOST_EPOCH_BYTES,
  MAX_METHOD_NAME_BYTES,
  MAX_OPAQUE_ID_BYTES,
  MAX_PROMPT_BYTES,
  MAX_PROTOCOL_VERSION_BYTES,
  MAX_PROTOCOL_VERSIONS,
  MAX_RESOURCE_URI_BYTES,
  MAX_SUBSCRIPTIONS,
  PROTOCOL_VERSION,
};

function boundedString(label: string, maxBytes: number, minimumLength = 1): z.ZodType<string, string> {
  return z
    .string()
    .min(minimumLength, { message: `${label} is required` })
    .refine((value) => utf8ByteLength(value) <= maxBytes, {
      message: `${label} exceeds its maximum length`,
    });
}

function parsedString<T>(
  schema: z.ZodType<string, string>,
  label: string,
  parser: (value: string) => T,
): z.ZodType<T, string> {
  return schema.transform((value, context) => {
    try {
      return parser(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid ${label}`,
      });
      return z.NEVER;
    }
  });
}

export const connectionIdSchema = parsedString(
  boundedString('connectionId', MAX_OPAQUE_ID_BYTES),
  'connectionId',
  parseConnectionId,
);

export const clientIdSchema = parsedString(
  boundedString('clientId', MAX_OPAQUE_ID_BYTES),
  'clientId',
  parseClientId,
);

export const commandIdSchema = parsedString(
  boundedString('commandId', MAX_OPAQUE_ID_BYTES),
  'commandId',
  parseCommandId,
);

export const turnIdSchema = parsedString(
  boundedString('turnId', MAX_OPAQUE_ID_BYTES),
  'turnId',
  parseTurnId,
);

export const approvalIdSchema = parsedString(
  boundedString('approvalId', MAX_OPAQUE_ID_BYTES),
  'approvalId',
  parseApprovalId,
);

export const inputRequestIdSchema = parsedString(
  boundedString('inputId', MAX_OPAQUE_ID_BYTES),
  'inputId',
  parseInputRequestId,
);

export const rootUriSchema = parsedString(
  boundedString('root URI', MAX_RESOURCE_URI_BYTES),
  'root URI',
  parseRootUri,
);

export const chatUriSchema = parsedString(
  boundedString('chat URI', MAX_RESOURCE_URI_BYTES),
  'chat URI',
  parseChatUri,
);

export const agentResourceSchema = parsedString(
  boundedString('resource URI', MAX_RESOURCE_URI_BYTES),
  'resource URI',
  (value): AgentResource => parseResourceUri(value).uri,
);

const protocolVersionSchema = boundedString('protocol version', MAX_PROTOCOL_VERSION_BYTES);
const clientInfoFieldSchema = boundedString('clientInfo field', MAX_CLIENT_INFO_FIELD_BYTES);
const hostEpochSchema = boundedString('host epoch', MAX_HOST_EPOCH_BYTES);
const promptSchema = boundedString('prompt', MAX_PROMPT_BYTES);

const clientInfoSchema = z
  .object({
    name: clientInfoFieldSchema,
    version: clientInfoFieldSchema,
    platform: clientInfoFieldSchema,
  })
  .strict();

const capabilitiesSchema = z
  .object({
    partialBlocks: z.boolean(),
    approvalEdits: z.boolean(),
  })
  .strict();

const resourceListSchema = z.array(agentResourceSchema).max(MAX_SUBSCRIPTIONS).readonly();
const protocolVersionListSchema = z
  .array(protocolVersionSchema)
  .min(1, { message: 'at least one protocol version is required' })
  .max(MAX_PROTOCOL_VERSIONS)
  .readonly();

const chatSendActionSchema = z
  .object({
    type: z.literal('chat/send'),
    prompt: promptSchema,
  })
  .strict();

const chatInterruptActionSchema = z
  .object({
    type: z.literal('chat/interrupt'),
    turnId: turnIdSchema,
  })
  .strict();

export const clientActionSchema = z.discriminatedUnion('type', [chatSendActionSchema, chatInterruptActionSchema]);

/*
 * Interaction decisions deliberately use a protocol-owned JSON projection.
 * The Claude SDK PermissionResult/PermissionUpdate unions never cross this
 * boundary. A lazy schema keeps nested edited tool input and UI suggestions
 * finite and JSON-safe without accepting undefined or non-finite numbers.
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.string(),
  z.number().refine(Number.isFinite),
  z.boolean(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));
const jsonObjectSchema = z.record(z.string(), jsonValueSchema).readonly();
const interactionMessageSchema = boundedString('interaction message', MAX_PROMPT_BYTES);
const interactionDecisionSchema = z.enum(['allow', 'deny']);
const decisionClassificationSchema = z.enum(['user_temporary', 'user_permanent', 'user_reject']);
const answersSchema = z.record(z.string(), z.string()).readonly();

export const resolveApprovalParamsSchema = z
  .object({
    channel: chatUriSchema,
    clientSeq: z.number().int().safe().positive(),
    commandId: commandIdSchema,
    approvalId: approvalIdSchema,
    decision: interactionDecisionSchema,
    updatedInput: jsonObjectSchema.optional(),
    updatedPermissions: z.array(jsonObjectSchema).readonly().optional(),
    decisionClassification: decisionClassificationSchema.optional(),
    message: interactionMessageSchema.optional(),
    interrupt: z.boolean().optional(),
  })
  .strict();

export const resolveInputParamsSchema = z
  .object({
    channel: chatUriSchema,
    clientSeq: z.number().int().safe().positive(),
    commandId: commandIdSchema,
    inputId: inputRequestIdSchema,
    answers: answersSchema.optional(),
  })
  .strict();

export const initializeParamsSchema = z
  .object({
    channel: rootUriSchema,
    protocolVersions: protocolVersionListSchema,
    clientId: clientIdSchema,
    clientInfo: clientInfoSchema,
    capabilities: capabilitiesSchema,
    initialSubscriptions: resourceListSchema,
  })
  .strict();

export const subscribeParamsSchema = z
  .object({
    channel: agentResourceSchema,
  })
  .strict();

export const unsubscribeParamsSchema = z
  .object({
    channel: agentResourceSchema,
  })
  .strict();

export const reconnectParamsSchema = z
  .object({
    channel: rootUriSchema,
    clientId: clientIdSchema,
    hostEpoch: hostEpochSchema,
    lastSeenServerSeq: z.number().int().safe().nonnegative(),
    subscriptions: resourceListSchema,
  })
  .strict();

export const dispatchActionParamsSchema = z
  .object({
    channel: chatUriSchema,
    clientSeq: z.number().int().safe().positive(),
    commandId: commandIdSchema,
    action: clientActionSchema,
  })
  .strict();

const workspaceIdSchema = parsedString(
  boundedString('workspaceId', MAX_OPAQUE_ID_BYTES),
  'workspaceId',
  parseWorkspaceId,
);

const modelIdSchema = parsedString(
  boundedString('modelId', MAX_OPAQUE_ID_BYTES),
  'modelId',
  parseModelId,
);

/** Create only a provisional chat backing; the first chat/send materializes it. */
export const catalogCreateChatParamsSchema = z
  .object({
    channel: rootUriSchema,
    workspaceId: workspaceIdSchema,
    modelId: modelIdSchema,
    initialPrompt: promptSchema.optional(),
    clientSeq: z.number().int().safe().positive(),
    commandId: commandIdSchema,
  })
  .strict();

/** Short aliases for consumers that name schemas after their RPC method. */
export const initializeSchema = initializeParamsSchema;
export const subscribeSchema = subscribeParamsSchema;
export const unsubscribeSchema = unsubscribeParamsSchema;
export const reconnectSchema = reconnectParamsSchema;
export const dispatchActionSchema = dispatchActionParamsSchema;
export const catalogCreateChatSchema = catalogCreateChatParamsSchema;
export const createChatParamsSchema = catalogCreateChatParamsSchema;
export const resolveApprovalSchema = resolveApprovalParamsSchema;
export const resolveInputSchema = resolveInputParamsSchema;

export type ClientAction = z.infer<typeof clientActionSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
export type UnsubscribeParams = z.infer<typeof unsubscribeParamsSchema>;
export type ReconnectParams = z.infer<typeof reconnectParamsSchema>;
export type DispatchActionParams = z.infer<typeof dispatchActionParamsSchema>;
export type CatalogCreateChatParams = z.infer<typeof catalogCreateChatParamsSchema>;
export type ResolveApprovalParams = z.infer<typeof resolveApprovalParamsSchema>;
export type ResolveInputParams = z.infer<typeof resolveInputParamsSchema>;

export interface InitializeResult<S = ChatState> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly hostEpoch: string;
  readonly serverSeq: number;
  readonly snapshots: readonly StateSnapshot<S>[];
  readonly missing: readonly AgentResource[];
}

export interface SubscribeResult<S = ChatState> {
  readonly snapshot: StateSnapshot<S>;
}

export interface UnsubscribeResult {
  readonly removed: boolean;
}

export interface DispatchActionResult {
  readonly receipt: CommandReceipt<{
    readonly acceptedAtSeq: number;
    readonly turnId?: TurnId;
  }>;
}

export interface CatalogCreateChatResult {
  readonly receipt: CommandReceipt<{ readonly chatUri: ChatUri }>;
}

export interface InteractionResolutionResult {
  readonly receipt: CommandReceipt<{
    readonly status: 'resolved' | 'already_resolved';
    readonly kind: 'approval' | 'input';
    readonly id: string;
  }>;
}

export interface SafeValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/** Strip Zod messages and inputs down to stable, non-sensitive issue metadata. */
export function toSafeValidationIssues(error: unknown): readonly SafeValidationIssue[] {
  if (typeof error !== 'object' || error === null) {
    return Object.freeze([{ path: Object.freeze([]), code: 'invalid' }]);
  }

  const issues = (error as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return Object.freeze([{ path: Object.freeze([]), code: 'invalid' }]);
  }

  const safeIssues = issues.map((issue: unknown): SafeValidationIssue => {
    if (typeof issue !== 'object' || issue === null) {
      return { path: Object.freeze([]), code: 'invalid' };
    }

    const candidate = issue as { readonly path?: unknown; readonly code?: unknown };
    const path = Array.isArray(candidate.path)
      ? candidate.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : [];
    const code = typeof candidate.code === 'string' ? candidate.code : 'invalid';
    return { path: Object.freeze(path), code };
  });

  return Object.freeze(safeIssues);
}

export const safeValidationIssues = toSafeValidationIssues;
