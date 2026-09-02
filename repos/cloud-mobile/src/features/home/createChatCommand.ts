import { assertOpaqueId } from '../../protocol/ids';
import {
  parseChatUri,
  createRootUri,
  type ChatUri,
} from '../../protocol/resourceUri';
import type {
  HostCreateChatParams,
  HostDispatchActionParams,
  HostPermissionMode,
} from '../../protocol/hostWire';

export interface CreateChatCommandInput {
  readonly workspaceId: string;
  readonly modelId: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly permissionMode?: HostPermissionMode;
  readonly prompt: string;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface SendChatCommandInput {
  readonly channel: ChatUri;
  readonly prompt: string;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface CreateChatCommand {
  readonly method: 'catalog/createChat';
  readonly params: HostCreateChatParams;
}

export interface SendChatCommand {
  readonly method: 'dispatchAction';
  readonly params: HostDispatchActionParams;
}

export function buildCreateChatCommand(input: CreateChatCommandInput): CreateChatCommand {
  const prompt = normalizePrompt(input.prompt);
  assertCommand(input.workspaceId, 'workspaceId');
  assertCommand(input.modelId, 'modelId');
  assertCommand(input.commandId, 'commandId');
  assertClientSeq(input.clientSeq);
  return Object.freeze({
    method: 'catalog/createChat',
    params: Object.freeze({
      channel: createRootUri(),
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      initialPrompt: prompt,
      clientSeq: input.clientSeq,
      commandId: input.commandId,
    }),
  });
}

export function buildSendChatCommand(input: SendChatCommandInput): SendChatCommand {
  const prompt = normalizePrompt(input.prompt);
  const channel = parseChatUri(input.channel);
  assertCommand(input.commandId, 'commandId');
  assertClientSeq(input.clientSeq);
  return Object.freeze({
    method: 'dispatchAction',
    params: Object.freeze({
      channel,
      clientSeq: input.clientSeq,
      commandId: input.commandId,
      action: Object.freeze({ type: 'chat/send', prompt }),
    }),
  });
}

function normalizePrompt(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('prompt is required');
  }
  return value.trim();
}

function assertCommand(value: string, label: string): void {
  assertOpaqueId(value, label);
}

function assertClientSeq(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('clientSeq must be a positive safe integer');
  }
}
