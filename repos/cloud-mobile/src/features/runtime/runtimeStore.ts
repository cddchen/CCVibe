import type { ConnectionFormValues } from '../connection/connectionForm';
import { validateConnectionForm } from '../connection/connectionForm';
import {
  buildCreateChatCommand,
  buildSendChatCommand,
} from '../home/createChatCommand';
import {
  buildApprovalResolutionCommand,
  buildChatDispatchCommand,
  buildInputResolutionCommand,
} from '../chat/chatCommands';
import {
  createConnectionId,
  type ConnectionId,
} from '../../protocol/ids';
import { AGENT_ROOT_URI, type ChatUri } from '../../protocol/resourceUri';
import type {
  HostCreateChatParams,
  HostCreateChatResult,
  HostDispatchActionParams,
  HostDispatchActionResult,
  HostInteractionResolutionResult,
  HostResolveApprovalParams,
  HostResolveInputParams,
  HostRootCatalogState,
  HostChatState,
} from '../../protocol/hostWire';
import {
  createAsyncStorageConnectionPreferencesAdapter,
  type AsyncStoragePort,
  type ConnectionPreferences,
  type ConnectionPreferencesStore,
} from '../../storage/connectionPreferences';
import type { TokenStore } from '../../storage/secureToken';
import {
  ConnectionSupervisor,
  type AppStatePort,
  type ConnectionSupervisorOptions,
} from '../../sync/connectionSupervisor';
import {
  createSyncStore,
  createSyncState,
  type SyncState,
} from '../../sync/syncState';
import { getResourceState } from '../../sync/syncState';
import {
  selectHomeViewModel,
  type HomeSelectorError,
  type HomeSelectorInput,
  type HomeViewModel,
} from '../home/homeSelectors';
import type { ConnectionMode } from '../../domain/types';
import type { HostResourceState } from '../../domain/hostReducer';

export type RuntimePhase = 'loading' | 'ready' | 'unconfigured' | 'error';

export interface RuntimeSelection {
  readonly workspaceId?: string;
  readonly modelId?: string;
}

export interface PendingSend {
  readonly chatUri: ChatUri;
  readonly prompt: string;
}

export interface RuntimeOperationError extends HomeSelectorError {
  readonly operation: 'create' | 'subscribe' | 'send';
  readonly chatUri?: ChatUri;
}

export interface ChatOperationError {
  readonly operation: 'send' | 'interrupt' | 'approval' | 'input';
  readonly code: string;
  readonly chatUri: ChatUri;
}

export interface CloudRuntimeState {
  readonly phase: RuntimePhase;
  readonly sync: SyncState;
  readonly savedConnection?: ConnectionPreferences;
  readonly tokenAvailable: boolean;
  readonly selection: RuntimeSelection;
  readonly pendingSend?: PendingSend;
  readonly operationError?: RuntimeOperationError;
  readonly chatOperationError?: ChatOperationError;
}

export type NewChatResult =
  | { readonly status: 'accepted'; readonly chatUri: ChatUri }
  | {
      readonly status: 'error';
      readonly operation: RuntimeOperationError['operation'];
      readonly code: string;
      readonly chatUri?: ChatUri;
    };

export type ChatActionResult =
  | {
      readonly status: 'accepted';
      readonly operation: ChatOperationError['operation'];
      readonly chatUri: ChatUri;
      readonly resolution?: 'resolved';
    }
  | {
      readonly status: 'already_resolved';
      readonly operation: 'approval' | 'input';
      readonly chatUri: ChatUri;
      readonly id: string;
    }
  | {
      readonly status: 'error';
      readonly operation: ChatOperationError['operation'];
      readonly code: string;
      readonly chatUri: ChatUri;
    };

export interface SendChatInput {
  readonly chatUri: ChatUri;
  readonly prompt: string;
}

export interface InterruptChatInput {
  readonly chatUri: ChatUri;
  readonly turnId: string;
}

export type ResolveApprovalInput = Omit<HostResolveApprovalParams, 'clientSeq' | 'commandId'>;
export type ResolveInputActionInput = Omit<HostResolveInputParams, 'clientSeq' | 'commandId'>;

export type ConnectionActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<'hostUrl' | 'token', string>>> };

