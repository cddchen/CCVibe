import type {
  CanUseTool,
  PermissionDecisionClassification,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionInput as SdkAskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';

/** The callback arguments are always derived from the SDK declaration. */
export type CanUseToolParameters = Parameters<CanUseTool>;
export type CanUseToolOptions = CanUseToolParameters[2];
export type AskUserQuestionInput = SdkAskUserQuestionInput;
export type AskUserQuestion = AskUserQuestionInput['questions'][number];
/**
 * Answers are a bridge/domain value, not part of the SDK's request input.
 * Keep this local shape independent from optional SDK tool annotations so the
 * request adapter never invents or requires an `answers` field on the SDK
 * `AskUserQuestionInput`.
 */
export type InputAnswers = Readonly<Record<string, string>>;

export type InteractionKind = 'approval' | 'input';
export type InteractionId = string;
export type InteractionChat = string;
export type InteractionTurn = string;

export interface InputRequestedAction {
  readonly type: 'chat/inputRequested';
  readonly turnId: InteractionTurn;
  readonly inputId: InteractionId;
  readonly questions: readonly AskUserQuestion[];
  readonly requestedAt?: string;
  readonly timestamp: string;
}

export interface InputResolvedAction {
  readonly type: 'chat/inputResolved';
  readonly turnId: InteractionTurn;
  readonly inputId: InteractionId;
  readonly answers: InputAnswers;
  readonly timestamp: string;
}

export interface ApprovalRequestedAction {
  readonly type: 'chat/approvalRequested';
  readonly turnId: InteractionTurn;
  readonly approvalId: InteractionId;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly suggestions?: readonly PermissionUpdate[];
  readonly requestId?: string;
  readonly toolUseId?: string;
  readonly toolUseID?: string;
  readonly agentId?: string;
  readonly agentID?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly matchedAskRule?: CanUseToolOptions['matchedAskRule'];
  readonly requestedAt: string;
  readonly timestamp: string;
}

export interface ApprovalResolvedAction {
  readonly type: 'chat/approvalResolved';
  readonly turnId: InteractionTurn;
  readonly approvalId: InteractionId;
  readonly decision: 'allow' | 'deny';
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedPermissions?: readonly PermissionUpdate[];
  readonly message?: string;
  readonly interrupt?: boolean;
  readonly decisionClassification?: PermissionDecisionClassification;
  readonly timestamp: string;
}

export type InteractionAction =
  | InputRequestedAction
  | InputResolvedAction
  | ApprovalRequestedAction
  | ApprovalResolvedAction;

/**
 * The registry intentionally accepts a narrow action boundary.  The domain
 * package can later make these action shapes part of its public union without
 * making this Promise/timer shell depend on the domain implementation.
 */
export type InteractionActionDispatcher = (
  chat: InteractionChat,
  action: InteractionAction,
) => unknown;

export interface InteractionTimer {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface PendingInteractionRegistryOptions {
  readonly dispatch: InteractionActionDispatcher;
  readonly now?: () => string;
  readonly clock?: (() => string) | { readonly now: () => string };
  readonly createApprovalId?: () => InteractionId;
  readonly createInputId?: () => InteractionId;
  readonly createInteractionId?: () => InteractionId;
  readonly allocateApprovalId?: () => InteractionId;
  readonly allocateInputId?: () => InteractionId;
  readonly allocateId?: () => InteractionId;
  readonly approvalTimeoutMs?: number;
  readonly inputTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly timer?: InteractionTimer;
  readonly setTimeout?: InteractionTimer['setTimeout'];
  readonly clearTimeout?: InteractionTimer['clearTimeout'];
}

export interface RequestApprovalInput {
  readonly chat?: InteractionChat;
  /** `chatUri` is accepted as the architecture document's spelling. */
  readonly chatUri?: InteractionChat;
  readonly turnId: InteractionTurn;
  readonly approvalId?: InteractionId;
  readonly id?: InteractionId;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly input: CanUseToolParameters[1];
  readonly options?: CanUseToolOptions;
  readonly signal?: AbortSignal;
  readonly toolUseID?: string;
  readonly timeoutMs?: number;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly suggestions?: CanUseToolOptions['suggestions'];
  readonly requestId?: string;
  readonly toolUseId?: string;
  readonly agentId?: string;
  readonly agentID?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly matchedAskRule?: CanUseToolOptions['matchedAskRule'];
}

export interface RequestInputInput {
  readonly chat?: InteractionChat;
  readonly chatUri?: InteractionChat;
  readonly turnId: InteractionTurn;
  readonly inputId?: InteractionId;
  readonly id?: InteractionId;
  readonly questions?: AskUserQuestionInput['questions'] | AskUserQuestionInput;
  readonly input?: AskUserQuestionInput;
  readonly toolInput?: AskUserQuestionInput;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly toolUseID?: string;
}

export type ApprovalDecisionInput =
  | 'allow'
  | 'deny'
  | boolean
  | PermissionResult;

export interface ResolveApprovalInput {
  readonly chat?: InteractionChat;
  readonly chatUri?: InteractionChat;
  readonly approvalId: InteractionId;
  readonly decision: ApprovalDecisionInput;
  /** Full SDK result aliases are useful to protocol adapters. */
  readonly result?: PermissionResult;
  readonly permissionResult?: PermissionResult;
  readonly updatedInput?: Record<string, unknown>;
  readonly updatedPermissions?: PermissionUpdate[];
  readonly decisionClassification?: PermissionDecisionClassification;
  readonly message?: string;
  readonly interrupt?: boolean;
}

export interface ResolveInputInput {
  readonly chat?: InteractionChat;
  readonly chatUri?: InteractionChat;
  readonly inputId: InteractionId;
  readonly answers?: InputAnswers;
}

export type ResolveResult =
  | {
      readonly status: 'resolved';
      readonly kind: InteractionKind;
      readonly id: InteractionId;
    }
  | {
      readonly status: 'already_resolved';
      readonly kind: InteractionKind;
      readonly id: InteractionId;
    }
  | {
      readonly status: 'not_found' | 'chat_mismatch' | 'kind_mismatch';
      readonly kind: InteractionKind;
      readonly id: InteractionId;
    }
  | {
      readonly status: 'rejected';
      readonly kind: InteractionKind;
      readonly id: InteractionId;
      readonly code:
        | 'invalid_decision'
        | 'invalid_answers'
        | 'invalid_request'
        | 'dispatch_failed'
        | 'disposed';
      readonly message: string;
    };

export interface PendingApprovalSnapshot {
  readonly kind: 'approval';
  readonly chat: InteractionChat;
  readonly turnId: InteractionTurn;
  readonly approvalId: InteractionId;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly title?: string;
  readonly description?: string;
  readonly suggestions?: readonly PermissionUpdate[];
  readonly displayName?: string;
  readonly requestId?: string;
  readonly toolUseId?: string;
  readonly agentId?: string;
  readonly agentID?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly matchedAskRule?: CanUseToolOptions['matchedAskRule'];
  readonly requestedAt: string;
  readonly sdkRequestId?: string;
  readonly toolUseID?: string;
}

export interface PendingInputSnapshot {
  readonly kind: 'input';
  readonly chat: InteractionChat;
  readonly turnId: InteractionTurn;
  readonly inputId: InteractionId;
  readonly questions: readonly AskUserQuestion[];
  readonly requestedAt: string;
  readonly toolUseID?: string;
}

export type PendingInteractionSnapshot = PendingApprovalSnapshot | PendingInputSnapshot;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface BaseEntry {
  readonly kind: InteractionKind;
  readonly id: InteractionId;
  readonly key: string;
  readonly chat: InteractionChat;
  readonly turnId: InteractionTurn;
  readonly requestedAt: string;
  readonly deferred: Deferred<unknown>;
  readonly signal: AbortSignal | undefined;
  abortListener?: () => void;
  timerHandle: unknown;
  settling: boolean;
}

interface ApprovalEntry extends BaseEntry {
  readonly kind: 'approval';
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCallId: string | undefined;
  readonly title: string | undefined;
  readonly displayName: string | undefined;
  readonly description: string | undefined;
  readonly suggestions: readonly PermissionUpdate[] | undefined;
  readonly sdkRequestId: string | undefined;
  readonly toolUseID: string | undefined;
  readonly toolUseId: string | undefined;
  readonly requestId: string | undefined;
  readonly agentId: string | undefined;
  readonly agentID: string | undefined;
  readonly blockedPath: string | undefined;
  readonly decisionReason: string | undefined;
  readonly matchedAskRule: CanUseToolOptions['matchedAskRule'] | undefined;
}

interface InputEntry extends BaseEntry {
  readonly kind: 'input';
  readonly questions: readonly AskUserQuestion[];
  readonly toolUseID: string | undefined;
}

type Entry = ApprovalEntry | InputEntry;

interface Tombstone {
  readonly kind: InteractionKind;
  readonly id: InteractionId;
  readonly chat: InteractionChat;
}

const DEFAULT_APPROVAL_DENY_MESSAGE = 'Permission request was not approved';
const SDK_ABORTED_MESSAGE = 'SDK aborted the tool request';
const TIMEOUT_MESSAGE = 'Permission request timed out';
const CHAT_CANCELLED_MESSAGE = 'Chat was cancelled';
const REGISTRY_DISPOSED_MESSAGE = 'Interaction registry was disposed';
const INVALID_QUESTION_MESSAGE = 'AskUserQuestion called without valid questions';
const INVALID_JSON = Symbol('invalid-json');

/**
 * Owns all parked SDK interaction waiters for one Host process.
 *
 * The mutable maps and Promise resolvers are deliberately kept here.  Action
 * construction, validation and ID/time values are supplied at this boundary;
 * reducers never need to inspect this shell.
 */
export class PendingInteractionRegistry {
  private readonly dispatch: InteractionActionDispatcher;
  private readonly now: () => string;
  private readonly createApprovalId: () => InteractionId;
  private readonly createInputId: () => InteractionId;
  private readonly approvalTimeoutMs: number | undefined;
  private readonly inputTimeoutMs: number | undefined;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly timer: InteractionTimer;
  private readonly pending = new Map<string, Entry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private disposed = false;

  public constructor(options: PendingInteractionRegistryOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('options must be an object');
    }
    if (typeof options.dispatch !== 'function') {
      throw new TypeError('dispatch must be a function');
    }
    const now = options.now
      ?? (typeof options.clock === 'function' ? options.clock : options.clock?.now);
    if (typeof now !== 'function') {
      throw new TypeError('now must be an injected clock function');
    }

    const genericId = options.createInteractionId ?? options.allocateId;
    const approvalId = options.createApprovalId ?? options.allocateApprovalId ?? genericId;
    const inputId = options.createInputId ?? options.allocateInputId ?? genericId;
    if (typeof approvalId !== 'function' || typeof inputId !== 'function') {
      throw new TypeError('an explicit interaction ID allocator is required');
    }

    this.dispatch = options.dispatch;
    this.now = now;
    this.createApprovalId = approvalId;
    this.createInputId = inputId;
    this.approvalTimeoutMs = validateTimeout(options.approvalTimeoutMs, 'approvalTimeoutMs');
    this.inputTimeoutMs = validateTimeout(options.inputTimeoutMs, 'inputTimeoutMs');
    this.defaultTimeoutMs = validateTimeout(options.timeoutMs, 'timeoutMs');
    if (options.timer !== undefined) {
      this.timer = options.timer;
    } else if (typeof options.setTimeout === 'function' && typeof options.clearTimeout === 'function') {
      this.timer = {
        setTimeout: options.setTimeout,
        clearTimeout: options.clearTimeout,
      };
    } else {
      throw new TypeError('an explicit timer with setTimeout and clearTimeout is required');
    }
    if (typeof this.timer.setTimeout !== 'function' || typeof this.timer.clearTimeout !== 'function') {
      throw new TypeError('timer must provide setTimeout and clearTimeout');
    }
  }

  public get size(): number {
    return this.pending.size;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public snapshots(): readonly PendingInteractionSnapshot[] {
    const result: PendingInteractionSnapshot[] = [];
    for (const entry of this.pending.values()) {
      result.push(snapshotEntry(entry));
    }
    return Object.freeze(result);
  }

  public getPending(kind: InteractionKind, id: InteractionId): PendingInteractionSnapshot | undefined {
    const entry = this.pending.get(entryKey(kind, id));
    return entry === undefined ? undefined : snapshotEntry(entry);
  }

  public requestApproval(input: RequestApprovalInput): Promise<PermissionResult> {
    const chat = resolveChat(input);
    if (this.disposed) {
      return Promise.resolve(denyResult(REGISTRY_DISPOSED_MESSAGE));
    }
    if (!isNonEmptyString(chat) || !isNonEmptyString(input?.turnId) || !isNonEmptyString(input?.toolName)) {
      return Promise.resolve(denyResult('Invalid permission request'));
    }
    const rawInput = cloneJsonObject(input.input);
    if (rawInput === undefined) {
      return Promise.resolve(denyResult('Invalid permission input'));
    }

    const options = input.options;
    const id = input.approvalId ?? input.id ?? this.allocateApprovalId();
    if (!isNonEmptyString(id)) {
      return Promise.resolve(denyResult('Invalid permission request ID'));
    }
    const key = entryKey('approval', id);
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      return existing.chat === chat
        ? existing.deferred.promise as Promise<PermissionResult>
        : Promise.resolve(denyResult('Permission request belongs to another chat'));
    }
    if (this.tombstones.has(key)) {
      return Promise.resolve(denyResult('Permission request was already settled'));
    }

    const requestedAt = this.timestamp();
    if (requestedAt === undefined) {
      return Promise.resolve(denyResult('Unable to timestamp permission request'));
    }
    const deferred = createDeferred<PermissionResult>();
    const entry: ApprovalEntry = {
      kind: 'approval',
      id,
      key,
      chat,
      turnId: input.turnId,
      requestedAt,
      deferred: deferred as Deferred<unknown>,
      signal: options?.signal ?? input.signal,
      timerHandle: undefined,
      settling: false,
      toolName: input.toolName,
      input: rawInput,
      toolCallId: input.toolCallId,
      title: input.title ?? options?.title,
      displayName: input.displayName ?? options?.displayName,
      description: input.description ?? options?.description,
      suggestions: copyPermissionUpdates(input.suggestions ?? options?.suggestions),
      sdkRequestId: options?.requestId ?? input.requestId,
      toolUseID: options?.toolUseID ?? input.toolUseID,
      toolUseId: input.toolUseId,
      requestId: input.requestId ?? options?.requestId,
      agentId: input.agentId,
      agentID: input.agentID ?? options?.agentID,
      blockedPath: input.blockedPath ?? options?.blockedPath,
      decisionReason: input.decisionReason ?? options?.decisionReason,
      matchedAskRule: input.matchedAskRule ?? options?.matchedAskRule,
    };
    this.pending.set(key, entry);

    const requestAction: ApprovalRequestedAction = {
      type: 'chat/approvalRequested',
      turnId: entry.turnId,
      approvalId: entry.id,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      toolName: entry.toolName,
      input: entry.input,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.suggestions === undefined ? {} : { suggestions: entry.suggestions }),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.toolUseId === undefined ? {} : { toolUseId: entry.toolUseId }),
      ...(entry.toolUseID === undefined ? {} : { toolUseID: entry.toolUseID }),
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
      ...(entry.agentID === undefined ? {} : { agentID: entry.agentID }),
      ...(entry.blockedPath === undefined ? {} : { blockedPath: entry.blockedPath }),
      ...(entry.decisionReason === undefined ? {} : { decisionReason: entry.decisionReason }),
      ...(entry.matchedAskRule === undefined ? {} : { matchedAskRule: entry.matchedAskRule }),
      requestedAt,
      timestamp: requestedAt,
    };
    if (!this.dispatchRequest(entry, requestAction)) {
      this.failEntry(entry, DEFAULT_APPROVAL_DENY_MESSAGE, undefined);
    } else if (!entry.settling) {
      // Publish the request before installing cancellation hooks. This keeps
      // the action stream ordered even for an already-aborted signal and also
      // permits a synchronous/reentrant dispatcher to resolve this entry.
      this.attachAbort(entry);
      this.arm(entry, input.timeoutMs ?? this.approvalTimeoutMs ?? this.defaultTimeoutMs);
    }
    return deferred.promise;
  }

  public requestInput(input: RequestInputInput): Promise<InputAnswers | undefined> {
    const chat = resolveChat(input);
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    if (!isNonEmptyString(chat) || !isNonEmptyString(input?.turnId)) {
      return Promise.resolve(undefined);
    }
    const questions = extractQuestions(input.questions ?? input.input ?? input.toolInput);
    if (questions === undefined) {
      return Promise.resolve(undefined);
    }
    const id = input.inputId ?? input.id ?? this.allocateInputId();
    if (!isNonEmptyString(id)) {
      return Promise.resolve(undefined);
    }
    const key = entryKey('input', id);
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      return existing.chat === chat
        ? existing.deferred.promise as Promise<InputAnswers | undefined>
        : Promise.resolve(undefined);
    }
    if (this.tombstones.has(key)) {
      return Promise.resolve(undefined);
    }

    const requestedAt = this.timestamp();
    if (requestedAt === undefined) {
      return Promise.resolve(undefined);
    }
    const deferred = createDeferred<InputAnswers | undefined>();
    const entry: InputEntry = {
      kind: 'input',
      id,
      key,
      chat,
      turnId: input.turnId,
      requestedAt,
      deferred: deferred as Deferred<unknown>,
      signal: input.signal,
      timerHandle: undefined,
      settling: false,
      questions,
      toolUseID: input.toolUseID,
    };
    this.pending.set(key, entry);
    const requestAction: InputRequestedAction = {
      type: 'chat/inputRequested',
      turnId: entry.turnId,
      inputId: entry.id,
      questions: entry.questions,
      requestedAt,
      timestamp: requestedAt,
    };
    if (!this.dispatchRequest(entry, requestAction)) {
      this.failEntry(entry, 'Unable to publish input request', undefined);
    } else if (!entry.settling) {
      this.attachAbort(entry);
      this.arm(entry, input.timeoutMs ?? this.inputTimeoutMs ?? this.defaultTimeoutMs);
    }
    return deferred.promise;
  }

  public resolveApproval(input: ResolveApprovalInput): ResolveResult {
    const id = input?.approvalId;
    const base = this.lookup('approval', id, resolveChat(input));
    if ('status' in base) {
      return base;
    }
    if (base.entry.kind !== 'approval') {
      return { status: 'kind_mismatch', kind: 'approval', id };
    }
    const result = permissionResultFromInput(base.entry, input);
    if (result === undefined) {
      return rejected('approval', id, 'invalid_decision', 'Invalid permission decision');
    }
    const action: ApprovalResolvedAction = {
      type: 'chat/approvalResolved',
      turnId: base.entry.turnId,
      approvalId: id,
      decision: result.behavior,
      ...(result.behavior === 'allow' && result.updatedInput === undefined
        ? {}
        : result.behavior === 'allow'
          ? { updatedInput: result.updatedInput }
          : {}),
      ...(result.behavior === 'allow' && result.updatedPermissions === undefined
        ? {}
        : result.behavior === 'allow'
          ? { updatedPermissions: result.updatedPermissions }
          : {}),
      ...(result.behavior === 'deny' ? { message: result.message } : {}),
      ...(result.behavior === 'deny' && result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
      ...(result.decisionClassification === undefined
        ? {}
        : { decisionClassification: result.decisionClassification }),
      timestamp: this.timestamp() ?? base.entry.requestedAt,
    };
    const dispatchError = this.claimAndDispatch(base.entry, action);
    const settled = dispatchError === undefined ? result : denyResult(DEFAULT_APPROVAL_DENY_MESSAGE);
    this.finish(base.entry, settled);
    return dispatchError === undefined
      ? { status: 'resolved', kind: 'approval', id }
      : rejected('approval', id, 'dispatch_failed', 'Unable to publish permission resolution');
  }

  public resolveInput(input: ResolveInputInput): ResolveResult {
    const id = input?.inputId;
    const base = this.lookup('input', id, resolveChat(input));
    if ('status' in base) {
      return base;
    }
    if (base.entry.kind !== 'input') {
      return { status: 'kind_mismatch', kind: 'input', id };
    }
    const answers = input.answers === undefined ? undefined : validateAnswers(input.answers, base.entry.questions);
    if (input.answers !== undefined && answers === undefined) {
      return rejected('input', id, 'invalid_answers', 'Invalid structured input answers');
    }
    const action: InputResolvedAction = {
      type: 'chat/inputResolved',
      turnId: base.entry.turnId,
      inputId: id,
      answers: answers ?? {},
      timestamp: this.timestamp() ?? base.entry.requestedAt,
    };
    const dispatchError = this.claimAndDispatch(base.entry, action);
    this.finish(base.entry, dispatchError === undefined ? answers : undefined);
    return dispatchError === undefined
      ? { status: 'resolved', kind: 'input', id }
      : rejected('input', id, 'dispatch_failed', 'Unable to publish input resolution');
  }

  /** Cancel all parked interactions for one chat; disconnect is intentionally not a caller. */
  public cancelChat(chat: InteractionChat, reason = CHAT_CANCELLED_MESSAGE): void {
    if (!isNonEmptyString(chat)) {
      return;
    }
    const safeReason = isNonEmptyString(reason) ? reason : CHAT_CANCELLED_MESSAGE;
    for (const entry of [...this.pending.values()]) {
      if (entry.chat !== chat) {
        continue;
      }
      this.cancelEntry(entry, safeReason);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of [...this.pending.values()]) {
      this.cancelEntry(entry, REGISTRY_DISPOSED_MESSAGE);
    }
  }

  /** Construct an SDK callback for one chat/turn context. */
  public createCanUseTool(
    context: CanUseToolContext | CanUseToolContextResolver,
  ): CanUseTool {
    return async (...args: CanUseToolParameters): Promise<PermissionResult> => {
      let resolvedContext: CanUseToolContext;
      try {
        resolvedContext = typeof context === 'function' ? context(...args) : context;
      } catch {
        return denyResult('Unable to route permission request');
      }
      if (!isValidContext(resolvedContext)) {
        return denyResult('Unable to route permission request');
      }
      return this.handleCanUseTool(resolvedContext, args[0], args[1], args[2]);
    };
  }

  /** Alias used by adapter composition code. */
  public asCanUseTool(context: CanUseToolContext | CanUseToolContextResolver): CanUseTool {
    return this.createCanUseTool(context);
  }

  private handleCanUseTool(
    context: CanUseToolContext,
    toolName: CanUseToolParameters[0],
    toolInput: CanUseToolParameters[1],
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    if (options.signal.aborted) {
      return Promise.resolve(denyResult(SDK_ABORTED_MESSAGE));
    }
    if (toolName === 'AskUserQuestion') {
      const askInput = extractAskInput(toolInput);
      if (askInput === undefined) {
        return Promise.resolve(denyResult(INVALID_QUESTION_MESSAGE));
      }
      return this.requestInput({
        chat: context.chat,
        turnId: context.turnId,
        questions: askInput.questions,
        signal: options.signal,
        inputId: options.toolUseID,
        toolUseID: options.toolUseID,
      }).then((answers) => {
        if (answers === undefined) {
          return denyResult('Question was cancelled');
        }
        return {
          behavior: 'allow',
          updatedInput: { ...toolInput, answers },
        } satisfies PermissionResult;
      });
    }

    return this.requestApproval({
      chat: context.chat,
      turnId: context.turnId,
      toolName,
      input: toolInput,
      options,
    }).then((result) => result);
  }

  private lookup(
    kind: InteractionKind,
    id: InteractionId,
    chat: InteractionChat,
  ): { readonly entry: Entry } | ResolveResult {
    if (!isNonEmptyString(id)) {
      return rejected(kind, id, 'invalid_request', 'Invalid interaction ID');
    }
    const entry = this.pending.get(entryKey(kind, id));
    if (entry !== undefined) {
      if (entry.chat !== chat) {
        return { status: 'chat_mismatch', kind, id };
      }
      return { entry };
    }
    const tombstone = this.tombstones.get(entryKey(kind, id));
    if (tombstone !== undefined) {
      return { status: 'already_resolved', kind, id };
    }
    // If the ID belongs to another interaction kind, do not accidentally
    // answer it through the wrong protocol endpoint.
    for (const candidate of this.pending.values()) {
      if (candidate.id === id) {
        return { status: 'kind_mismatch', kind, id };
      }
    }
    return { status: 'not_found', kind, id };
  }

  private claimAndDispatch(entry: Entry, action: InteractionAction): unknown {
    // Claim before dispatch.  A hostile/reentrant dispatcher cannot let a
    // second writer win while the first resolution action is being emitted.
    entry.settling = true;
    this.pending.delete(entry.key);
    this.tombstones.set(entry.key, { kind: entry.kind, id: entry.id, chat: entry.chat });
    this.clearEntry(entry);
    try {
      this.dispatch(entry.chat, action);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private finish(entry: Entry, value: unknown): void {
    entry.deferred.resolve(value);
  }

  private cancelEntry(entry: Entry, reason: string): void {
    if (entry.settling) {
      return;
    }
    const timestamp = this.timestamp() ?? entry.requestedAt;
    const action: InteractionAction = entry.kind === 'approval'
      ? {
          type: 'chat/approvalResolved',
          turnId: entry.turnId,
          approvalId: entry.id,
          decision: 'deny',
          message: reason,
          timestamp,
        }
      : {
          type: 'chat/inputResolved',
          turnId: entry.turnId,
          inputId: entry.id,
          answers: {},
          timestamp,
        };
    const dispatchError = this.claimAndDispatch(entry, action);
    if (entry.kind === 'approval') {
      this.finish(entry, denyResult(dispatchError === undefined ? reason : DEFAULT_APPROVAL_DENY_MESSAGE));
    } else {
      this.finish(entry, undefined);
    }
  }

  private failEntry(entry: Entry, message: string, action: InteractionAction | undefined): void {
    if (entry.settling) {
      return;
    }
    if (action !== undefined) {
      this.claimAndDispatch(entry, action);
    } else {
      entry.settling = true;
      this.pending.delete(entry.key);
      this.tombstones.set(entry.key, { kind: entry.kind, id: entry.id, chat: entry.chat });
      this.clearEntry(entry);
    }
    this.finish(entry, entry.kind === 'approval' ? denyResult(message) : undefined);
  }

  private dispatchRequest(entry: Entry, action: InteractionAction): boolean {
    try {
      this.dispatch(entry.chat, action);
      return true;
    } catch {
      return false;
    }
  }

  private allocateApprovalId(): InteractionId | undefined {
    try {
      return this.createApprovalId();
    } catch {
      return undefined;
    }
  }

  private allocateInputId(): InteractionId | undefined {
    try {
      return this.createInputId();
    } catch {
      return undefined;
    }
  }

  private arm(entry: Entry, timeoutMs: number | undefined): void {
    if (timeoutMs === undefined || entry.settling || this.pending.get(entry.key) !== entry) {
      return;
    }
    let callbackRunning = false;
    const onTimeout = (): void => {
      callbackRunning = true;
      if (entry.settling || this.pending.get(entry.key) !== entry) {
        return;
      }
      this.cancelEntry(entry, TIMEOUT_MESSAGE);
    };
    let handle: unknown;
    try {
      handle = this.timer.setTimeout(onTimeout, timeoutMs);
    } catch {
      this.cancelEntry(entry, TIMEOUT_MESSAGE);
      return;
    }
    // A deterministic fake timer may invoke a zero-delay callback inline. In
    // that case cancellation ran before setTimeout returned; avoid retaining
    // a stale handle and perform best-effort cleanup immediately.
    if (callbackRunning || entry.settling || this.pending.get(entry.key) !== entry) {
      try {
        this.timer.clearTimeout(handle);
      } catch {
        // The tombstone already fences a late callback.
      }
      return;
    }
    entry.timerHandle = handle;
  }

  private attachAbort(entry: Entry): void {
    const signal = entry.signal;
    if (signal === undefined || entry.settling || this.pending.get(entry.key) !== entry) {
      return;
    }
    const onAbort = (): void => {
      this.cancelEntry(entry, SDK_ABORTED_MESSAGE);
    };
    // The SDK contract permits an already-aborted signal, including a signal
    // aborted between the request's initial check and listener installation.
    entry.abortListener = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  }

  private clearEntry(entry: Entry): void {
    if (entry.timerHandle !== undefined) {
      try {
        this.timer.clearTimeout(entry.timerHandle);
      } catch {
        // Timer cleanup is best effort; the settling tombstone still fences it.
      }
      entry.timerHandle = undefined;
    }
    if (entry.abortListener !== undefined && entry.signal !== undefined) {
      entry.signal.removeEventListener('abort', entry.abortListener);
      delete entry.abortListener;
    }
  }

  private timestamp(): string | undefined {
    try {
      const value = this.now();
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface CanUseToolContext {
  readonly chat: InteractionChat;
  readonly turnId: InteractionTurn;
}

export type CanUseToolContextResolver = (
  ...args: CanUseToolParameters
) => CanUseToolContext;

/** Standalone form for composition code that does not need the class method. */
export function createCanUseToolAdapter(
  registry: PendingInteractionRegistry,
  context: CanUseToolContext | CanUseToolContextResolver,
): CanUseTool {
  return registry.createCanUseTool(context);
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validateTimeout(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function resolveChat(input: { readonly chat?: string; readonly chatUri?: string } | undefined): string {
  return input?.chat ?? input?.chatUri ?? '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function entryKey(kind: InteractionKind, id: InteractionId): string {
  return `${kind}:${id}`;
}

type ResolveErrorCode =
  | 'invalid_decision'
  | 'invalid_answers'
  | 'invalid_request'
  | 'dispatch_failed'
  | 'disposed';

function rejected(
  kind: InteractionKind,
  id: InteractionId,
  code: ResolveErrorCode,
  message: string,
): ResolveResult {
  return { status: 'rejected', kind, id, code, message };
}

function denyResult(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

function snapshotEntry(entry: Entry): PendingInteractionSnapshot {
  if (entry.kind === 'approval') {
    return {
      kind: 'approval',
      chat: entry.chat,
      turnId: entry.turnId,
      approvalId: entry.id,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      toolName: entry.toolName,
      input: entry.input,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.suggestions === undefined ? {} : { suggestions: entry.suggestions }),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.toolUseId === undefined ? {} : { toolUseId: entry.toolUseId }),
      ...(entry.toolUseID === undefined ? {} : { toolUseID: entry.toolUseID }),
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
      ...(entry.agentID === undefined ? {} : { agentID: entry.agentID }),
      ...(entry.blockedPath === undefined ? {} : { blockedPath: entry.blockedPath }),
      ...(entry.decisionReason === undefined ? {} : { decisionReason: entry.decisionReason }),
      ...(entry.matchedAskRule === undefined ? {} : { matchedAskRule: entry.matchedAskRule }),
      requestedAt: entry.requestedAt,
      ...(entry.sdkRequestId === undefined ? {} : { sdkRequestId: entry.sdkRequestId }),
      ...(entry.toolUseID === undefined ? {} : { toolUseID: entry.toolUseID }),
    };
  }
  return {
    kind: 'input',
    chat: entry.chat,
    turnId: entry.turnId,
    inputId: entry.id,
    questions: entry.questions,
    requestedAt: entry.requestedAt,
    ...(entry.toolUseID === undefined ? {} : { toolUseID: entry.toolUseID }),
  };
}

function copyPermissionUpdates(
  value: CanUseToolOptions['suggestions'] | undefined,
): readonly PermissionUpdate[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const copied = value.map((item) => cloneJson(item));
  return copied.some((item) => item === INVALID_JSON)
    ? undefined
    : Object.freeze(copied as PermissionUpdate[]);
}

function cloneJsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const cloned = cloneJson(value);
  return cloned !== INVALID_JSON && isPlainRecord(cloned) ? Object.freeze(cloned) : undefined;
}

function cloneJson(value: unknown, ancestors = new WeakSet<object>()): unknown | typeof INVALID_JSON {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : INVALID_JSON;
  }
  if (value === undefined) return INVALID_JSON;
  if (typeof value !== 'object' || ancestors.has(value)) {
    return INVALID_JSON;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = value.map((item) => cloneJson(item, ancestors));
      return values.some((item) => item === INVALID_JSON) ? INVALID_JSON : Object.freeze(values);
    }
    if (!isPlainRecord(value)) {
      return INVALID_JSON;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const cloned = cloneJson(child, ancestors);
      if (cloned === INVALID_JSON) return INVALID_JSON;
      result[key] = cloned;
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function extractAskInput(value: CanUseToolParameters[1]): AskUserQuestionInput | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const questions = extractQuestions(value.questions);
  return questions === undefined ? undefined : ({ questions } as AskUserQuestionInput);
}

function extractQuestions(
  value: RequestInputInput['questions'] | unknown,
): readonly AskUserQuestion[] | undefined {
  const candidate = isPlainRecord(value) && 'questions' in value ? value.questions : value;
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 4) {
    return undefined;
  }
  const questions: AskUserQuestion[] = [];
  for (const question of candidate) {
    if (!isPlainRecord(question)
      || typeof question.question !== 'string'
      || typeof question.header !== 'string'
      || typeof question.multiSelect !== 'boolean'
      || !Array.isArray(question.options)
      || question.options.length < 2
      || question.options.length > 4) {
      return undefined;
    }
    const options: unknown[] = [];
    for (const option of question.options) {
      if (!isPlainRecord(option) || typeof option.label !== 'string' || typeof option.description !== 'string'
        || (option.preview !== undefined && typeof option.preview !== 'string')) {
        return undefined;
      }
      options.push({
        label: option.label,
        description: option.description,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      });
    }
    questions.push({
      question: question.question,
      header: question.header,
      options: options as AskUserQuestion['options'],
      multiSelect: question.multiSelect,
    });
  }
  return Object.freeze(questions);
}

function validateAnswers(
  value: InputAnswers,
  questions: readonly AskUserQuestion[],
): InputAnswers | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const questionKeys = new Set(questions.map((question) => question.question));
  const answerRecord: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value)) {
    if (!questionKeys.has(key) || typeof answer !== 'string') {
      return undefined;
    }
    answerRecord[key] = answer;
  }
  return Object.freeze(answerRecord);
}

function permissionResultFromInput(
  entry: ApprovalEntry,
  input: ResolveApprovalInput,
): PermissionResult | undefined {
  const full = input.result ?? input.permissionResult;
  if (full !== undefined) {
    return isPermissionResult(full) ? clonePermissionResult(full) : undefined;
  }
  const decision = input.decision;
  if (isPermissionResult(decision)) {
    return clonePermissionResult(decision);
  }
  const behavior = decision === true ? 'allow' : decision === false ? 'deny' : decision;
  if (behavior !== 'allow' && behavior !== 'deny') {
    return undefined;
  }
  if (behavior === 'allow') {
    const result: PermissionResult = {
      behavior: 'allow',
      ...(input.updatedInput === undefined ? { updatedInput: entry.input } : { updatedInput: input.updatedInput }),
      ...(input.updatedPermissions === undefined ? {} : { updatedPermissions: input.updatedPermissions }),
      ...(input.decisionClassification === undefined ? {} : { decisionClassification: input.decisionClassification }),
    };
    return result;
  }
  return {
    behavior: 'deny',
    message: input.message ?? DEFAULT_APPROVAL_DENY_MESSAGE,
    ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
    ...(input.decisionClassification === undefined ? {} : { decisionClassification: input.decisionClassification }),
  };
}

function isPermissionResult(value: unknown): value is PermissionResult {
  if (!isPlainRecord(value) || (value.behavior !== 'allow' && value.behavior !== 'deny')) {
    return false;
  }
  if (value.behavior === 'deny' && typeof value.message !== 'string') {
    return false;
  }
  return value.updatedInput === undefined || isPlainRecord(value.updatedInput);
}

function clonePermissionResult(value: PermissionResult): PermissionResult {
  if (value.behavior === 'allow') {
    return {
      behavior: 'allow',
      ...(value.updatedInput === undefined ? {} : { updatedInput: cloneJsonObject(value.updatedInput) ?? {} }),
      ...(value.updatedPermissions === undefined ? {} : { updatedPermissions: value.updatedPermissions.map((item) => item) }),
      ...(value.toolUseID === undefined ? {} : { toolUseID: value.toolUseID }),
      ...(value.decisionClassification === undefined ? {} : { decisionClassification: value.decisionClassification }),
    };
  }
  return {
    behavior: 'deny',
    message: value.message,
    ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
    ...(value.toolUseID === undefined ? {} : { toolUseID: value.toolUseID }),
    ...(value.decisionClassification === undefined ? {} : { decisionClassification: value.decisionClassification }),
  };
}

function isValidContext(value: unknown): value is CanUseToolContext {
  return isPlainRecord(value) && isNonEmptyString(value.chat) && isNonEmptyString(value.turnId);
}
