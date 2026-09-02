import type {
  HostChatState,
  HostRootCatalogState,
} from '../../protocol/hostWire';
import type { JsonValue } from '../../domain/types';
import type { ChatUri } from '../../protocol/resourceUri';

type HostTurn = HostChatState['turns'][number];
type HostActiveTurn = NonNullable<HostChatState['activeTurn']>;
type HostPart = HostActiveTurn['parts'][number];
type HostApproval = HostChatState['pendingApprovals'][number];
type HostInput = NonNullable<HostChatState['pendingInputs']>[number];
type EffortLevel = NonNullable<HostRootCatalogState['sessions'][number]['effort']>;

export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'bullet'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string };

export type ChatPartViewModel =
  | {
      readonly kind: 'markdown';
      readonly id: string;
      readonly content: string;
      readonly blocks: readonly MarkdownBlock[];
    }
  | {
      readonly kind: 'reasoning';
      readonly id: string;
      readonly content: string;
      readonly collapsed: true;
    }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: string;
      readonly formattedInput: string;
      readonly status: 'running' | 'ready' | 'success' | 'error';
      readonly output?: string;
      readonly error?: string;
      readonly startedAt: string;
      readonly completedAt?: string;
    };

export interface ChatTurnViewModel {
  readonly id: string;
  readonly prompt: string;
  readonly status: 'active' | 'complete' | 'failed' | 'interrupted';
  readonly parts: readonly ChatPartViewModel[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export type ChatTranscriptItem =
  | { readonly key: string; readonly turnId: string; readonly kind: 'prompt'; readonly text: string }
  | { readonly key: string; readonly turnId: string; readonly kind: 'part'; readonly part: ChatPartViewModel }
  | { readonly key: string; readonly turnId: string; readonly kind: 'failure'; readonly status: 'failed'; readonly message: string };

export interface PendingApprovalViewModel {
  readonly id: string;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly hostName: string;
  readonly workspaceName: string;
  readonly normalizedInput: string;
  readonly input: HostApproval['input'];
}

export interface PendingInputQuestionViewModel {
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly preview?: string;
  }[];
}

export interface PendingInputViewModel {
  readonly id: string;
  readonly turnId: string;
  readonly questions: readonly PendingInputQuestionViewModel[];
}

export type StructuredInputSelections = Readonly<Record<string, readonly string[]>>;

export function buildStructuredInputAnswers(
  input: PendingInputViewModel,
  selections: StructuredInputSelections,
  customAnswers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  input.questions.forEach((question) => {
    const selected = selections[question.question] ?? [];
    const custom = customAnswers[question.question]?.trim() ?? '';
    const values = custom.length === 0 ? selected : [...selected, custom];
    if (values.length > 0) output[question.question] = values.join('、');
  });
  return Object.freeze(output);
}

export interface ChatViewModel {
  readonly status: HostChatState['status'] | 'loading' | 'missing';
  readonly statusLabel: string;
  readonly chatUri: ChatUri;
  readonly title: string;
  readonly hostName: string;
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly hostStatus: 'online' | 'degraded' | 'offline';
  readonly hostStatusLabel: string;
  /** Session model shown only when its server id maps to the current catalog. */
  readonly modelId?: string;
  readonly modelDisplayName?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly permissionMode?: NonNullable<HostRootCatalogState['sessions'][number]['permissionMode']>;
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly description?: string;
    readonly supportedEffortLevels: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  }[];
  readonly permissionModes: NonNullable<HostRootCatalogState['permissionModes']>;
  readonly history: readonly ChatTurnViewModel[];
  readonly activeTurn?: ChatTurnViewModel;
  readonly transcript: readonly ChatTranscriptItem[];
  readonly pendingApprovals: readonly PendingApprovalViewModel[];
  readonly pendingInputs: readonly PendingInputViewModel[];
  readonly hasPendingInteraction: boolean;
}

export interface ChatSelectorInput {
  readonly chatUri: ChatUri;
  readonly chatState: HostChatState | undefined;
  readonly catalog: HostRootCatalogState | undefined;
}

