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
  HostResolveWorkspaceParams,
  HostResolveWorkspaceResult,
  HostDispatchActionParams,
  HostDispatchActionResult,
  HostInteractionResolutionResult,
  HostResolveApprovalParams,
  HostResolveInputParams,
  HostRootCatalogState,
  HostChatState,
  HostSlashCommand,
  HostSupportedCommandsResult,
  HostConfigureChatParams,
  HostConfigureChatResult,
  HostPermissionMode,
} from '../../protocol/hostWire';
import {
  createAsyncStorageHostPreferencesAdapter,
  type AsyncStoragePort,
  type ConnectionPreferences,
  type ConnectionPreferencesCollection,
  type ConnectionPreferencesStore,
  type HostPreferencesStore,
} from '../../storage/connectionPreferences';
import type { HostTokenStore, TokenStore } from '../../storage/secureToken';
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
import type { JsonValue, ConnectionMode } from '../../domain/types';
import type { HostResourceState } from '../../domain/hostReducer';
import { TransportRpcError } from '../../sync/transport';

export type RuntimePhase = 'loading' | 'ready' | 'unconfigured' | 'error';

export interface RuntimeSelection {
  readonly workspaceId?: string;
  readonly modelId?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly permissionMode?: HostPermissionMode;
}

export interface PendingSend {
  readonly chatUri: ChatUri;
  readonly prompt: string;
}

export interface RuntimeOperationError extends HomeSelectorError {
  readonly operation: 'create' | 'subscribe' | 'send' | 'workspace';
  readonly chatUri?: ChatUri;
}

export interface ChatOperationError {
  readonly operation: 'send' | 'interrupt' | 'approval' | 'input' | 'configure';
  readonly code: string;
  readonly chatUri: ChatUri;
}

export interface CloudRuntimeState {
  readonly phase: RuntimePhase;
  readonly sync: SyncState;
  /** All configured Hosts, ordered by insertion time. */
  readonly savedConnections: readonly ConnectionPreferences[];
  /** The Host whose configuration is shown by the settings screen. */
  readonly selectedConnectionId?: ConnectionId;
  /** Compatibility projection for callers from the single-Host build. */
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
      readonly message?: string;
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
  supportedCommands?(channel: ChatUri): Promise<HostSupportedCommandsResult>;
  configureChat?(params: HostConfigureChatParams): Promise<HostConfigureChatResult>;
  resolveApproval?(params: HostResolveApprovalParams): Promise<HostInteractionResolutionResult>;
  resolveInput?(params: HostResolveInputParams): Promise<HostInteractionResolutionResult>;
  resolveWorkspace?(params: HostResolveWorkspaceParams): Promise<HostResolveWorkspaceResult>;
}

export interface CloudRuntimeDependencies {
  readonly asyncStorage: AsyncStoragePort;
  readonly tokenStore: TokenStore;
  readonly appState: AppStatePort;
  readonly platform?: ConnectionSupervisorOptions['clientInfo']['platform'];
  readonly clientId?: string;
  readonly createId: () => string;
  readonly createSupervisor?: (options: ConnectionSupervisorOptions) => RuntimeSupervisor;
  /** Optional legacy single-Host store used by existing tests/integrations. */
  readonly preferencesStore?: ConnectionPreferencesStore | HostPreferencesStore;
  /** Preferred Host-list store. If absent, a Host-list adapter is created. */
  readonly hostPreferencesStore?: HostPreferencesStore;
  /** Maximum time a user-initiated connect/switch waits for initialization. */
  readonly connectionTimeoutMs?: number;
}

export interface RuntimeHydrationForTest {
  readonly catalog: HostRootCatalogState;
  readonly chat?: { readonly resource: ChatUri; readonly state: HostChatState; readonly lastServerSeq?: number };
  readonly syncStatus?: SyncState['status'];
  readonly supervisor?: RuntimeSupervisor;
}

