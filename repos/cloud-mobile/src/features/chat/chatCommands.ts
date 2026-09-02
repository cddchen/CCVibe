import { assertOpaqueId } from '../../protocol/ids';
import { parseChatUri, type ChatUri } from '../../protocol/resourceUri';
import type {
  HostClientChatAction,
  HostDispatchActionParams,
  HostInteractionResolutionResult,
  HostResolveApprovalParams,
  HostResolveInputParams,
  HostSlashCommand,
} from '../../protocol/hostWire';
import type { JsonObject } from '../../domain/types';

export interface ChatDispatchCommandInput {
  readonly channel: ChatUri | string;
  readonly action: HostClientChatAction;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface ChatDispatchCommand {
  readonly method: 'dispatchAction';
  readonly params: HostDispatchActionParams;
}

export interface ApprovalResolutionCommandInput {
  readonly channel: ChatUri | string;
  readonly approvalId: string;
  readonly decision: 'allow' | 'deny';
  readonly updatedInput?: JsonObject;
  readonly updatedPermissions?: readonly JsonObject[];
  readonly decisionClassification?: HostResolveApprovalParams['decisionClassification'];
  readonly message?: string;
  readonly interrupt?: boolean;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface ApprovalResolutionCommand {
  readonly method: 'chat/resolveApproval';
  readonly params: HostResolveApprovalParams;
}

export interface InputResolutionCommandInput {
  readonly channel: ChatUri | string;
  readonly inputId: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface InputResolutionCommand {
  readonly method: 'chat/resolveInput';
  readonly params: HostResolveInputParams;
}

export function buildChatDispatchCommand(input: ChatDispatchCommandInput): ChatDispatchCommand {
  const channel = parseChatUri(input.channel);
  assertCommandId(input.commandId);
  assertClientSeq(input.clientSeq);

  const action = input.action.type === 'chat/send'
    ? { type: 'chat/send' as const, prompt: normalizePrompt(input.action.prompt) }
    : { type: 'chat/interrupt' as const, turnId: assertOpaqueIdValue(input.action.turnId, 'turnId') };

  return Object.freeze({
    method: 'dispatchAction' as const,
    params: Object.freeze({
      channel,
      clientSeq: input.clientSeq,
      commandId: input.commandId,
      action: Object.freeze(action),
    }),
  });
}

export function buildApprovalResolutionCommand(input: ApprovalResolutionCommandInput): ApprovalResolutionCommand {
  const channel = parseChatUri(input.channel);
  assertCommandId(input.commandId);
  assertClientSeq(input.clientSeq);
  assertOpaqueId(input.approvalId, 'approvalId');

  return Object.freeze({
    method: 'chat/resolveApproval' as const,
    params: Object.freeze({
      channel,
      clientSeq: input.clientSeq,
      commandId: input.commandId,
      approvalId: input.approvalId,
      decision: input.decision,
      ...(input.updatedInput === undefined ? {} : { updatedInput: input.updatedInput }),
      ...(input.updatedPermissions === undefined ? {} : { updatedPermissions: input.updatedPermissions }),
      ...(input.decisionClassification === undefined ? {} : { decisionClassification: input.decisionClassification }),
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
    }),
  });
}

export function buildInputResolutionCommand(input: InputResolutionCommandInput): InputResolutionCommand {
  const channel = parseChatUri(input.channel);
  assertCommandId(input.commandId);
  assertClientSeq(input.clientSeq);
  assertOpaqueId(input.inputId, 'inputId');

  return Object.freeze({
    method: 'chat/resolveInput' as const,
    params: Object.freeze({
      channel,
      clientSeq: input.clientSeq,
      commandId: input.commandId,
      inputId: input.inputId,
      ...(input.answers === undefined ? {} : { answers: input.answers }),
    }),
  });
}

export type InteractionResolutionResult = HostInteractionResolutionResult;

export interface ComposerTextSelection {
  readonly start: number;
  readonly end: number;
}

export interface SlashCommandInsertion {
  readonly cursor: number;
  readonly text: string;
}

/** Insert a Host-provided slash command at the current composer selection. */
export function insertSlashCommand(
  draft: string,
  selection: ComposerTextSelection,
  command: Pick<HostSlashCommand, 'name' | 'argumentHint'>,
): SlashCommandInsertion {
  const start = clampSelectionOffset(Math.min(selection.start, selection.end), draft.length);
  const end = clampSelectionOffset(Math.max(selection.start, selection.end), draft.length);
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const argumentHint = command.argumentHint.trim();
  const commandText = `/${command.name}${argumentHint.length === 0 ? '' : ` ${argumentHint}`}`;
  const leadingSpace = before.length > 0 && !/\s$/u.test(before) ? ' ' : '';
  const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
  const insertedText = `${leadingSpace}${commandText}${trailingSpace}`;

  return Object.freeze({
    text: `${before}${insertedText}${after}`,
    cursor: before.length + insertedText.length,
  });
}

function normalizePrompt(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('prompt is required');
  }
  return value.trim();
}

function clampSelectionOffset(value: number, textLength: number): number {
  if (!Number.isFinite(value)) return textLength;
  return Math.max(0, Math.min(textLength, Math.trunc(value)));
}

function assertCommandId(value: string): void {
  assertOpaqueId(value, 'commandId');
}

function assertClientSeq(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('clientSeq must be a positive safe integer');
  }
}

function assertOpaqueIdValue(value: string, label: string): string {
  assertOpaqueId(value, label);
  return value;
}