export interface RuntimeSupervisor {
  getState(): SyncState;
  start(): void;
  stop(): void;
  retryNow(): void;
  subscribe(resource: string): Promise<void>;
  createChat(params: HostCreateChatParams): Promise<HostCreateChatResult>;
  dispatchAction(params: HostDispatchActionParams): Promise<HostDispatchActionResult>;
  resolveApproval?(params: HostResolveApprovalParams): Promise<HostInteractionResolutionResult>;
  resolveInput?(params: HostResolveInputParams): Promise<HostInteractionResolutionResult>;
}

export interface CloudRuntimeDependencies {
  readonly asyncStorage: AsyncStoragePort;
  readonly tokenStore: TokenStore;
  readonly appState: AppStatePort;
  readonly platform?: ConnectionSupervisorOptions['clientInfo']['platform'];
  readonly clientId?: string;
  readonly createId: () => string;
  readonly createSupervisor?: (options: ConnectionSupervisorOptions) => RuntimeSupervisor;
  readonly preferencesStore?: ConnectionPreferencesStore;
}

export interface RuntimeHydrationForTest {
  readonly catalog: HostRootCatalogState;
  readonly chat?: { readonly resource: ChatUri; readonly state: HostChatState; readonly lastServerSeq?: number };
  readonly syncStatus?: SyncState['status'];
  readonly supervisor?: RuntimeSupervisor;
}

export class CloudRuntime {
  private readonly dependencies: CloudRuntimeDependencies;
  private readonly preferences: ConnectionPreferencesStore;
  private readonly listeners = new Set<(state: CloudRuntimeState) => void>();
  private readonly actionsValue: CloudRuntimeActions;
  private state: CloudRuntimeState;
  private supervisor: RuntimeSupervisor | undefined;
  private removeSyncSubscription: (() => void) | undefined;
  private clientSeq = 0;
  private disposed = false;

  public constructor(dependencies: CloudRuntimeDependencies) {
    this.dependencies = dependencies;
    this.preferences = dependencies.preferencesStore
      ?? createAsyncStorageConnectionPreferencesAdapter(dependencies.asyncStorage);
    this.state = freezeRuntimeState({
      phase: 'loading',
      sync: createSyncState({ subscriptions: [AGENT_ROOT_URI] }),
      tokenAvailable: false,
      selection: {},
    });
    this.actionsValue = Object.freeze({
      connect: (values: ConnectionFormValues) => this.connect(values),
      reconnectSaved: () => this.reconnectSaved(),
      disconnect: () => this.disconnect(),
      retryConnection: () => this.retryConnection(),
      subscribeChat: (chatUri: ChatUri) => this.subscribeChat(chatUri),
      setWorkspace: (workspaceId: string) => this.setWorkspace(workspaceId),
      setModel: (modelId: string) => this.setModel(modelId),
      createChatAndSend: (input: CreateChatAndSendInput) => this.createChatAndSend(input),
      retryPendingSend: () => this.retryPendingSend(),
      sendChat: (input: SendChatInput) => this.sendChat(input),
      interruptChat: (input: InterruptChatInput) => this.interruptChat(input),
      allowApproval: (input: ResolveApprovalInput) => this.resolveApproval({ ...input, decision: 'allow' }),
      denyApproval: (input: ResolveApprovalInput) => this.resolveApproval({ ...input, decision: 'deny' }),
      resolveInput: (input: ResolveInputActionInput) => this.resolveInput(input),
      clearOperationError: () => this.setState({ operationError: undefined }),
      clearChatOperationError: () => this.setState({ chatOperationError: undefined }),
    });
  }

  public getState(): CloudRuntimeState {
    return this.state;
  }

  public get actions(): CloudRuntimeActions {
    return this.actionsValue;
  }