export class CloudRuntime {
  private readonly dependencies: CloudRuntimeDependencies;
  private readonly preferences: ConnectionPreferencesStore | undefined;
  private readonly hostPreferences: HostPreferencesStore | undefined;
  private readonly listeners = new Set<(state: CloudRuntimeState) => void>();
  private readonly actionsValue: CloudRuntimeActions;
  private state: CloudRuntimeState;
  private supervisor: RuntimeSupervisor | undefined;
  private removeSyncSubscription: (() => void) | undefined;
  private cancelConnectionAttempt: (() => void) | undefined;
  private clientSeq = 0;
  private disposed = false;
  private connectionOperationGeneration = 0;

  public constructor(dependencies: CloudRuntimeDependencies) {
    this.dependencies = dependencies;
    this.preferences = isLegacyPreferencesStore(dependencies.preferencesStore)
      ? dependencies.preferencesStore
      : undefined;
    this.hostPreferences = dependencies.hostPreferencesStore
      ?? (isHostPreferencesStore(dependencies.preferencesStore)
        ? dependencies.preferencesStore
        : this.preferences === undefined
          ? createAsyncStorageHostPreferencesAdapter(dependencies.asyncStorage)
          : createLegacyHostPreferencesStore(this.preferences));
    this.state = freezeRuntimeState({
      phase: 'loading',
      sync: createSyncState({ subscriptions: [AGENT_ROOT_URI] }),
      savedConnections: [],
      tokenAvailable: false,
      selection: {},
    });
    this.actionsValue = Object.freeze({
      connect: (values: ConnectionFormValues, connectionId?: ConnectionId | string | null) => this.connect(values, connectionId),
      switchConnection: (connectionId: ConnectionId | string) => this.switchConnection(connectionId),
      selectConnection: (connectionId: ConnectionId | string) => this.switchConnection(connectionId),
      reconnectSaved: () => this.reconnectSaved(),
      disconnect: () => this.disconnect(),
      retryConnection: () => this.retryConnection(),
      subscribeChat: (chatUri: ChatUri) => this.subscribeChat(chatUri),
      setWorkspace: (workspaceId: string) => this.setWorkspace(workspaceId),
      resolveWorkspace: (path: string) => this.resolveWorkspace(path),
      setModel: (modelId: string) => this.setModel(modelId),
      setEffort: (effort: RuntimeSelection['effort']) => this.setEffort(effort),
      setPermissionMode: (permissionMode: HostPermissionMode) => this.setPermissionMode(permissionMode),
      createChatAndSend: (input: CreateChatAndSendInput) => this.createChatAndSend(input),
      retryPendingSend: () => this.retryPendingSend(),
      sendChat: (input: SendChatInput) => this.sendChat(input),
      supportedCommands: (chatUri: ChatUri) => this.supportedCommands(chatUri),
      configureChat: (input: HostConfigureChatParams) => this.configureChat(input),
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
      const collection = await this.hostPreferences?.loadHosts() ?? { hosts: [] };
      const savedConnection = findSelectedConnection(collection);
      const selectedConnectionId = collection.selectedConnectionId ?? savedConnection?.connectionId;
      const token = savedConnection === undefined
        ? null
        : await this.readHostToken(savedConnection.connectionId, true);
      if (this.disposed) return;
      this.setState({
        savedConnections: collection.hosts,
        ...(selectedConnectionId === undefined
          ? {}
          : { selectedConnectionId }),
        phase: savedConnection !== undefined && token !== null ? 'ready' : 'unconfigured',
        savedConnection: savedConnection ?? undefined,
        tokenAvailable: token !== null,
        selection: {
          ...(savedConnection?.lastWorkspaceId === undefined ? {} : { workspaceId: savedConnection.lastWorkspaceId }),
          ...(savedConnection?.lastModelId === undefined ? {} : { modelId: savedConnection.lastModelId }),
        },
      });
      if (savedConnection !== undefined && token !== null) {
        void this.attachConnection({
          connectionId: savedConnection.connectionId,
          address: savedConnection.address,
          mode: savedConnection.mode,
          token,
        }, false);
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

  private async connect(
    values: ConnectionFormValues,
    requestedConnectionId?: ConnectionId | string | null,
  ): Promise<ConnectionActionResult> {
    const savedConnection = this.state.savedConnection;
    const connectionId = requestedConnectionId === null
      ? createConnectionId(`connection-${this.dependencies.createId()}`)
      : requestedConnectionId === undefined
        ? savedConnection?.connectionId ?? createConnectionId(`connection-${this.dependencies.createId()}`)
        : createConnectionId(String(requestedConnectionId));
    let valuesToValidate = values;
    if (values.token.trim().length === 0 && requestedConnectionId !== null) {
      try {
        const storedToken = await this.readHostToken(connectionId, true);
        if (storedToken !== null) valuesToValidate = { ...values, token: storedToken };
      } catch {
        return { ok: false, errors: { token: '该 Host 的 Token 读取失败，请重新输入' } };
      }
    }
    const result = validateConnectionForm(valuesToValidate);
    if (!result.ok) return result;
    const operationGeneration = this.beginConnectionOperation();

    const existingHost = this.state.savedConnections.find((host) => host.connectionId === connectionId);
    const hostPreferences = Object.freeze({
      connectionId,
      address: result.config.address,
      mode: result.config.mode,
      ...(existingHost?.lastWorkspaceId === undefined
        ? {}
        : { lastWorkspaceId: existingHost.lastWorkspaceId }),
      ...(existingHost?.lastModelId === undefined
        ? {}
        : { lastModelId: existingHost.lastModelId }),
    });
    const config = Object.freeze({
      connectionId,
      address: result.config.address,
      mode: result.config.mode,
      token: result.config.token,
    });

    try {
      await this.writeHostToken(connectionId, config.token);
      await this.saveHostCollection({
        hosts: upsertConnection(this.state.savedConnections, hostPreferences),
        selectedConnectionId: connectionId,
      });
      if (!this.isCurrentConnectionOperation(operationGeneration)) return { ok: false, errors: { hostUrl: '连接请求已切换' } };
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
      return { ok: false, errors: { hostUrl: '连接配置保存失败，请稍后重试' } };
    }

    this.setState({
      phase: 'ready',
      savedConnections: upsertConnection(this.state.savedConnections, hostPreferences),
      selectedConnectionId: connectionId,
      savedConnection: hostPreferences,
      tokenAvailable: true,
      selection: {
        ...(hostPreferences.lastWorkspaceId === undefined ? {} : { workspaceId: hostPreferences.lastWorkspaceId }),
        ...(hostPreferences.lastModelId === undefined ? {} : { modelId: hostPreferences.lastModelId }),
      },
      operationError: undefined,
    });
    const attempt = this.attachConnection(config);
    const connectionResult = await attempt;
    if (!this.isCurrentConnectionOperation(operationGeneration)) return { ok: false, errors: { hostUrl: '连接请求已切换' } };
    if (connectionResult.ok) return { ok: true };
    return {
      ok: false,
      errors: { hostUrl: connectionFailureMessage(connectionResult.code) },
    };
  }

  private async reconnectSaved(): Promise<boolean> {
    const savedConnection = this.state.savedConnection;
    if (savedConnection === undefined) return false;
    const operationGeneration = this.beginConnectionOperation();
    try {
      const token = await this.readHostToken(savedConnection.connectionId, true);
      if (!this.isCurrentConnectionOperation(operationGeneration)) return false;
      if (token === null || token.trim().length === 0) {
        this.setState({ tokenAvailable: false, phase: 'unconfigured' });
        return false;
      }
      this.setState({ phase: 'ready', operationError: undefined });
      const attempt = this.attachConnection({
        connectionId: savedConnection.connectionId,
        address: savedConnection.address,
        mode: savedConnection.mode,
        token,
      });
      const result = await attempt;
      if (!this.isCurrentConnectionOperation(operationGeneration)) return false;
      return result.ok;
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
      return false;
    }
  }

  private async switchConnection(connectionId: ConnectionId | string): Promise<ConnectionActionResult> {
    const selectedId = createConnectionId(String(connectionId));
    const host = this.state.savedConnections.find((candidate) => candidate.connectionId === selectedId);
    if (host === undefined) {
      return { ok: false, errors: { hostUrl: '找不到要切换的 Host' } };
    }
    const operationGeneration = this.beginConnectionOperation();
    // A Host switch is an ownership change: the previous supervisor must be
    // fenced before any token/config lookup for the replacement proceeds.
    this.detachSupervisor(true);
    try {
      const token = await this.readHostToken(selectedId, false);
      if (!this.isCurrentConnectionOperation(operationGeneration)) return { ok: false, errors: { hostUrl: '连接请求已切换' } };
      if (token === null || token.trim().length === 0) {
        this.setState({ selectedConnectionId: selectedId, savedConnection: host, tokenAvailable: false, phase: 'unconfigured' });
        await this.saveHostSelection(selectedId);
        return { ok: false, errors: { token: '请输入该 Host 的 Token' } };
      }
      await this.saveHostSelection(selectedId);
      if (!this.isCurrentConnectionOperation(operationGeneration)) return { ok: false, errors: { hostUrl: '连接请求已切换' } };
      this.setState({
        selectedConnectionId: selectedId,
        savedConnection: host,
        tokenAvailable: true,
        selection: {
          ...(host.lastWorkspaceId === undefined ? {} : { workspaceId: host.lastWorkspaceId }),
          ...(host.lastModelId === undefined ? {} : { modelId: host.lastModelId }),
        },
        phase: 'ready',
        operationError: undefined,
      });
      const result = await this.attachConnection({
        connectionId: host.connectionId,
        address: host.address,
        mode: host.mode,
        token,
      });
      if (!this.isCurrentConnectionOperation(operationGeneration)) return { ok: false, errors: { hostUrl: '连接请求已切换' } };
      if (result.ok) return { ok: true };
      return { ok: false, errors: { hostUrl: connectionFailureMessage(result.code) } };
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'STORAGE_UNAVAILABLE' } });
      return { ok: false, errors: { hostUrl: '连接配置读取失败，请稍后重试' } };
    }
  }

  private disconnect(): void {
    this.beginConnectionOperation();
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

  private async resolveWorkspace(path: string): Promise<WorkspaceResolutionResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor?.resolveWorkspace === undefined) {
      return this.failWorkspace('RESOLVE_WORKSPACE_UNAVAILABLE', 'Host 暂不支持工作区路径校验');
    }

    try {
      const result = await supervisor.resolveWorkspace({ channel: AGENT_ROOT_URI, path });
      const workspace = result.workspace;
      if (workspace.status !== 'available') {
        return this.failWorkspace('WORKSPACE_UNAVAILABLE', `Host 返回的工作区不可用：${workspace.displayName}`);
      }
      this.setState({
        selection: { ...this.state.selection, workspaceId: workspace.id },
        operationError: undefined,
      });
      void this.persistSelection({ workspaceId: workspace.id });
      return { status: 'accepted', workspace };
    } catch (error) {
      const details = workspaceOperationErrorDetails(error);
      return this.failWorkspace(details.code, details.message);
    }
  }