export function selectChatViewModel(input: ChatSelectorInput): ChatViewModel {
  const session = input.catalog?.sessions.find((candidate) => candidate.chatUri === input.chatUri);
  const workspace = session === undefined
    ? undefined
    : input.catalog?.workspaces.find((candidate) => candidate.id === session.workspaceId);
  const state = input.chatState;
  const activeId = state?.activeTurn?.id;
  const history = state === undefined
    ? []
    : state.turns.filter((turn) => turn.id !== activeId).map(projectTurn);
  const activeTurn = state?.activeTurn === undefined ? undefined : projectTurn(state.activeTurn);
  const allTurns = activeTurn === undefined ? history : [...history, activeTurn];
  const transcript: ChatTranscriptItem[] = allTurns.flatMap((turn): ChatTranscriptItem[] => [
    { key: `${turn.id}:prompt`, turnId: turn.id, kind: 'prompt' as const, text: turn.prompt },
    ...turn.parts.map((part) => ({ key: `${turn.id}:${part.id}`, turnId: turn.id, kind: 'part' as const, part })),
    ...(turn.status === 'failed' ? [{
      key: `${turn.id}:failure`,
      turnId: turn.id,
      kind: 'failure' as const,
      status: 'failed' as const,
      message: turn.error ?? summarizeTurnFailure(undefined),
    }] : []),
  ]);
  const pendingApprovals = state?.pendingApprovals.map((approval) => projectApproval(
    approval,
    input.catalog,
    session?.workspaceId,
  )) ?? [];
  const pendingInputs = state?.pendingInputs?.map(projectInput) ?? [];
  const status = state?.status ?? (session === undefined ? 'missing' : 'loading');
  const hostStatus = input.catalog?.connection.displayStatus ?? 'offline';
  const catalogModels = input.catalog?.models ?? [];
  const resolvedModel = session?.modelId === undefined
    ? undefined
    : catalogModels.find((candidate) => candidate.id === session.modelId);
  const supportedEffortLevels = resolvedModel === undefined
    ? []
    : resolveSupportedEffortLevels(resolvedModel);
  // Keep an explicitly canonical session effort visible even when an older
  // catalog omits its supported list; never synthesize the list itself.
  const effort = resolvedModel !== undefined
    && session?.effort !== undefined
    && (resolvedModel.supportedEffortLevels === undefined || supportedEffortLevels.includes(session.effort))
    ? session.effort
    : undefined;

  return Object.freeze({
    status,
    statusLabel: chatStatusLabel(status),
    chatUri: input.chatUri,
    title: session?.title ?? '新对话',
    hostName: input.catalog?.host.displayName ?? 'Host',
    workspaceName: workspace?.displayName ?? session?.workspaceId ?? '工作区',
    workspacePath: workspace?.path ?? '',
    hostStatus,
    hostStatusLabel: hostStatusLabel(hostStatus),
    ...(resolvedModel === undefined ? {} : { modelId: resolvedModel.id, modelDisplayName: resolvedModel.displayName }),
    ...(effort === undefined ? {} : { effort }),
    ...(session?.permissionMode === undefined ? {} : { permissionMode: session.permissionMode }),
    models: Object.freeze(catalogModels.map((model) => Object.freeze({
      id: model.id,
      displayName: model.displayName,
      ...(model.description === undefined ? {} : { description: model.description }),
      supportedEffortLevels: resolveSupportedEffortLevels(model),
    }))),
    permissionModes: Object.freeze([...(input.catalog?.permissionModes ?? [])]),
    history: Object.freeze(history),
    ...(activeTurn === undefined ? {} : { activeTurn }),
    transcript: Object.freeze(transcript),
    pendingApprovals: Object.freeze(pendingApprovals),
    pendingInputs: Object.freeze(pendingInputs),
    hasPendingInteraction: pendingApprovals.length > 0 || pendingInputs.length > 0,
  });
}

function resolveSupportedEffortLevels(
  model: HostRootCatalogState['models'][number],
): readonly EffortLevel[] {
  if (model.supportedEffortLevels !== undefined) {
    return Object.freeze([...model.supportedEffortLevels]);
  }
  return Object.freeze([]);
}

export function parseMarkdownBlocks(content: string): readonly MarkdownBlock[] {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let language = '';

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim();
    if (text.length > 0) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (code !== undefined) {
      if (trimmed.startsWith('```')) {
        blocks.push({ kind: 'code', language, text: code.join('\n') });
        code = undefined;
        language = '';
      } else {
        code.push(line);
      }
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushParagraph();
      code = [];
      language = trimmed.slice(3).trim();
      continue;
    }
    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/u.exec(trimmed);
    if (bullet !== null) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: bullet[1] ?? '' });
      continue;
    }
    paragraph.push(trimmed);
  }

  if (code !== undefined) blocks.push({ kind: 'code', language, text: code.join('\n') });
  flushParagraph();
  return Object.freeze(blocks);
}

function projectTurn(turn: HostTurn | HostActiveTurn): ChatTurnViewModel {
  const completedAt = 'completedAt' in turn ? turn.completedAt : undefined;
  const error = 'error' in turn ? summarizeTurnFailure(turn.error) : undefined;
  return Object.freeze({
    id: turn.id,
    prompt: turn.prompt,
    status: turn.status === 'active' ? 'active' : turn.status,
    parts: Object.freeze(turn.parts.map(projectPart)),
    startedAt: turn.startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined ? {} : { error }),
  });
}