  public subscribe(listener: (state: CloudRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async initialize(): Promise<void> {
    if (this.disposed) return;
    try {
      const [savedConnection, token] = await Promise.all([
        this.preferences.load(),
        this.dependencies.tokenStore.read(),
      ]);
      if (this.disposed) return;
      this.setState({
        phase: savedConnection !== null && token !== null ? 'ready' : 'unconfigured',
        savedConnection: savedConnection ?? undefined,
        tokenAvailable: token !== null,
        selection: {
          ...(savedConnection?.lastWorkspaceId === undefined ? {} : { workspaceId: savedConnection.lastWorkspaceId }),
          ...(savedConnection?.lastModelId === undefined ? {} : { modelId: savedConnection.lastModelId }),
        },
      });
      if (savedConnection !== null && token !== null) {
        this.attachConnection({
          connectionId: savedConnection.connectionId,
          address: savedConnection.address,
          mode: savedConnection.mode,
          token,
        });
      }
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachSupervisor(true);
    this.listeners.clear();
  }

  /** Test and hydration seam for a pure controller test; production data enters through SyncStore. */
  public hydrateForTest(input: RuntimeHydrationForTest): void {
    const subscriptions = input.chat === undefined ? [AGENT_ROOT_URI] : [AGENT_ROOT_URI, input.chat.resource];
    const resources = input.chat === undefined
      ? [{ resource: AGENT_ROOT_URI, state: input.catalog, lastServerSeq: 0 }]
      : [
          { resource: AGENT_ROOT_URI, state: input.catalog, lastServerSeq: 0 },
          { resource: input.chat.resource, state: input.chat.state, lastServerSeq: input.chat.lastServerSeq ?? 0 },
        ];
    const sync = createSyncState({ subscriptions });
    this.setState({
      phase: 'ready',
      sync: freezeSyncState({
        ...sync,
        status: input.syncStatus ?? 'connected',
        address: 'wss://test.invalid',
        hostEpoch: 'test-epoch',
        resources,
      }),
    });
    if (input.supervisor !== undefined) {
      this.supervisor = input.supervisor;
    }
  }

  private async connect(values: ConnectionFormValues): Promise<ConnectionActionResult> {
    const result = validateConnectionForm(values);
    if (!result.ok) return result;

    const savedConnection = this.state.savedConnection;
    const connectionId = savedConnection?.connectionId ?? createConnectionId(`connection-${this.dependencies.createId()}`);
    const config = Object.freeze({
      connectionId,
      address: result.config.address,
      mode: result.config.mode,
      token: result.config.token,
    });

    try {
      await this.dependencies.tokenStore.write(config.token);
      await this.preferences.save({
        connectionId,
        address: config.address,
        mode: config.mode,
        ...(this.state.selection.workspaceId === undefined ? {} : { lastWorkspaceId: this.state.selection.workspaceId }),
        ...(this.state.selection.modelId === undefined ? {} : { lastModelId: this.state.selection.modelId }),
      });
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
      return { ok: false, errors: { hostUrl: '连接配置保存失败，请稍后重试' } };
    }

    this.setState({
      phase: 'ready',
      savedConnection: {
        connectionId,
        address: config.address,
        mode: config.mode,
        ...(this.state.selection.workspaceId === undefined ? {} : { lastWorkspaceId: this.state.selection.workspaceId }),
        ...(this.state.selection.modelId === undefined ? {} : { lastModelId: this.state.selection.modelId }),
      },
      tokenAvailable: true,
      operationError: undefined,
    });
    this.attachConnection(config);
    return { ok: true };
  }

  private async reconnectSaved(): Promise<boolean> {
    const savedConnection = this.state.savedConnection;
    if (savedConnection === undefined) return false;
    try {
      const token = await this.dependencies.tokenStore.read();
      if (token === null || token.trim().length === 0) {
        this.setState({ tokenAvailable: false, phase: 'unconfigured' });
        return false;
      }
      this.setState({ phase: 'ready', operationError: undefined });
      this.attachConnection({
        connectionId: savedConnection.connectionId,
        address: savedConnection.address,
        mode: savedConnection.mode,
        token,
      });
      return true;
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
      return false;
    }
  }

  private disconnect(): void {
    this.detachSupervisor(true);
    this.setState({ phase: this.state.savedConnection === undefined ? 'unconfigured' : 'ready', operationError: undefined });
  }

  private retryConnection(): void {
    if (this.supervisor !== undefined) {
      this.supervisor.retryNow();
      return;
    }
    void this.reconnectSaved();
  }

  private async subscribeChat(chatUri: ChatUri): Promise<boolean> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) {
      this.failOperation('subscribe', 'NOT_CONNECTED', chatUri);
      return false;
    }
    try {
      await supervisor.subscribe(chatUri);
      return true;
    } catch (error) {
      this.failOperation('subscribe', errorCode(error), chatUri);
      return false;
    }
  }

  private setWorkspace(workspaceId: string): void {
    this.setState({ selection: { ...this.state.selection, workspaceId } });
    void this.persistSelection({ workspaceId });
  }

  private setModel(modelId: string): void {
    this.setState({ selection: { ...this.state.selection, modelId } });
    void this.persistSelection({ modelId });
  }

  private async persistSelection(selection: RuntimeSelection): Promise<void> {
    const savedConnection = this.state.savedConnection;
    if (savedConnection === undefined) return;
    try {
      await this.preferences.save({
        ...savedConnection,
        ...selection,
      });
    } catch {
      // Preferences are non-critical; the in-memory selection remains authoritative for this session.
    }
  }

  private async createChatAndSend(input: CreateChatAndSendInput): Promise<NewChatResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) {
      return this.failOperation('create', 'NOT_CONNECTED');
    }