  private setModel(modelId: string): void {
    this.setState({ selection: { ...this.state.selection, modelId } });
    void this.persistSelection({ modelId });
  }

  private setEffort(effort: RuntimeSelection['effort']): void {
    this.setState({ selection: { ...this.state.selection, effort } });
  }

  private setPermissionMode(permissionMode: HostPermissionMode): void {
    this.setState({ selection: { ...this.state.selection, permissionMode } });
  }

  private async persistSelection(selection: Partial<RuntimeSelection>): Promise<void> {
    const savedConnection = this.state.savedConnection;
    if (savedConnection === undefined) return;
    try {
      const updatedHost = Object.freeze({
        ...savedConnection,
        ...(selection.workspaceId === undefined ? {} : { lastWorkspaceId: selection.workspaceId }),
        ...(selection.modelId === undefined ? {} : { lastModelId: selection.modelId }),
      });
      const hosts = upsertConnection(this.state.savedConnections, updatedHost);
      this.setState({ savedConnections: hosts, savedConnection: updatedHost });
      await this.saveHostCollection({ hosts, selectedConnectionId: savedConnection.connectionId });
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
        effort: input.effort ?? this.state.selection.effort,
        permissionMode: input.permissionMode ?? this.state.selection.permissionMode,
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

  private async supportedCommands(chatUri: ChatUri): Promise<readonly HostSlashCommand[]> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor?.supportedCommands === undefined) return Object.freeze([]);
    try {
      if (!this.state.sync.subscriptions.includes(chatUri)) await supervisor.subscribe(chatUri);
      return (await supervisor.supportedCommands(chatUri)).commands;
    } catch {
      return Object.freeze([]);
    }
  }