const DEFAULT_TURN_FAILURE_MESSAGE = 'Host 未能完成这次请求，请稍后重试。';
const MAX_TURN_FAILURE_MESSAGE_LENGTH = 240;

export function summarizeTurnFailure(error: string | undefined): string {
  if (error === undefined) return DEFAULT_TURN_FAILURE_MESSAGE;

  const firstUsefulLine = error
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^at\s+/u.test(line) && !/^(?:caused by|stack trace):?$/iu.test(line));
  const message = firstUsefulLine?.replace(/\s+/gu, ' ').trim();
  if (message === undefined || message.length === 0) return DEFAULT_TURN_FAILURE_MESSAGE;
  return message.length <= MAX_TURN_FAILURE_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_TURN_FAILURE_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

/** Format a turn duration only from valid, non-negative persisted timestamps. */
export function formatTurnDuration(startedAt: string, completedAt: string): string | undefined {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (
    !Number.isFinite(startedMs)
    || !Number.isFinite(completedMs)
    || startedMs < 0
    || completedMs < 0
    || completedMs < startedMs
  ) {
    return undefined;
  }
  const elapsedSeconds = Math.floor((completedMs - startedMs) / 1000);
  return `用时${Math.floor(elapsedSeconds / 60)}分${String(elapsedSeconds % 60).padStart(2, '0')}秒`;
}

function projectPart(part: HostPart): ChatPartViewModel {
  switch (part.kind) {
    case 'markdown':
      return Object.freeze({ kind: 'markdown', id: part.id, content: part.content, blocks: parseMarkdownBlocks(part.content) });
    case 'reasoning':
      return Object.freeze({ kind: 'reasoning', id: part.id, content: part.content, collapsed: true });
    case 'tool_call': {
      const tool = part.toolCall;
      const status = tool.status === 'started'
        ? 'running'
        : tool.status === 'ready'
          ? 'ready'
          : tool.error === undefined ? 'success' : 'error';
      return Object.freeze({
        kind: 'tool',
        id: part.id,
        toolCallId: tool.id,
        name: tool.name,
        input: tool.input,
        formattedInput: formatToolInput(tool.input),
        status,
        ...(tool.result === undefined ? {} : { output: tool.result }),
        ...(tool.error === undefined ? {} : { error: tool.error }),
        startedAt: tool.startedAt,
        ...(tool.completedAt === undefined ? {} : { completedAt: tool.completedAt }),
      });
    }
  }
}

function projectApproval(
  approval: HostApproval,
  catalog: HostRootCatalogState | undefined,
  workspaceId: string | undefined,
): PendingApprovalViewModel {
  const workspace = catalog?.workspaces.find((candidate) => candidate.id === workspaceId);
  return Object.freeze({
    id: approval.id,
    turnId: approval.turnId,
    ...(approval.toolCallId === undefined ? {} : { toolCallId: approval.toolCallId }),
    toolName: approval.toolName ?? '工具调用',
    displayName: approval.displayName ?? approval.title ?? approval.toolName ?? '工具调用',
    ...(approval.description === undefined ? {} : { description: approval.description }),
    hostName: catalog?.host.displayName ?? 'Host',
    workspaceName: workspace?.displayName ?? workspaceId ?? '工作区',
    normalizedInput: normalizeApprovalInput(approval.input),
    input: approval.input,
  });
}

function projectInput(input: HostInput): PendingInputViewModel {
  return Object.freeze({
    id: input.id,
    turnId: input.turnId,
    questions: Object.freeze(input.questions.map((question) => Object.freeze({
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      options: Object.freeze(question.options.map((option) => Object.freeze({
        label: option.label,
        description: option.description,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      }))),
    }))),
  });
}

function formatToolInput(value: string): string {
  if (value.trim().length === 0) return '';
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function normalizeApprovalInput(input: HostApproval['input'] | undefined): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return '{}';
  return entries.map(([key, value]) => `${key}: ${formatJsonValue(value)}`).join('\n');
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function hostStatusLabel(status: ChatViewModel['hostStatus']): string {
  switch (status) {
    case 'online': return '已连接';
    case 'degraded': return '连接不稳定';
    case 'offline': return '未连接';
  }
}

function chatStatusLabel(status: ChatViewModel['status']): string {
  switch (status) {
    case 'idle': return '待命';
    case 'in_progress': return '处理中';
    case 'input_needed': return '等待你的输入';
    case 'error': return '执行失败';
    case 'loading': return '同步中';
    case 'missing': return '找不到会话';
  }
}