    let createResult: HostCreateChatResult;
    try {
      const command = buildCreateChatCommand({
        workspaceId: input.workspaceId,
        modelId: input.modelId,
        prompt: input.prompt,
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId('create'),
      });
      createResult = await supervisor.createChat(command.params);
    } catch (error) {
      return this.failOperation('create', errorCode(error));
    }

    if (createResult.receipt.status === 'rejected') {
      return this.failOperation('create', createResult.receipt.code);
    }

    const pending: PendingSend = Object.freeze({
      chatUri: createResult.receipt.value.chatUri,
      prompt: input.prompt.trim(),
    });
    this.setState({ pendingSend: pending, operationError: undefined });
    try {
      await supervisor.subscribe(pending.chatUri);
    } catch (error) {
      return this.failOperation('subscribe', errorCode(error), pending.chatUri);
    }
    return this.sendPending(supervisor, pending);
  }

  private async retryPendingSend(): Promise<NewChatResult> {
    const pending = this.state.pendingSend;
    if (pending === undefined) return this.failOperation('send', 'NO_PENDING_SEND');
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) {
      return this.failOperation('send', 'NOT_CONNECTED', pending.chatUri);
    }
    try {
      await supervisor.subscribe(pending.chatUri);
    } catch (error) {
      return this.failOperation('subscribe', errorCode(error), pending.chatUri);
    }
    return this.sendPending(supervisor, pending);
  }

  private async sendChat(input: SendChatInput): Promise<ChatActionResult> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) return this.failChatOperation('send', input.chatUri, 'EMPTY_PROMPT');
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) return this.failChatOperation('send', input.chatUri, 'NOT_CONNECTED');

    try {
      if (!this.state.sync.subscriptions.includes(input.chatUri)) {
        await supervisor.subscribe(input.chatUri);
      }
      const command = buildChatDispatchCommand({
        channel: input.chatUri,
        action: { type: 'chat/send', prompt },
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId('send'),
      });
      const result = await supervisor.dispatchAction(command.params);
      if (result.receipt.status === 'rejected') {
        return this.failChatOperation('send', input.chatUri, result.receipt.code);
      }
      this.setState({ chatOperationError: undefined });
      return { status: 'accepted', operation: 'send', chatUri: input.chatUri };
    } catch (error) {
      return this.failChatOperation('send', input.chatUri, errorCode(error));
    }
  }

  private async interruptChat(input: InterruptChatInput): Promise<ChatActionResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) return this.failChatOperation('interrupt', input.chatUri, 'NOT_CONNECTED');
    try {
      const command = buildChatDispatchCommand({
        channel: input.chatUri,
        action: { type: 'chat/interrupt', turnId: input.turnId },
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId('interrupt'),
      });
      const result = await supervisor.dispatchAction(command.params);
      if (result.receipt.status === 'rejected') {
        return this.failChatOperation('interrupt', input.chatUri, result.receipt.code);
      }
      this.setState({ chatOperationError: undefined });
      return { status: 'accepted', operation: 'interrupt', chatUri: input.chatUri };
    } catch (error) {
      return this.failChatOperation('interrupt', input.chatUri, errorCode(error));
    }
  }

  private async resolveApproval(input: ResolveApprovalInput): Promise<ChatActionResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) return this.failChatOperation('approval', input.channel, 'NOT_CONNECTED');
    if (supervisor.resolveApproval === undefined) {
      return this.failChatOperation('approval', input.channel, 'INTERACTION_UNAVAILABLE');
    }
    try {
      const command = buildApprovalResolutionCommand({
        ...input,
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId(input.decision === 'allow' ? 'allow' : 'deny'),
      });
      const result = await supervisor.resolveApproval(command.params);
      return this.resolveInteractionResult('approval', input.channel, result);
    } catch (error) {
      return this.failChatOperation('approval', input.channel, errorCode(error));
    }
  }

  private async resolveInput(input: ResolveInputActionInput): Promise<ChatActionResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor === undefined) return this.failChatOperation('input', input.channel, 'NOT_CONNECTED');
    if (supervisor.resolveInput === undefined) {
      return this.failChatOperation('input', input.channel, 'INTERACTION_UNAVAILABLE');
    }
    try {
      const command = buildInputResolutionCommand({
        ...input,
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId('input'),
      });
      const result = await supervisor.resolveInput(command.params);
      return this.resolveInteractionResult('input', input.channel, result);
    } catch (error) {
      return this.failChatOperation('input', input.channel, errorCode(error));
    }
  }

  private resolveInteractionResult(
    operation: 'approval' | 'input',
    chatUri: ChatUri,
    result: HostInteractionResolutionResult,
  ): ChatActionResult {
    if (result.receipt.status === 'rejected') {
      return this.failChatOperation(operation, chatUri, result.receipt.code);
    }
    this.setState({ chatOperationError: undefined });
    return result.receipt.value.status === 'already_resolved'
      ? { status: 'already_resolved', operation, chatUri, id: result.receipt.value.id }
      : { status: 'accepted', operation, chatUri, resolution: 'resolved' };
  }

  private failChatOperation(
    operation: ChatOperationError['operation'],
    chatUri: ChatUri,
    code: string,
  ): ChatActionResult {
    const error = { operation, chatUri, code } as const;
    this.setState({ chatOperationError: error });
    return { status: 'error', operation, chatUri, code };
  }

  private async sendPending(supervisor: RuntimeSupervisor, pending: PendingSend): Promise<NewChatResult> {
    let sendResult: HostDispatchActionResult;
    try {
      const command = buildSendChatCommand({
        channel: pending.chatUri,
        prompt: pending.prompt,
        clientSeq: this.nextClientSeq(),
        commandId: this.nextCommandId('send'),
      });
      sendResult = await supervisor.dispatchAction(command.params);
    } catch (error) {
      return this.failOperation('send', errorCode(error), pending.chatUri);
    }

    if (sendResult.receipt.status === 'rejected') {
      return this.failOperation('send', sendResult.receipt.code, pending.chatUri);
    }

    this.setState({ pendingSend: undefined, operationError: undefined });
    return { status: 'accepted', chatUri: pending.chatUri };
  }

  private failOperation(
    operation: RuntimeOperationError['operation'],
    code: string,
    chatUri?: ChatUri,
  ): NewChatResult {
    const error: RuntimeOperationError = {
      operation,
      code,
      ...(chatUri === undefined ? {} : { chatUri }),
    };
    this.setState({ operationError: error });
    return {
      status: 'error',
      operation,
      code,
      ...(chatUri === undefined ? {} : { chatUri }),
    };
  }

  private requireConnectedSupervisor(): RuntimeSupervisor | undefined {
    const supervisor = this.supervisor;
    if (supervisor === undefined || supervisor.getState().status !== 'connected') return undefined;
    return supervisor;
  }

  private attachConnection(config: {
    readonly connectionId: ConnectionId;
    readonly address: string;
    readonly token: string;
    readonly mode: ConnectionMode;
  }): void {
    this.detachSupervisor(true);
    const syncStore = createSyncStore({ address: config.address, subscriptions: [AGENT_ROOT_URI] });
    const supervisor = (this.dependencies.createSupervisor ?? createDefaultSupervisor)({
      config,
      clientId: this.dependencies.clientId ?? `client-${this.dependencies.createId()}`,
      clientInfo: {
        name: 'Cloud',
        version: '0.1.0',
        platform: this.dependencies.platform ?? 'unknown',
      },
      store: syncStore,
      appState: this.dependencies.appState,
      initialSubscriptions: [AGENT_ROOT_URI],
    });
    this.supervisor = supervisor;
    this.removeSyncSubscription = syncStore.subscribe((sync) => {
      this.setState({ sync });
    });
    this.setState({ sync: syncStore.getState(), phase: 'ready', operationError: undefined });
    supervisor.start();
  }

  private detachSupervisor(stop: boolean): void {
    this.removeSyncSubscription?.();
    this.removeSyncSubscription = undefined;
    const supervisor = this.supervisor;
    this.supervisor = undefined;
    if (stop) supervisor?.stop();
  }

  private nextClientSeq(): number {
    if (this.clientSeq >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('clientSeq exhausted');
    }
    this.clientSeq += 1;
    return this.clientSeq;
  }

  private nextCommandId(prefix: string): string {
    return `${prefix}-${this.dependencies.createId()}`;
  }

  private setState(patch: Partial<CloudRuntimeState>): void {
    if (this.disposed) return;
    this.state = freezeRuntimeState({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

export interface CreateChatAndSendInput {
  readonly prompt: string;
  readonly workspaceId: string;
  readonly modelId: string;
}

export interface CloudRuntimeActions {
  connect(values: ConnectionFormValues): Promise<ConnectionActionResult>;
  reconnectSaved(): Promise<boolean>;
  disconnect(): void;
  retryConnection(): void;
  subscribeChat(chatUri: ChatUri): Promise<boolean>;
  setWorkspace(workspaceId: string): void;
  setModel(modelId: string): void;
  createChatAndSend(input: CreateChatAndSendInput): Promise<NewChatResult>;
  retryPendingSend(): Promise<NewChatResult>;
  sendChat(input: SendChatInput): Promise<ChatActionResult>;
  interruptChat(input: InterruptChatInput): Promise<ChatActionResult>;
  allowApproval(input: ResolveApprovalInput): Promise<ChatActionResult>;
  denyApproval(input: ResolveApprovalInput): Promise<ChatActionResult>;
  resolveInput(input: ResolveInputActionInput): Promise<ChatActionResult>;
  clearOperationError(): void;
  clearChatOperationError(): void;
}

export function selectSyncState(state: CloudRuntimeState): SyncState {
  return state.sync;
}

export function selectRootCatalog(state: CloudRuntimeState): HostRootCatalogState | undefined {
  const resource = getResourceState(state.sync, AGENT_ROOT_URI);
  if (resource === undefined || resource.resource !== AGENT_ROOT_URI) return undefined;
  const rootResource = resource as Extract<HostResourceState, { resource: typeof AGENT_ROOT_URI }>;
  return rootResource.state;
}

export function selectHomeSelectorInput(state: CloudRuntimeState): HomeSelectorInput {
  return {
    phase: state.phase,
    syncStatus: state.sync.status,
    catalog: selectRootCatalog(state),
    selectedWorkspaceId: state.selection.workspaceId,
    selectedModelId: state.selection.modelId,
    operationError: state.operationError,
  };
}

export function selectHomeView(state: CloudRuntimeState): HomeViewModel {
  return selectHomeViewModel(selectHomeSelectorInput(state));
}

function createDefaultSupervisor(options: ConnectionSupervisorOptions): RuntimeSupervisor {
  return new ConnectionSupervisor(options);
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TransportTimeoutError') return 'TIMEOUT';
  if (error instanceof Error && error.name === 'TransportClosedError') return 'CLOSED';
  if (error instanceof Error && error.name === 'TransportConnectionError') return 'CONNECTION';
  if (error instanceof Error && error.name === 'TransportRpcError') return 'RPC_ERROR';
  if (error instanceof Error && error.name === 'TransportProtocolError') return 'PROTOCOL';
  return 'UNKNOWN';
}

function freezeRuntimeState(state: CloudRuntimeState): CloudRuntimeState {
  return Object.freeze({
    ...state,
    sync: freezeSyncState(state.sync),
    ...(state.savedConnection === undefined ? {} : { savedConnection: Object.freeze({ ...state.savedConnection }) }),
    selection: Object.freeze({ ...state.selection }),
    ...(state.pendingSend === undefined ? {} : { pendingSend: Object.freeze({ ...state.pendingSend }) }),
    ...(state.operationError === undefined ? {} : { operationError: Object.freeze({ ...state.operationError }) }),
    ...(state.chatOperationError === undefined ? {} : { chatOperationError: Object.freeze({ ...state.chatOperationError }) }),
  });
}

function freezeSyncState(state: SyncState): SyncState {
  return Object.freeze({
    ...state,
    subscriptions: Object.freeze([...state.subscriptions]),
    resources: Object.freeze([...state.resources]),
    missing: Object.freeze([...state.missing]),
  });
}