  private async configureChat(input: HostConfigureChatParams): Promise<ChatActionResult> {
    const supervisor = this.requireConnectedSupervisor();
    if (supervisor?.configureChat === undefined) return this.failChatOperation('configure', input.channel, 'NOT_CONNECTED');
    try {
      if (!this.state.sync.subscriptions.includes(input.channel)) await supervisor.subscribe(input.channel);
      await supervisor.configureChat(input);
      this.setState({ chatOperationError: undefined });
      return { status: 'accepted', operation: 'configure', chatUri: input.channel };
    } catch (error) {
      return this.failChatOperation('configure', input.channel, errorCode(error));
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
    message?: string,
  ): NewChatResult {
    const error: RuntimeOperationError = {
      operation,
      code,
      ...(chatUri === undefined ? {} : { chatUri }),
      ...(message === undefined ? {} : { message }),
    };
    this.setState({ operationError: error });
    return {
      status: 'error',
      operation,
      code,
      ...(chatUri === undefined ? {} : { chatUri }),
      ...(message === undefined ? {} : { message }),
    };
  }

  private requireConnectedSupervisor(): RuntimeSupervisor | undefined {
    const supervisor = this.supervisor;
    if (supervisor === undefined || supervisor.getState().status !== 'connected') return undefined;
    return supervisor;
  }

  private failWorkspace(code: string, message?: string): WorkspaceResolutionResult {
    this.setState({ operationError: { operation: 'workspace', code, ...(message === undefined ? {} : { message }) } });
    return { status: 'error', operation: 'workspace', code, ...(message === undefined ? {} : { message }) };
  }

  private attachConnection(config: {
    readonly connectionId: ConnectionId;
    readonly address: string;
    readonly token: string;
    readonly mode: ConnectionMode;
  }, waitForReady = true): Promise<ConnectionAttemptResult> {
    this.detachSupervisor(true);
    const syncStore = createSyncStore({ address: config.address, subscriptions: [AGENT_ROOT_URI] });
    let supervisor: RuntimeSupervisor;
    try {
      supervisor = (this.dependencies.createSupervisor ?? createDefaultSupervisor)({
        config,
        clientId: this.dependencies.clientId ?? `client-${this.dependencies.createId()}`,
        clientInfo: {
          name: 'Cloud',
          version: '0.4.0',
          platform: this.dependencies.platform ?? 'unknown',
        },
        store: syncStore,
        appState: this.dependencies.appState,
        initialSubscriptions: [AGENT_ROOT_URI],
      });
    } catch {
      this.setState({ phase: 'error', operationError: { operation: 'create', code: 'CONNECTION' } });
      return Promise.resolve({ ok: false, code: 'CONNECTION' });
    }
    this.supervisor = supervisor;
    this.removeSyncSubscription = syncStore.subscribe((sync) => {
      this.setState({ sync });
    });
    this.setState({ sync: syncStore.getState(), phase: 'ready', operationError: undefined });
    try {
      supervisor.start();
    } catch {
      this.setState({
        phase: 'error',
        operationError: { operation: 'create', code: 'CONNECTION' },
      });
      return Promise.resolve({ ok: false, code: 'CONNECTION' });
    }
    return waitForReady
      ? this.waitForConnection(syncStore, supervisor)
      : Promise.resolve({ ok: true });
  }

  private waitForConnection(syncStore: { getState(): SyncState; subscribe(listener: (state: SyncState) => void): () => void }, supervisor: RuntimeSupervisor): Promise<ConnectionAttemptResult> {
    const immediate = connectionAttemptResult(syncStore.getState(), supervisor);
    if (immediate !== undefined) {
      if (!immediate.ok) this.setState({ phase: 'error', operationError: { operation: 'create', code: normalizeConnectionFailureCode(immediate.code) } });
      return Promise.resolve(immediate);
    }

    const timeoutMs = this.dependencies.connectionTimeoutMs ?? 15_000;
    return new Promise<ConnectionAttemptResult>((resolve) => {
      let settled = false;
      let remove = (): void => undefined;
      const timeout = setTimeout(() => settle({ ok: false, code: 'TIMEOUT' }), Math.max(0, timeoutMs));
      const settle = (result: ConnectionAttemptResult): void => {
        if (settled) return;
        settled = true;
        remove();
        clearTimeout(timeout);
        if (this.cancelConnectionAttempt === cancel) this.cancelConnectionAttempt = undefined;
        if (!result.ok) {
          this.setState({ phase: 'error', operationError: { operation: 'create', code: normalizeConnectionFailureCode(result.code) } });
        }
        resolve(result);
      };
      const cancel = (): void => settle({ ok: false, code: 'CANCELLED' });
      this.cancelConnectionAttempt?.();
      this.cancelConnectionAttempt = cancel;
      remove = syncStore.subscribe((next) => {
        const result = connectionAttemptResult(next, supervisor);
        if (result === undefined || settled) return;
        settle(result);
      });
    });
  }

  private beginConnectionOperation(): number {
    this.connectionOperationGeneration += 1;
    this.cancelConnectionAttempt?.();
    this.cancelConnectionAttempt = undefined;
    return this.connectionOperationGeneration;
  }

  private isCurrentConnectionOperation(generation: number): boolean {
    return !this.disposed && generation === this.connectionOperationGeneration;
  }

  private async readHostToken(connectionId: ConnectionId, migrateLegacy: boolean): Promise<string | null> {
    const scoped = isHostTokenStore(this.dependencies.tokenStore)
      ? await this.dependencies.tokenStore.readForHost(connectionId)
      : await this.dependencies.tokenStore.read();
    const usableScoped = scoped !== null && scoped.trim().length > 0 ? scoped : null;
    if (usableScoped !== null || !migrateLegacy || !isHostTokenStore(this.dependencies.tokenStore)) return usableScoped;

    const legacy = await this.dependencies.tokenStore.read();
    if (legacy === null || legacy.trim().length === 0) return null;
    await this.dependencies.tokenStore.writeForHost(connectionId, legacy);
    // Remove the old unscoped secret after a successful scoped write. This
    // prevents a token for Host A from being accidentally reused for Host B.
    try {
      await this.dependencies.tokenStore.clear();
    } catch {
      // A scoped copy exists; a failed cleanup must not block first launch.
    }
    return legacy;
  }

  private writeHostToken(connectionId: ConnectionId, token: string): Promise<void> {
    return isHostTokenStore(this.dependencies.tokenStore)
      ? this.dependencies.tokenStore.writeForHost(connectionId, token)
      : this.dependencies.tokenStore.write(token);
  }

  private async saveHostCollection(collection: ConnectionPreferencesCollection): Promise<void> {
    if (this.hostPreferences !== undefined) {
      await this.hostPreferences.saveHosts(collection);
      return;
    }
    const selected = findSelectedConnection(collection);
    if (selected !== undefined && this.preferences !== undefined) await this.preferences.save(selected);
  }

  private async saveHostSelection(connectionId: ConnectionId): Promise<void> {
    const collection = {
      hosts: this.state.savedConnections,
      selectedConnectionId: connectionId,
    };
    await this.saveHostCollection(collection);
    this.setState({ selectedConnectionId: connectionId });
  }

  private detachSupervisor(stop: boolean): void {
    this.cancelConnectionAttempt?.();
    this.cancelConnectionAttempt = undefined;
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
  readonly effort?: RuntimeSelection['effort'];
  readonly permissionMode?: HostPermissionMode;
}

export interface CloudRuntimeActions {
  connect(values: ConnectionFormValues, connectionId?: ConnectionId | string | null): Promise<ConnectionActionResult>;
  switchConnection(connectionId: ConnectionId | string): Promise<ConnectionActionResult>;
  /** Alias retained for UI callers that model a Host row as a selection. */
  selectConnection(connectionId: ConnectionId | string): Promise<ConnectionActionResult>;
  reconnectSaved(): Promise<boolean>;
  disconnect(): void;
  retryConnection(): void;
  subscribeChat(chatUri: ChatUri): Promise<boolean>;
  setWorkspace(workspaceId: string): void;
  resolveWorkspace(path: string): Promise<WorkspaceResolutionResult>;
  setModel(modelId: string): void;
  setEffort(effort: RuntimeSelection['effort']): void;
  setPermissionMode(permissionMode: HostPermissionMode): void;
  createChatAndSend(input: CreateChatAndSendInput): Promise<NewChatResult>;
  retryPendingSend(): Promise<NewChatResult>;
  sendChat(input: SendChatInput): Promise<ChatActionResult>;
  supportedCommands(chatUri: ChatUri): Promise<readonly HostSlashCommand[]>;
  configureChat(input: HostConfigureChatParams): Promise<ChatActionResult>;
  interruptChat(input: InterruptChatInput): Promise<ChatActionResult>;
  allowApproval(input: ResolveApprovalInput): Promise<ChatActionResult>;
  denyApproval(input: ResolveApprovalInput): Promise<ChatActionResult>;
  resolveInput(input: ResolveInputActionInput): Promise<ChatActionResult>;
  clearOperationError(): void;
  clearChatOperationError(): void;
}

export type WorkspaceResolutionResult =
  | { readonly status: 'accepted'; readonly workspace: HostResolveWorkspaceResult['workspace'] }
  | { readonly status: 'error'; readonly operation: 'workspace'; readonly code: string; readonly message?: string };

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

interface ConnectionAttemptResult {
  readonly ok: boolean;
  readonly code?: string;
}

function connectionAttemptResult(
  sync: SyncState,
  supervisor: RuntimeSupervisor,
): ConnectionAttemptResult | undefined {
  const supervisorState = supervisor.getState();
  if (supervisorState.status === 'connected') return { ok: true };
  if (supervisorState.status === 'error' || supervisorState.status === 'replaced') {
    return { ok: false, code: normalizeConnectionFailureCode(supervisorState.errorCode) };
  }
  if (sync.status === 'connected') return { ok: true };
  if (sync.status === 'error' || sync.status === 'replaced') {
    return { ok: false, code: normalizeConnectionFailureCode(sync.errorCode) };
  }
  return undefined;
}

function normalizeConnectionFailureCode(code: string | undefined): string {
  if (code === undefined || code.length === 0) return 'CONNECTION';
  if (code.startsWith('CLOSED_')) return 'CLOSED';
  if (code === 'TRANSPORT' || code === 'FACTORY') return 'CONNECTION';
  return code;
}

function connectionFailureMessage(code: string | undefined): string {
  switch (normalizeConnectionFailureCode(code)) {
    case 'TIMEOUT': return 'Host 响应超时，请检查地址与网络';
    case 'CLOSED': return 'Host 连接已关闭，请检查地址与网络';
    case 'PROTOCOL': return 'Host 返回了无法识别的数据';
    case 'CONNECTION': return '无法连接 Host，请检查地址与网络';
    case 'CANCELLED': return '连接请求已取消';
    default: return '无法连接 Host，请检查地址与网络';
  }
}

function isHostPreferencesStore(
  value: ConnectionPreferencesStore | HostPreferencesStore | undefined,
): value is HostPreferencesStore {
  if (value === undefined) return false;
  return typeof (value as Partial<HostPreferencesStore>).loadHosts === 'function'
    && typeof (value as Partial<HostPreferencesStore>).saveHosts === 'function';
}

function isLegacyPreferencesStore(
  value: ConnectionPreferencesStore | HostPreferencesStore | undefined,
): value is ConnectionPreferencesStore {
  if (value === undefined) return false;
  return typeof (value as Partial<ConnectionPreferencesStore>).load === 'function'
    && typeof (value as Partial<ConnectionPreferencesStore>).save === 'function';
}

function createLegacyHostPreferencesStore(store: ConnectionPreferencesStore): HostPreferencesStore {
  return Object.freeze({
    loadHosts: async (): Promise<ConnectionPreferencesCollection> => {
      const host = await store.load();
      return host === null
        ? Object.freeze({ hosts: Object.freeze([]) })
        : Object.freeze({ hosts: Object.freeze([host]), selectedConnectionId: host.connectionId });
    },
    saveHosts: async (collection: ConnectionPreferencesCollection): Promise<void> => {
      const host = findSelectedConnection(collection);
      if (host !== undefined) await store.save(host);
    },
    selectHost: async (connectionId: ConnectionId | string): Promise<void> => {
      const host = await store.load();
      if (host === null || host.connectionId !== String(connectionId)) throw new TypeError('connectionId is not configured');
      await store.save(host);
    },
  });
}

function findSelectedConnection(collection: ConnectionPreferencesCollection): ConnectionPreferences | undefined {
  return collection.hosts.find((host) => host.connectionId === collection.selectedConnectionId)
    ?? collection.hosts[0];
}

function upsertConnection(
  hosts: readonly ConnectionPreferences[],
  host: ConnectionPreferences,
): readonly ConnectionPreferences[] {
  const index = hosts.findIndex((candidate) => candidate.connectionId === host.connectionId);
  if (index < 0) return Object.freeze([...hosts, host]);
  const next = [...hosts];
  next[index] = host;
  return Object.freeze(next);
}

function isHostTokenStore(value: TokenStore): value is TokenStore & HostTokenStore {
  return typeof value.readForHost === 'function' && typeof value.writeForHost === 'function';
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TransportTimeoutError') return 'TIMEOUT';
  if (error instanceof Error && error.name === 'TransportClosedError') return 'CLOSED';
  if (error instanceof Error && error.name === 'TransportConnectionError') return 'CONNECTION';
  if (error instanceof Error && error.name === 'TransportRpcError') return 'RPC_ERROR';
  if (error instanceof Error && error.name === 'TransportProtocolError') return 'PROTOCOL';
  return 'UNKNOWN';
}

type WorkspaceResolveErrorCode =
  | 'WORKSPACE_PATH_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NOT_DIRECTORY'
  | 'WORKSPACE_ACCESS_DENIED'
  | 'WORKSPACE_RESOLVE_FAILED';

const workspaceResolveErrorMessages: Readonly<Record<WorkspaceResolveErrorCode, string>> = Object.freeze({
  WORKSPACE_PATH_INVALID: '工作区路径格式无效，请输入绝对路径',
  WORKSPACE_NOT_FOUND: '找不到这个工作区路径',
  WORKSPACE_NOT_DIRECTORY: '这个路径不是文件夹',
  WORKSPACE_ACCESS_DENIED: '没有权限访问这个工作区',
  WORKSPACE_RESOLVE_FAILED: '工作区校验失败，请稍后重试',
});

function isWorkspaceResolveErrorCode(value: unknown): value is WorkspaceResolveErrorCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(workspaceResolveErrorMessages, value);
}

function workspaceOperationErrorDetails(error: unknown): { readonly code: WorkspaceResolveErrorCode; readonly message: string } {
  if (error instanceof TransportRpcError) {
    const data = error.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const code = (data as { readonly code?: JsonValue }).code;
      if (isWorkspaceResolveErrorCode(code)) {
        return { code, message: workspaceResolveErrorMessages[code] };
      }
    }
  }
  return {
    code: 'WORKSPACE_RESOLVE_FAILED',
    message: workspaceResolveErrorMessages.WORKSPACE_RESOLVE_FAILED,
  };
}

function freezeRuntimeState(state: CloudRuntimeState): CloudRuntimeState {
  return Object.freeze({
    ...state,
    sync: freezeSyncState(state.sync),
    savedConnections: Object.freeze([...state.savedConnections]),
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
