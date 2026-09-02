import { randomUUID, type UUID } from 'node:crypto';

import type {
  CanUseTool,
  EffortLevel,
  McpServerConfig,
  OnElicitation,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SdkPluginConfig,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import { ClaudeChatActor, ClaudeChatActorError } from '../chat/claudeChatActor.js';
import { CommandDeduper } from '../chat/commandDeduper.js';
import { SequencerByKey } from '../chat/sequencer.js';
import type { ChatUri, RootUri, TurnId } from '../domain/ids.js';
import {
  createTurnId,
  parseApprovalId,
  parseInputRequestId,
  parseModelId,
  parseToolCallId,
  parseTurnId,
} from '../domain/ids.js';
import type {
  ApprovalRequestedAction,
  ApprovalResolvedAction,
  InputRequestedAction,
  InputResolvedAction,
} from '../domain/actions.js';
import type {
  ApprovalInput,
  ApprovalSuggestion,
  InputAnswers,
  InputQuestion,
  JsonObject,
} from '../domain/chat.js';
import type { CatalogCreateChatInput } from '../chat/chatCommandActor.js';
import { ClaudeAgentSdkService } from './claudeAgentSdkService.js';
import {
  ClaudeChatRegistry,
  type ClaudeChatRuntime,
  type ClaudeChatRuntimeFactory,
  type ClaudeChatRuntimeFactoryInput,
} from './claudeChatRegistry.js';
import {
  createChatBacking,
  markChatBackingMaterialized,
  type ChatBacking,
  type CreateChatBackingInput,
} from './chatBacking.js';
import { ClaudeQueryRuntime } from './claudeQueryRuntime.js';
import { buildClaudeOptions } from './options.js';
import { hydrateClaudeHistory } from './replayMapper.js';
import { ClaudeRuntimeActionBridge } from './runtimeActionBridge.js';
import type { ClaudeRuntimeConfig } from './runtimeConfig.js';
import type {
  ClaudeRuntimeSignal,
  ClaudeRuntimeState,
  ClaudeTurnHandle,
} from './runtimeTypes.js';
import {
  HostStateProvider,
} from '../protocol/stateProvider.js';
import { createChatUri, createRootUri, parseChatUri } from '../domain/resources.js';
import { CATALOG_ACTION_TYPES } from '../catalog/reducer.js';
import {
  createCatalogSession,
  createModel,
  createRootCatalogState,
  createWorkspace,
  normalizeCatalogSessionConfiguration,
  type CatalogModel,
  type CatalogSession,
  type RootCatalogState,
} from '../catalog/types.js';
import type { ActionOrigin, ChatActionEnvelope } from '../protocol/types.js';
import {
  projectCatalogSessions,
  projectCatalogModels,
  projectSessionConfiguration,
  projectCatalogWorkspaces,
  type CatalogListSessionsResult,
  type CatalogSessionConfiguration,
  type CatalogSdkModelInfo,
  type CatalogSource,
  type CatalogSourceSnapshot,
} from './catalogSource.js';
import {
  createFilesystemWorkspaceResolver,
  type WorkspaceFilesystem,
} from './workspaceResolver.js';
import {
  ProtocolServerHandler,
  type ProtocolAuthorizationOptions,
  type ProtocolPrincipalResolver,
} from '../protocol/protocolServerHandler.js';
import type { AccessControlList, ResourceAcl } from '../security/acl.js';
import type { Principal } from '../security/identity.js';
import {
  createAgentHostServer,
  type AgentHostServerOptions,
  type AgentHostTimer,
  type ConnectionIdAllocator,
} from '../transport/fastifyServer.js';
import { HostStateManager } from '../host/hostStateManager.js';
import { LogicalClientRegistry } from '../host/logicalClientRegistry.js';
import {
  PendingInteractionRegistry,
  type InteractionAction,
  type InteractionTimer,
} from '../interaction/pendingInteractionRegistry.js';
import type {
  ChatInteractionResolutionResult,
  ChatInteractionResolver,
} from '../chat/chatCommandActor.js';
import type {
  DomainChatBackingWriteInput,
  SaveChatBackingInput,
} from '../persistence/overlayRepository.js';
import type { PersistedChatBacking } from '../persistence/types.js';

const DEFAULT_REPLAY_CAPACITY = 1024;
const DEFAULT_COMMAND_RECEIPT_CAPACITY = 1024;
const DEFAULT_PERMISSION_MESSAGE = 'Tool approval is not configured';
const defaultInteractionTimer: InteractionTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PersistedChatMetadata {
  readonly title?: string;
  readonly archived: boolean;
}

type ComposedServerOptionKeys =
  | 'handler'
  | 'protocolServerHandler'
  | 'protocolHandler'
  | 'disposeHandlerOnClose'
  | 'disposeHandler'
  | 'ownsHandler';

/** Server configuration accepted by the host without a caller-supplied handler. */
export type ClaudeAgentHostServerOptions = Omit<
  AgentHostServerOptions,
  ComposedServerOptionKeys
>;

/**
 * SDK-free shape of the narrow facade stored on a host.
 *
 * `never[]` keeps the callable members opaque in the package-root declaration
 * while official parameter and return types remain confined to this Claude
 * layer's internal adapter.
 */
export interface ClaudeAgentHostSdkService {
  startup(...args: never[]): unknown;
  listSessions?(...args: never[]): unknown;
  getSessionMessages(...args: never[]): unknown;
  /** Optional SDK Query catalog probe; absent in lightweight test adapters. */
  listSupportedModels?(...args: never[]): unknown;
}

type InternalClaudeAgentHostSdkService = Pick<
  ClaudeAgentSdkService,
  'startup' | 'listSessions' | 'getSessionMessages' | 'listSupportedModels'
>;

/** SDK-free registry view exposed by a composed host. */
export type ClaudeAgentHostChatRegistry = Pick<
  ClaudeChatRegistry,
  | 'size'
  | 'runtimeCount'
  | 'activeTurnId'
  | 'materialize'
  | 'createProvisional'
  | 'restorePersistedBacking'
  | 'restoreBacking'
  | 'discardProvisional'
  | 'send'
  | 'interrupt'
  | 'setRuntimeConfig'
  | 'rebind'
  | 'release'
  | 'disposeChat'
  | 'getBacking'
  | 'snapshot'
  | 'snapshots'
  | 'listBackings'
  | 'list'
  | 'shutdown'
>;

/** SDK-free session information passed to a test runtime factory. */
export interface ClaudeAgentHostRuntimeSession {
  readonly kind: 'new' | 'resume';
  readonly sessionId: string;
}

/**
 * SDK-free runtime surface accepted by the host's test factory override.
 * The default implementation is ClaudeQueryRuntime.
 */
export interface ClaudeAgentHostRuntime {
  readonly state: ClaudeRuntimeState;
  start(): Promise<void>;
  send(
    turnId: TurnId,
    text: string,
    options?: Readonly<{ readonly steering?: boolean }>,
  ): ClaudeTurnHandle;
  interrupt(turnId: TurnId): Promise<unknown | undefined>;
  applyRuntimeConfig(config: ClaudeRuntimeConfig): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeAgentHostRuntimeFactoryInput {
  readonly backing: ChatBacking;
  readonly generation: number;
  readonly session: ClaudeAgentHostRuntimeSession;
  /** Runtime signal details stay opaque at the package root. */
  readonly onSignal: (signal: unknown) => void | Promise<void>;
}

export type ClaudeAgentHostRuntimeFactory = (
  input: ClaudeAgentHostRuntimeFactoryInput,
) => ClaudeAgentHostRuntime | PromiseLike<ClaudeAgentHostRuntime>;

export interface ClaudeAgentHostCreateChatInput
  extends Omit<CreateChatBackingInput, 'sdkSessionId'> {
  readonly sdkSessionId?: string;
  /** Optional overlay metadata. The synchronous API does not persist it. */
  readonly title?: string;
  readonly archived?: boolean;
}

/**
 * The persistence surface composed by the host.
 *
 * This structural type keeps the host independent from a concrete SQLite
 * implementation while still requiring the repository's transaction-backed
 * methods. `close` is optional for adapters whose owning application closes
 * the database separately; when present, host shutdown awaits it.
 */
export interface ClaudeAgentHostOverlayRepository {
  saveChatBacking(input: SaveChatBackingInput): Promise<PersistedChatBacking>;
  listChatBackings(): Promise<readonly PersistedChatBacking[]>;
  deleteChatBacking(chatUri: string): Promise<boolean>;
  getChatBacking?(chatUri: string): Promise<PersistedChatBacking | undefined>;
  updateChatBacking?(
    chatUri: string,
    patch: Readonly<{
      readonly lifecycle?: 'provisional' | 'materialized';
      readonly model?: string;
      readonly effort?: string;
      readonly permissionMode?: string;
    }>,
  ): Promise<PersistedChatBacking | undefined>;
  close?(): void | PromiseLike<void>;
}

export interface ClaudeAgentHostOptions {
  readonly hostEpoch: string;
  readonly nowServer: () => string;
  readonly nowAction: () => string;
  readonly sdkService?: ClaudeAgentHostSdkService;
  readonly createSdkSessionId?: () => string;
  readonly createChatId?: () => string;
  readonly createSdkUuid?: () => UUID;
  /** Deployment-owned workspace/model catalog values used by refreshCatalog. */
  readonly catalog?: CatalogSourceSnapshot;
  /** Explicit source for workspace/model values and optional session listing. */
  readonly catalogSource?: CatalogSource;
  /** Optional filesystem port for host-level tests; production defaults to fs. */
  readonly workspaceFilesystem?: WorkspaceFilesystem;
  readonly replayCapacity?: number;
  readonly commandReceiptCapacity?: number;
  readonly canUseTool?: CanUseTool;
  readonly approvalTimeoutMs?: number;
  readonly inputTimeoutMs?: number;
  readonly interactionTimeoutMs?: number;
  readonly interactionTimer?: InteractionTimer;
  readonly createApprovalId?: () => string;
  readonly createInputId?: () => string;
  readonly onElicitation?: OnElicitation;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly plugins?: readonly SdkPluginConfig[];
  readonly hooks?: Options['hooks'];
  readonly settings?: Settings;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly agent?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly stderr?: NonNullable<Options['stderr']>;
  readonly runtimeFactory?: ClaudeAgentHostRuntimeFactory;
  /** Optional transaction-backed product overlay repository. */
  readonly overlayRepository?: ClaudeAgentHostOverlayRepository;
  /** Descriptive alias accepted for callers that call the overlay persistence layer `persistence`. */
  readonly persistence?: ClaudeAgentHostOverlayRepository;
  /** Optional close hook for adapters that expose the store separately. */
  readonly closeOverlayRepository?: () => void | PromiseLike<void>;
  readonly server?: ClaudeAgentHostServerOptions;
  /** Alias for callers that name the transport configuration explicitly. */
  readonly serverOptions?: ClaudeAgentHostServerOptions;

  // Transport aliases keep the orchestration API convenient while preserving
  // the composed ProtocolServerHandler as the only handler.
  readonly fastifyOptions?: FastifyServerOptions;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly timer?: AgentHostTimer;
  readonly clock?: () => number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly highWaterMarkBytes?: number;
  readonly slowClientHighWaterMarkBytes?: number;
  readonly connectionIdAllocator?: ConnectionIdAllocator;
  readonly allocateConnectionId?: ConnectionIdAllocator;
  readonly connectionId?: ConnectionIdAllocator;
  /** Transport-neutral principal/ACL policy consumed by the protocol handler. */
  readonly authorization?: ProtocolAuthorizationOptions;
  /** Top-level aliases for direct host composition. */
  readonly acl?: AccessControlList | ResourceAcl;
  readonly accessControlList?: AccessControlList | ResourceAcl;
  readonly resourceAcl?: AccessControlList | ResourceAcl;
  readonly principal?: Principal;
  readonly principalResolver?: ProtocolPrincipalResolver;
  readonly principalForConnection?: ProtocolPrincipalResolver;
  readonly resolvePrincipal?: ProtocolPrincipalResolver;
  readonly requireAuthorization?: boolean;
}

export interface ClaudeAgentHost {
  readonly server: FastifyInstance;
  readonly hostStateManager: HostStateManager;
  /** Canonical registry accessor. */
  readonly registry: ClaudeAgentHostChatRegistry;
  /** Descriptive alias retained for callers that use the component name. */
  readonly chatRegistry: ClaudeAgentHostChatRegistry;
  /** Host-owned SDK permission and AskUserQuestion waiter registry. */
  readonly interactionRegistry: PendingInteractionRegistry;
  readonly sdkService: ClaudeAgentHostSdkService;
  readonly overlayRepository?: ClaudeAgentHostOverlayRepository;
  createChat(input: ClaudeAgentHostCreateChatInput): ChatBacking;
  /** Persist the overlay before registering the backing in memory. */
  createChatPersisted(input: ClaudeAgentHostCreateChatInput): Promise<ChatBacking>;
  /** Hydrate all persisted backings without starting SDK runtimes. */
  loadPersistedChats(): Promise<readonly ChatBacking[]>;
  /** Delete the durable overlay before removing host memory. */
  disposeChatPersisted(chatUri: ChatUri): Promise<boolean>;
  loadHistory(
    chatUri: ChatUri,
    actionTimestamp?: string,
  ): Promise<ChatActionEnvelope | undefined>;
  refreshCatalog(): Promise<RootCatalogState>;
  shutdown(): Promise<void>;
}

/**
 * Compose one SDK-backed Agent Host. Construction prepares routes and protocol
 * state but never listens, loads the SDK module, starts a query, or reads a
 * credential.
 */
export async function createClaudeAgentHost(
  options: ClaudeAgentHostOptions,
): Promise<ClaudeAgentHost> {
  assertHostOptions(options);

  const sdkService = (options.sdkService ?? new ClaudeAgentSdkService()) as
    unknown as InternalClaudeAgentHostSdkService;
  const createSdkSessionId = options.createSdkSessionId ?? (() => randomUUID());
  const createChatId = options.createChatId ?? (() => randomUUID());
  const createSdkUuid = options.createSdkUuid ?? randomUUID;
  const canUseTool = options.canUseTool ?? defaultCanUseTool;
  const overlayRepository = options.overlayRepository ?? options.persistence;
  const persistedChatUris = new Set<ChatUri>();
  const persistedChatMetadata = new Map<ChatUri, PersistedChatMetadata>();
  let persistenceTail: Promise<void> = Promise.resolve();

  const enqueuePersistence = <Result>(
    task: () => Result | PromiseLike<Result>,
  ): Promise<Result> => {
    const result = persistenceTail.then(task);
    persistenceTail = result.then(() => undefined, () => undefined);
    return result;
  };

  if (overlayRepository !== undefined) {
    assertOverlayRepository(overlayRepository);
  }

  const hostStateManager = new HostStateManager({
    now: options.nowServer,
    replayCapacity: options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY,
  });
  const logicalClientRegistry = new LogicalClientRegistry();
  const rootCatalog = createRootCatalogState({
    resource: createRootUri(),
    host: { id: options.hostEpoch, displayName: 'CCVibe Host' },
    modifiedAt: options.nowAction(),
  });
  hostStateManager.registerCatalog(rootCatalog.resource, rootCatalog);
  const filesystemWorkspaceResolver = createFilesystemWorkspaceResolver(options.workspaceFilesystem);
  const interactionRegistry = new PendingInteractionRegistry({
    dispatch: (chat, action) => dispatchInteractionAction(hostStateManager, chat, action),
    now: options.nowAction,
    ...(options.createApprovalId === undefined ? { createApprovalId: () => randomUUID() } : { createApprovalId: options.createApprovalId }),
    ...(options.createInputId === undefined ? { createInputId: () => randomUUID() } : { createInputId: options.createInputId }),
    ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
    ...(options.inputTimeoutMs === undefined ? {} : { inputTimeoutMs: options.inputTimeoutMs }),
    ...(options.interactionTimeoutMs === undefined ? {} : { timeoutMs: options.interactionTimeoutMs }),
    timer: options.interactionTimer ?? defaultInteractionTimer,
  });
  const interactionResolver = createInteractionResolver(interactionRegistry);
  const runtimeActionBridge = new ClaudeRuntimeActionBridge({
    hostStateManager,
    nowAction: options.nowAction,
  });
  const onBackingMaterialized = overlayRepository === undefined
    ? undefined
    : async (backing: ChatBacking): Promise<void> => {
      if (!persistedChatUris.has(backing.chatUri)) {
        return;
      }
      await enqueuePersistence(async () => {
        if (!persistedChatUris.has(backing.chatUri)) {
          return;
        }
        if (overlayRepository.updateChatBacking !== undefined) {
          const persisted = await overlayRepository.updateChatBacking(backing.chatUri, {
            lifecycle: 'materialized',
          });
          if (persisted === undefined) {
            throw new Error('persisted chat backing was not found during materialization');
          }
          return;
        }

        // Older structural adapters may expose only save/upsert. Preserve the
        // optional metadata while replacing the lifecycle in one committed row.
        const metadata = persistedChatMetadata.get(backing.chatUri);
        const writeInput: DomainChatBackingWriteInput = {
          backing,
          ...(metadata?.title === undefined ? {} : { title: metadata.title }),
          ...(metadata === undefined ? {} : { archived: metadata.archived }),
        };
        await overlayRepository.saveChatBacking(writeInput);
      });
    };
  const registry = new ClaudeChatRegistry({
    sequencer: new SequencerByKey<ChatUri>(),
    runtimeFactory: createRuntimeFactory({
      sdkService,
      createSdkUuid,
      canUseTool,
      options,
    }),
    onSignal: (chatUri, signal) => {
      runtimeActionBridge.handle(chatUri, signal);
      if (signal.type === 'runtime/init') {
        const catalog = hostStateManager.getCatalogState(rootCatalog.resource);
        const session = catalog?.sessions.find((candidate) => candidate.chatUri === chatUri);
        if (catalog !== undefined && session !== undefined) {
          const configuration = normalizeCatalogSessionConfiguration(
            { modelId: signal.model },
            catalog.models,
            catalog.defaultModelId,
          );
          const timestamp = options.nowAction();
          hostStateManager.dispatchCatalog(rootCatalog.resource, {
            type: CATALOG_ACTION_TYPES.chatUpdated,
            session: createCatalogSession({
              ...withoutSessionConfiguration(session),
              ...configuration,
              permissionMode: signal.permissionMode,
              updatedAt: timestamp,
            }),
            timestamp,
          });
        }
      }
      if (signal.type === 'runtime/terminal') {
        interactionRegistry.cancelChat(chatUri, 'Claude runtime closed');
      }
    },
    ...(options.canUseTool === undefined
      ? {
          createCanUseTool: (chatUri: ChatUri, getTurnId: () => TurnId | undefined): CanUseTool =>
            createHostCanUseTool(
              chatUri,
              getTurnId,
              interactionRegistry,
              logicalClientRegistry,
            ),
        }
      : {}),
    ...(onBackingMaterialized === undefined ? {} : { onBackingMaterialized }),
  });

  const createChatFromCatalog = (
    channel: RootUri,
    input: CatalogCreateChatInput,
    origin: ActionOrigin,
  ): ChatUri => {
    const catalog = hostStateManager.getCatalogState(channel);
    if (catalog === undefined) {
      throw new ClaudeChatActorError('CATALOG_UNAVAILABLE');
    }
    const workspace = catalog.workspaces.find((candidate) => candidate.id === input.workspaceId);
    if (workspace === undefined) {
      throw new ClaudeChatActorError('WORKSPACE_NOT_FOUND');
    }
    if (workspace.status !== 'available') {
      throw new ClaudeChatActorError('WORKSPACE_UNAVAILABLE');
    }
    const model = catalog.models.find((candidate) => candidate.id === input.modelId);
    if (model === undefined) {
      throw new ClaudeChatActorError('MODEL_NOT_SUPPORTED');
    }
    // Resolve the complete configuration before any backing, session, or
    // catalog action is constructed. This keeps an unsupported effort from
    // being persisted or emitted; omission deliberately delegates to the SDK
    // default semantics.
    const configuration = normalizeCatalogSessionConfiguration(
      { modelId: model.id, effort: input.effort },
      catalog.models,
      catalog.defaultModelId,
    );

    let timestamp: string;
    try {
      timestamp = options.nowAction();
      if (timestamp.length === 0) {
        throw new TypeError('catalog action timestamp must be non-empty');
      }
    } catch {
      throw new ClaudeChatActorError('CATALOG_CREATE_FAILED');
    }

    const backing = registry.createProvisional({
      chatUri: createChatUri(options.hostEpoch, createChatId()),
      sdkSessionId: createSdkSessionId(),
      cwd: workspace.path,
      desiredConfig: {
        permissionMode: input.permissionMode ?? catalog.defaultPermissionMode,
        ...(configuration.modelId === undefined ? {} : { model: configuration.modelId }),
        ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
      },
    });
    let registered = false;
    try {
      hostStateManager.registerChat(backing.chatUri);
      registered = true;
      const session = createCatalogSession({
        chatUri: backing.chatUri,
        sdkSessionRef: backing.sdkSessionId,
        workspaceId: workspace.id,
        title: input.initialPrompt?.trim() || 'New chat',
        updatedAt: timestamp,
        status: 'idle',
        archived: false,
        ...(configuration.modelId === undefined ? {} : { modelId: configuration.modelId }),
        ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
        permissionMode: backing.desiredConfig.permissionMode,
      });
      const envelope = hostStateManager.dispatchCatalog(channel, {
        type: CATALOG_ACTION_TYPES.chatCreated,
        session,
        timestamp,
      }, origin);
      if (envelope === undefined) {
        throw new ClaudeChatActorError('CATALOG_CREATE_FAILED');
      }
      return backing.chatUri;
    } catch (error) {
      if (registered) {
        hostStateManager.unregisterChat(backing.chatUri);
      }
      registry.discardProvisional(backing.chatUri);
      throw error;
    }
  };

  const actor = new ClaudeChatActor({
    hostStateManager,
    registry,
    sequencer: new SequencerByKey<ChatUri>(),
    commandDeduper: new CommandDeduper({
      capacity: options.commandReceiptCapacity ?? DEFAULT_COMMAND_RECEIPT_CAPACITY,
    }),
    nowAction: options.nowAction,
    allocateTurnId: () => createTurnId(randomUUID()),
    interactionResolver,
    createChat: createChatFromCatalog,
  });
  const configureChat = async (
    chatUri: ChatUri,
    patch: Readonly<{
      readonly modelId?: import('../domain/ids.js').ModelId | undefined;
      readonly effort?: import('../catalog/types.js').CatalogEffortLevel | undefined;
      readonly permissionMode?: import('../catalog/types.js').CatalogPermissionMode | undefined;
    }>,
  ): Promise<Readonly<{ modelId?: string; effort?: string; permissionMode: string }>> => {
    const backing = registry.getBacking(chatUri);
    if (backing === undefined) throw new Error('chat backing was not found');
    const catalog = hostStateManager.getCatalogState(rootCatalog.resource);
    if (catalog === undefined) throw new Error('catalog resource was not found');
    const modelId = patch.modelId ?? (backing.desiredConfig.model === undefined
      ? undefined
      : parseModelId(backing.desiredConfig.model));
    const model = modelId === undefined
      ? undefined
      : catalog.models.find((candidate) => candidate.id === modelId);
    if (modelId !== undefined && model === undefined) throw new Error('model is not supported');
    const effort = patch.effort ?? backing.desiredConfig.effort;
    if (effort !== undefined && model !== undefined && (patch.effort !== undefined || patch.modelId !== undefined)) {
      if (!model.capabilities.includes('effort')) throw new Error('model does not support effort');
      if (model.supportedEffortLevels !== undefined && !model.supportedEffortLevels.includes(effort)) {
        throw new Error('effort is not supported by the selected model');
      }
    }
    const permissionMode = patch.permissionMode ?? backing.desiredConfig.permissionMode;
    const nextConfig: ClaudeRuntimeConfig = {
      permissionMode,
      ...(modelId === undefined ? {} : { model: modelId }),
      ...(effort === undefined ? {} : { effort }),
    };

    if (overlayRepository !== undefined && persistedChatUris.has(chatUri)) {
      await enqueuePersistence(async () => {
        if (overlayRepository.updateChatBacking !== undefined) {
          const updated = await overlayRepository.updateChatBacking(chatUri, {
            ...(modelId === undefined ? {} : { model: modelId }),
            ...(effort === undefined ? {} : { effort }),
            permissionMode,
          });
          if (updated === undefined) throw new Error('persisted chat backing was not found');
        } else {
          const metadata = persistedChatMetadata.get(chatUri);
          await overlayRepository.saveChatBacking({
            backing: { ...backing, desiredConfig: nextConfig },
            ...(metadata?.title === undefined ? {} : { title: metadata.title }),
            ...(metadata === undefined ? {} : { archived: metadata.archived }),
          });
        }
      });
    }

    await registry.setRuntimeConfig(chatUri, nextConfig);
    const currentCatalog = hostStateManager.getCatalogState(rootCatalog.resource);
    const session = currentCatalog?.sessions.find((candidate) => candidate.chatUri === chatUri);
    if (session !== undefined) {
      const timestamp = options.nowAction();
      hostStateManager.dispatchCatalog(rootCatalog.resource, {
        type: CATALOG_ACTION_TYPES.chatUpdated,
        session: createCatalogSession({
          ...session,
          updatedAt: timestamp,
          ...(modelId === undefined ? {} : { modelId }),
          ...(effort === undefined ? {} : { effort }),
          permissionMode,
        }),
        timestamp,
      });
    }
    return Object.freeze({
      ...(modelId === undefined ? {} : { modelId }),
      ...(effort === undefined ? {} : { effort }),
      permissionMode,
    });
  };
  const resolveWorkspace = async (channel: RootUri, path: string): Promise<import('../catalog/types.js').CatalogWorkspace> => {
    const workspace = await filesystemWorkspaceResolver.resolveWorkspace(path);
    const timestamp = options.nowAction();
    if (timestamp.length === 0) {
      throw new Error('catalog action timestamp must be non-empty');
    }
    hostStateManager.dispatchCatalog(channel, {
      type: CATALOG_ACTION_TYPES.workspaceUpserted,
      workspace,
      timestamp,
    });
    return workspace;
  };
  const stateProvider = new HostStateProvider(hostStateManager, options.hostEpoch);
  const protocolServerHandler = new ProtocolServerHandler({
    hostEpoch: options.hostEpoch,
    stateProvider,
    logicalClientRegistry,
    chatActor: actor,
    supportedCommandsProvider: (chatUri) => registry.supportedCommands(chatUri),
    chatConfigurator: configureChat,
    workspaceResolver: resolveWorkspace,
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    ...(options.acl === undefined ? {} : { acl: options.acl }),
    ...(options.accessControlList === undefined ? {} : { accessControlList: options.accessControlList }),
    ...(options.resourceAcl === undefined ? {} : { resourceAcl: options.resourceAcl }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.principalResolver === undefined ? {} : { principalResolver: options.principalResolver }),
    ...(options.principalForConnection === undefined ? {} : { principalForConnection: options.principalForConnection }),
    ...(options.resolvePrincipal === undefined ? {} : { resolvePrincipal: options.resolvePrincipal }),
    ...(options.requireAuthorization === undefined ? {} : { requireAuthorization: options.requireAuthorization }),
  });

  let server: FastifyInstance;
  try {
    server = await createAgentHostServer(composeServerOptions(options, protocolServerHandler));
  } catch (error) {
    protocolServerHandler.dispose();
    interactionRegistry.dispose();
    await registry.shutdown();
    await closeOverlayRepository(overlayRepository, options.closeOverlayRepository)
      .catch(() => undefined);
    throw error;
  }

  let shuttingDown = false;
  let protocolDisposed = false;
  let shutdownPromise: Promise<void> | undefined;

  const refreshCatalog = async (): Promise<RootCatalogState> => {
    if (shuttingDown) {
      throw new Error('Claude Agent Host is shutting down');
    }

    const configured = options.catalog ?? {};
    const sourced = options.catalogSource === undefined
      ? {}
      : await options.catalogSource.load();

    const sourceListSessions = options.catalogSource?.listSessions;
    const listSessions = sourceListSessions === undefined
      ? typeof sdkService.listSessions === 'function'
        ? (...args: Parameters<ClaudeAgentSdkService['listSessions']>) => sdkService.listSessions(...args)
        : undefined
      : sourceListSessions;
    const sdkSessions: CatalogListSessionsResult = listSessions === undefined
      ? []
      : await listSessions();
    const configuredWorkspaces = configured.workspaces ?? [];
    const explicitSourceWorkspaces = sourced.workspaces;
    const workspaceInputs = explicitSourceWorkspaces ?? configuredWorkspaces;
    // Environment-backed configuration is an override when non-empty. An
    // empty environment value is deliberately treated as "discover" so the
    // default development server can use the SDK session index.
    const workspaces = workspaceInputs.length > 0 || explicitSourceWorkspaces !== undefined
      ? workspaceInputs.map(createWorkspace)
      : projectCatalogWorkspaces(sdkSessions);

    const configuredModels = configured.models ?? [];
    const explicitSourceModels = sourced.models;
    const modelInputs = explicitSourceModels ?? configuredModels;
    let models = modelInputs.length > 0 || explicitSourceModels !== undefined
      ? modelInputs.map(createModel)
      : [];
    if (models.length === 0 && explicitSourceModels === undefined && typeof sdkService.listSupportedModels === 'function') {
      const probeCwd = workspaces[0]?.path ?? process.cwd();
      try {
        const sdkModels = await sdkService.listSupportedModels(probeCwd) as readonly CatalogSdkModelInfo[];
        models = [...projectCatalogModels(sdkModels)];
      } catch {
        // Catalog discovery is best effort. A missing Claude login, an
        // unavailable directory, or an older SDK must not prevent the host
        // from exposing an otherwise useful session/workspace catalog.
        models = [];
      }
    }
    const configuredDefaultModelId = sourced.defaultModelId ?? configured.defaultModelId;
    const requestedDefaultModelId = configuredDefaultModelId === undefined
      ? undefined
      : parseModelId(String(configuredDefaultModelId));
    // A deferred configured default is only published when the discovered
    // catalog contains it; otherwise use the SDK's first model as the UI's
    // sensible default. Explicit catalog validation still happens in config.
    const defaultModelId = requestedDefaultModelId !== undefined
      && models.some((model) => model.id === requestedDefaultModelId)
      ? requestedDefaultModelId
      : models[0]?.id;
    const projectedSessions = projectCatalogSessions(
      sdkSessions,
      workspaces,
      options.hostEpoch,
      undefined,
      models,
      defaultModelId,
    );
    const sessions = [] as typeof projectedSessions[number][];
    const sdkSessionsById = new Map(sdkSessions.map((session) => [session.sessionId, session]));

    for (const session of projectedSessions) {
      const existingBacking = registry.getBacking(session.chatUri);
      if (existingBacking !== undefined) {
        sessions.push(withSessionConfiguration(session, existingBacking.desiredConfig, models, defaultModelId));
        continue;
      }

      // A persisted overlay may have been created under a product chat URI
      // that predates the SDK-derived URI. Reconcile by SDK session identity so
      // the durable chat remains addressable and its selected configuration is
      // not silently dropped from the root catalog.
      const backingForSdkSession = registry.listBackings().find(
        (backing) => backing.sdkSessionId === session.sdkSessionRef,
      );
      if (backingForSdkSession !== undefined) {
        const metadata = persistedChatMetadata.get(backingForSdkSession.chatUri);
        const reconciledSession = createCatalogSession({
          ...session,
          chatUri: backingForSdkSession.chatUri,
          ...(metadata?.title === undefined ? {} : { title: metadata.title }),
          ...(metadata === undefined ? {} : { archived: metadata.archived }),
        });
        sessions.push(withSessionConfiguration(reconciledSession, backingForSdkSession.desiredConfig, models, defaultModelId));
        continue;
      }

      // SDK listSessions exposes resumable Claude Code sessions, but the Host
      // protocol can only subscribe to resources registered in both the
      // registry and HostStateManager. Hydrate that bridge during catalog
      // refresh so every advertised session is actually openable.
      const sdkSession = sdkSessionsById.get(session.sdkSessionRef);
      const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId);
      if (sdkSession === undefined || workspace === undefined) {
        continue;
      }

      let restored = false;
      try {
        // SDKSessionInfo does not carry model/effort. Read the transcript and
        // retain only values that are actually observable at this boundary.
        const messages = await sdkService.getSessionMessages(sdkSession.sessionId, {
          dir: sdkSession.cwd ?? workspace.path,
          includeSystemMessages: true,
        });
        const observedConfiguration = projectSessionConfiguration(messages, models, defaultModelId);
        const restoredBacking = registry.restorePersistedBacking({
          chatUri: session.chatUri,
          sdkSessionId: session.sdkSessionRef,
          cwd: sdkSession.cwd ?? workspace.path,
          desiredConfig: {
            permissionMode: 'default',
            ...(observedConfiguration.modelId === undefined ? {} : { model: observedConfiguration.modelId }),
            ...(observedConfiguration.effort === undefined ? {} : { effort: observedConfiguration.effort }),
          },
          lifecycle: 'materialized',
        });
        restored = true;
        hostStateManager.registerChat(session.chatUri);
        hydrateClaudeHistory(hostStateManager, session.chatUri, messages, options.nowAction());
        sessions.push(withSessionConfiguration(session, restoredBacking.desiredConfig, models, defaultModelId));
      } catch {
        hostStateManager.unregisterChat(session.chatUri);
        if (restored) {
          await registry.disposeChat(session.chatUri).catch(() => undefined);
        }
      }
    }

    const timestamp = options.nowAction();
    if (timestamp.length === 0) {
      throw new TypeError('catalog action timestamp must be non-empty');
    }
    hostStateManager.dispatchCatalogBatch(rootCatalog.resource, [
      {
        type: CATALOG_ACTION_TYPES.workspacesReplaced,
        workspaces,
        timestamp,
      },
      {
        type: CATALOG_ACTION_TYPES.modelsReplaced,
        models,
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        timestamp,
      },
      {
        type: CATALOG_ACTION_TYPES.sessionsReplaced,
        sessions,
        timestamp,
      },
    ]);

    const state = hostStateManager.getCatalogState(rootCatalog.resource);
    if (state === undefined) {
      throw new Error('catalog resource is not registered');
    }
    return state;
  };

  const createBackingFromInput = (input: ClaudeAgentHostCreateChatInput): ChatBacking =>
    createChatBacking({
      chatUri: input.chatUri,
      sdkSessionId: input.sdkSessionId ?? createSdkSessionId(),
      cwd: input.cwd,
      ...(input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: input.additionalDirectories }),
      desiredConfig: input.desiredConfig,
    });

  const registerChatInMemory = (backing: ChatBacking): ChatBacking => {
    assertChatCanBeRegistered(backing, hostStateManager, registry);

    // Both mutators are synchronous and all duplicate/shape checks have already
    // run. Registering the backing first means a host-state duplicate cannot
    // leave a backing behind; registerChat can only fail on the prevalidated key.
    const registered = registry.createProvisional({
      chatUri: backing.chatUri,
      sdkSessionId: backing.sdkSessionId,
      cwd: backing.cwd,
      additionalDirectories: backing.additionalDirectories,
      desiredConfig: backing.desiredConfig,
    });
    try {
      hostStateManager.registerChat(registered.chatUri);
    } catch (error) {
      // This path is defensive: normal HostStateManager failures are covered by
      // the preflight above. No runtime has been started, so the synchronous
      // provisional transaction can be rolled back without touching SDK state.
      registry.discardProvisional(registered.chatUri);
      throw error;
    }
    return registered;
  };

  const createChat = (input: ClaudeAgentHostCreateChatInput): ChatBacking => {
    if (shuttingDown) {
      throw new Error('Claude Agent Host is shutting down');
    }

    return registerChatInMemory(createBackingFromInput(input));
  };

  const createChatPersisted = async (
    input: ClaudeAgentHostCreateChatInput,
  ): Promise<ChatBacking> => {
    const repository = requireOverlayRepository(overlayRepository);
    if (shuttingDown) {
      throw new Error('Claude Agent Host is shutting down');
    }

    const backing = createBackingFromInput(input);
    return enqueuePersistence(async () => {
      const existingRows = await repository.listChatBackings();
      if (shuttingDown) {
        throw new Error('Claude Agent Host is shutting down');
      }
      assertNoPersistedConflict(backing, existingRows);
      assertChatCanBeRegistered(backing, hostStateManager, registry);

      const writeInput: DomainChatBackingWriteInput = {
        backing,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      };
      // The repository's save method resolves only after its transaction has
      // committed. No host state or registry mutation occurs before this await.
      await repository.saveChatBacking(writeInput);
      if (shuttingDown) {
        // The durable row was committed while shutdown began concurrently. Do
        // not expose a new in-memory chat after shutdown has taken ownership.
        try {
          await repository.deleteChatBacking(backing.chatUri);
        } catch {
          // Leave reconciliation to the next startup if cleanup fails.
        }
        throw new Error('Claude Agent Host is shutting down');
      }
      persistedChatUris.add(backing.chatUri);
      persistedChatMetadata.set(backing.chatUri, {
        ...(input.title === undefined ? {} : { title: input.title }),
        archived: input.archived ?? false,
      });
      try {
        return registerChatInMemory(backing);
      } catch (error) {
        persistedChatUris.delete(backing.chatUri);
        persistedChatMetadata.delete(backing.chatUri);
        // Compensate a post-commit in-memory failure when possible. The original
        // registration error remains authoritative for the caller.
        try {
          await repository.deleteChatBacking(backing.chatUri);
        } catch {
          // The durable row is left for a later reconciliation pass if cleanup
          // itself fails; importantly, no in-memory backing is exposed.
        }
        throw error;
      }
    });
  };

  const loadPersistedChats = async (): Promise<readonly ChatBacking[]> => {
    const repository = requireOverlayRepository(overlayRepository);
    if (shuttingDown) {
      throw new Error('Claude Agent Host is shutting down');
    }

    return enqueuePersistence(async () => {
      const rows = await repository.listChatBackings();
      if (shuttingDown) {
        throw new Error('Claude Agent Host is shutting down');
      }
      const candidates = rows.map(toRestoredChatBacking);
      assertNoDuplicatePersistedBackings(candidates);
      for (const candidate of candidates) {
        assertChatCanBeRegistered(candidate, hostStateManager, registry);
      }

      const restored: ChatBacking[] = [];
      const registered: ChatBacking[] = [];
      try {
        for (const row of rows) {
          const input = toRestoredBackingInput(row);
          const backing = registry.restorePersistedBacking(input);
          registered.push(backing);
          hostStateManager.registerChat(backing.chatUri);
          restored.push(backing);
          persistedChatUris.add(backing.chatUri);
          persistedChatMetadata.set(backing.chatUri, {
            ...(row.title === undefined ? {} : { title: row.title }),
            archived: row.archived,
          });
        }
      } catch (error) {
        for (const backing of registered.reverse()) {
          try {
            await registry.disposeChat(backing.chatUri);
          } catch {
            // Continue removing other restored entries while preserving the
            // original registration error.
          }
          hostStateManager.unregisterChat(backing.chatUri);
          persistedChatUris.delete(backing.chatUri);
          persistedChatMetadata.delete(backing.chatUri);
        }
        throw error;
      }
      return Object.freeze(restored);
    });
  };

  const disposeChatPersisted = async (chatUri: ChatUri): Promise<boolean> => {
    const repository = requireOverlayRepository(overlayRepository);
    if (shuttingDown) {
      throw new Error('Claude Agent Host is shutting down');
    }
    const parsedChatUri = parseChatUri(chatUri);
    const deleted = await enqueuePersistence(() => repository.deleteChatBacking(parsedChatUri));
    if (!deleted) {
      return false;
    }
    // Memory disposal starts only after the repository's delete transaction has
    // committed. This ordering prevents an in-memory disappearance on failure.
    persistedChatUris.delete(parsedChatUri);
    persistedChatMetadata.delete(parsedChatUri);
    try {
      await registry.disposeChat(parsedChatUri);
    } finally {
      hostStateManager.unregisterChat(parsedChatUri);
    }
    return true;
  };

  const loadHistory = async (
    chatUri: ChatUri,
    actionTimestamp?: string,
  ): Promise<ChatActionEnvelope | undefined> => {
    assertHostAcceptsHistory(shuttingDown);
    const backing = registry.getBacking(chatUri);
    if (backing === undefined) {
      throw new Error('chat backing was not found');
    }

    const messages = await sdkService.getSessionMessages(backing.sdkSessionId, {
      dir: backing.cwd,
      includeSystemMessages: true,
    });
    assertHostAcceptsHistory(shuttingDown);
    const timestamp = actionTimestamp ?? options.nowAction();
    return hydrateClaudeHistory(hostStateManager, backing.chatUri, messages, timestamp);
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    shuttingDown = true;
    interactionRegistry.dispose();
    shutdownPromise = performShutdown(
      server,
      registry,
      () => {
        if (protocolDisposed) {
          return;
        }
        protocolDisposed = true;
        protocolServerHandler.dispose();
      },
      async () => {
        await persistenceTail;
        await closeOverlayRepository(overlayRepository, options.closeOverlayRepository);
      },
    );
    return shutdownPromise;
  };

  return {
    server,
    hostStateManager,
    registry,
    chatRegistry: registry,
    interactionRegistry,
    sdkService,
    ...(overlayRepository === undefined ? {} : { overlayRepository }),
    createChat,
    createChatPersisted,
    loadPersistedChats,
    disposeChatPersisted,
    loadHistory,
    refreshCatalog,
    shutdown,
  };
}

function createRuntimeFactory(input: {
  readonly sdkService: InternalClaudeAgentHostSdkService;
  readonly createSdkUuid: () => UUID;
  readonly canUseTool: CanUseTool;
  readonly options: ClaudeAgentHostOptions;
}): ClaudeChatRuntimeFactory {
  const override = input.options.runtimeFactory;
  if (override !== undefined) {
    return (runtimeInput: ClaudeChatRuntimeFactoryInput): Promise<ClaudeChatRuntime> => {
      const publicInput: ClaudeAgentHostRuntimeFactoryInput = {
        backing: runtimeInput.backing,
        generation: runtimeInput.generation,
        session: runtimeInput.session,
        onSignal: (signal: unknown) => runtimeInput.onSignal(signal as ClaudeRuntimeSignal),
      };
      return Promise.resolve(override(publicInput)).then(
        (runtime) => runtime as unknown as ClaudeChatRuntime,
      );
    };
  }

  return (runtimeInput: ClaudeChatRuntimeFactoryInput): ClaudeQueryRuntime => {
    const abortController = new AbortController();
    return new ClaudeQueryRuntime({
      generation: runtimeInput.generation,
      sdkSessionId: runtimeInput.backing.sdkSessionId,
      sdkService: input.sdkService,
      createSdkUuid: input.createSdkUuid,
      onSignal: runtimeInput.onSignal,
      buildOptions: () => buildRuntimeOptions(
        runtimeInput,
        abortController,
        runtimeInput.canUseTool ?? input.canUseTool,
        input.options,
      ),
    });
  };
}

function buildRuntimeOptions(
  runtimeInput: ClaudeChatRuntimeFactoryInput,
  abortController: AbortController,
  canUseTool: CanUseTool,
  hostOptions: ClaudeAgentHostOptions,
): Options {
  const backing = runtimeInput.backing;
  const config = backing.desiredConfig;
  return buildClaudeOptions({
    cwd: backing.cwd,
    ...(backing.additionalDirectories.length === 0
      ? {}
      : { additionalDirectories: backing.additionalDirectories }),
    abortController,
    session: runtimeInput.session.kind === 'new'
      ? { kind: 'new', sessionId: runtimeInput.session.sessionId }
      : { kind: 'resume', sessionId: runtimeInput.session.sessionId },
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    permissionMode: config.permissionMode,
    canUseTool,
    ...(hostOptions.onElicitation === undefined
      ? {}
      : { onElicitation: hostOptions.onElicitation }),
    ...(hostOptions.mcpServers === undefined ? {} : { mcpServers: hostOptions.mcpServers }),
    ...(hostOptions.plugins === undefined ? {} : { plugins: hostOptions.plugins }),
    ...(hostOptions.hooks === undefined ? {} : { hooks: hostOptions.hooks }),
    ...(hostOptions.allowedTools === undefined
      ? {}
      : { allowedTools: hostOptions.allowedTools }),
    ...(hostOptions.disallowedTools === undefined
      ? {}
      : { disallowedTools: hostOptions.disallowedTools }),
    ...(hostOptions.agent === undefined ? {} : { agent: hostOptions.agent }),
    ...(hostOptions.env === undefined ? {} : { env: hostOptions.env }),
    ...(hostOptions.settings === undefined ? {} : { settings: hostOptions.settings }),
    ...(hostOptions.stderr === undefined ? {} : { stderr: hostOptions.stderr }),
  });
}

function createInteractionResolver(registry: PendingInteractionRegistry): ChatInteractionResolver {
  return {
    resolveApproval: (input): ChatInteractionResolutionResult => mapRegistryResolution(
      registry.resolveApproval({
        chatUri: input.chatUri,
        approvalId: input.approvalId,
        decision: input.decision,
        ...(input.updatedInput === undefined ? {} : { updatedInput: { ...input.updatedInput } }),
        ...(input.updatedPermissions === undefined
          ? {}
          : {
              updatedPermissions: input.updatedPermissions as unknown as PermissionUpdate[],
            }),
        ...(input.decisionClassification === undefined
          ? {}
          : { decisionClassification: input.decisionClassification }),
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
      }),
    ),
    resolveInput: (input): ChatInteractionResolutionResult => mapRegistryResolution(
      registry.resolveInput({
        chatUri: input.chatUri,
        inputId: input.inputId,
        ...(input.answers === undefined ? {} : { answers: { ...input.answers } }),
      }),
    ),
  };
}

function mapRegistryResolution(
  result: import('../interaction/pendingInteractionRegistry.js').ResolveResult,
): ChatInteractionResolutionResult {
  if (result.status === 'resolved' || result.status === 'already_resolved') {
    return { status: result.status, kind: result.kind, id: result.id };
  }
  return result;
}

function createHostCanUseTool(
  chatUri: ChatUri,
  getTurnId: () => TurnId | undefined,
  registry: PendingInteractionRegistry,
  clients: LogicalClientRegistry,
): CanUseTool {
  const bridged = registry.createCanUseTool(() => {
    const turnId = getTurnId();
    if (turnId === undefined) {
      throw new Error('no active turn is available for the permission request');
    }
    return { chat: chatUri, turnId };
  });

  return async (...args): Promise<PermissionResult> => {
    // A callback can fire while the SDK is starting before any UI has joined.
    // Fail closed in that case; once a subscribed client exists, park the
    // official SDK waiter in the host-owned interaction registry.
    if (!hasSubscribedChat(clients, chatUri) || getTurnId() === undefined) {
      return defaultCanUseTool(...args);
    }
    const result = await bridged(...args);
    return result ?? defaultCanUseTool(...args);
  };
}

function hasSubscribedChat(
  clients: LogicalClientRegistry,
  chatUri: ChatUri,
): boolean {
  return clients.snapshots().some((client) => (
    client.activeConnectionId !== undefined && client.subscriptions.includes(chatUri)
  ));
}

function dispatchInteractionAction(
  hostStateManager: HostStateManager,
  chat: string,
  action: InteractionAction,
): void {
  const channel = parseChatUri(chat);
  switch (action.type) {
    case 'chat/approvalRequested': {
      const domainAction: ApprovalRequestedAction = {
        type: 'chat/approvalRequested',
        turnId: parseTurnId(action.turnId),
        approvalId: parseApprovalId(action.approvalId),
        ...(action.toolCallId === undefined ? {} : { toolCallId: parseToolCallId(action.toolCallId) }),
        toolName: action.toolName,
        input: action.input as ApprovalInput,
        ...(action.title === undefined ? {} : { title: action.title }),
        ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
        ...(action.description === undefined ? {} : { description: action.description }),
        ...(action.suggestions === undefined ? {} : { suggestions: toDomainSuggestions(action.suggestions) }),
        ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
        ...(action.toolUseId === undefined ? {} : { toolUseId: action.toolUseId }),
        ...(action.toolUseID === undefined ? {} : { toolUseID: action.toolUseID }),
        ...(action.agentId === undefined ? {} : { agentId: action.agentId }),
        ...(action.agentID === undefined ? {} : { agentID: action.agentID }),
        ...(action.blockedPath === undefined ? {} : { blockedPath: action.blockedPath }),
        ...(action.decisionReason === undefined ? {} : { decisionReason: action.decisionReason }),
        ...(action.matchedAskRule === undefined
          ? {}
          : { matchedAskRule: { ...action.matchedAskRule } }),
        ...(action.requestedAt === undefined ? {} : { requestedAt: action.requestedAt }),
        timestamp: action.timestamp,
      };
      hostStateManager.dispatch(channel, domainAction);
      return;
    }
    case 'chat/approvalResolved': {
      const domainAction: ApprovalResolvedAction = {
        type: 'chat/approvalResolved',
        turnId: parseTurnId(action.turnId),
        approvalId: parseApprovalId(action.approvalId),
        decision: action.decision,
        ...(action.updatedInput === undefined ? {} : { updatedInput: action.updatedInput as ApprovalInput }),
        ...(action.updatedPermissions === undefined
          ? {}
          : { updatedPermissions: toDomainSuggestions(action.updatedPermissions) }),
        ...(action.message === undefined ? {} : { message: action.message }),
        ...(action.interrupt === undefined ? {} : { interrupt: action.interrupt }),
        ...(action.decisionClassification === undefined
          ? {}
          : { decisionClassification: action.decisionClassification }),
        timestamp: action.timestamp,
      };
      hostStateManager.dispatch(channel, domainAction);
      return;
    }
    case 'chat/inputRequested': {
      const domainAction: InputRequestedAction = {
        type: 'chat/inputRequested',
        turnId: parseTurnId(action.turnId),
        inputId: parseInputRequestId(action.inputId),
        questions: action.questions.map(toDomainInputQuestion),
        timestamp: action.timestamp,
      };
      hostStateManager.dispatch(channel, domainAction);
      return;
    }
    case 'chat/inputResolved': {
      const domainAction: InputResolvedAction = {
        type: 'chat/inputResolved',
        turnId: parseTurnId(action.turnId),
        inputId: parseInputRequestId(action.inputId),
        answers: action.answers as InputAnswers,
        timestamp: action.timestamp,
      };
      hostStateManager.dispatch(channel, domainAction);
      return;
    }
    default:
      assertNeverInteractionAction(action);
  }
}

function toDomainInputQuestion(question: {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly preview?: string;
  }[];
}): InputQuestion {
  return {
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => option.preview === undefined
      ? { label: option.label, description: option.description }
      : { label: option.label, description: option.description, preview: option.preview }),
  };
}

function toDomainSuggestions(
  suggestions: readonly PermissionUpdate[],
): readonly ApprovalSuggestion[] {
  return Object.freeze(suggestions.map((suggestion) => toDomainJsonObject(suggestion)));
}

function toDomainJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('permission suggestion must be a JSON object');
  }
  const result: Record<string, import('../domain/chat.js').JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = toDomainJsonValue(child);
  }
  return result;
}

function toDomainJsonValue(value: unknown): import('../domain/chat.js').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('permission suggestion must contain finite numbers');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => toDomainJsonValue(child));
  }
  if (typeof value !== 'object') {
    throw new TypeError('permission suggestion must be JSON-safe');
  }
  const result: Record<string, import('../domain/chat.js').JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = toDomainJsonValue(child);
  }
  return result;
}

function assertNeverInteractionAction(action: never): never {
  throw new TypeError(`unknown interaction action: ${String(action)}`);
}

function withSessionConfiguration(
  session: CatalogSession,
  configuration: ClaudeRuntimeConfig | CatalogSessionConfiguration,
  models: readonly CatalogModel[],
  defaultModelId?: CatalogModel['id'],
): CatalogSession {
  const model = 'model' in configuration
    ? configuration.model
    : (configuration as CatalogSessionConfiguration).modelId;
  const normalized = normalizeCatalogSessionConfiguration(
    { modelId: model, effort: configuration.effort },
    models,
    defaultModelId,
  );
  return createCatalogSession({
    ...withoutSessionConfiguration(session),
    ...normalized,
    ...('permissionMode' in configuration ? { permissionMode: configuration.permissionMode } : {}),
  });
}

function withoutSessionConfiguration(session: CatalogSession): Omit<CatalogSession, 'modelId' | 'effort'> {
  const { modelId: _modelId, effort: _effort, ...withoutConfiguration } = session;
  return withoutConfiguration;
}

function assertChatCanBeRegistered(
  backing: ChatBacking,
  hostStateManager: HostStateManager,
  registry: ClaudeChatRegistry,
): void {
  if (hostStateManager.getState(backing.chatUri) !== undefined) {
    throw new Error('chat resource is already registered');
  }
  if (registry.getBacking(backing.chatUri) !== undefined) {
    throw new Error('chat URI is already registered');
  }
  if (registry.listBackings().some((existing) => existing.sdkSessionId === backing.sdkSessionId)) {
    throw new Error('sdkSessionId is already registered');
  }
}

type RestoredBackingInput = CreateChatBackingInput & {
  readonly lifecycle: ChatBacking['lifecycle'];
};

function toRestoredBackingInput(row: PersistedChatBacking): RestoredBackingInput {
  const desiredConfig: ClaudeRuntimeConfig = {
    permissionMode: parsePermissionMode(row.permissionMode),
    ...(row.model === undefined ? {} : { model: row.model }),
    ...(row.effort === undefined ? {} : { effort: parseEffortLevel(row.effort) }),
  };
  return {
    chatUri: parseChatUri(row.chatUri),
    sdkSessionId: row.sdkSessionId,
    cwd: row.cwd,
    additionalDirectories: row.additionalDirectories,
    desiredConfig,
    lifecycle: row.lifecycle,
  };
}

function parsePermissionMode(value: string): PermissionMode {
  if (
    value === 'default'
    || value === 'acceptEdits'
    || value === 'bypassPermissions'
    || value === 'plan'
    || value === 'dontAsk'
    || value === 'auto'
  ) {
    return value;
  }
  throw new TypeError(`persisted permissionMode is not supported by the Claude SDK: ${value}`);
}

function parseEffortLevel(value: string): EffortLevel {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new TypeError(`persisted effort is not supported by the Claude SDK: ${value}`);
}

function toRestoredChatBacking(row: PersistedChatBacking): ChatBacking {
  const input = toRestoredBackingInput(row);
  const provisional = createChatBacking({
    chatUri: input.chatUri,
    sdkSessionId: input.sdkSessionId,
    cwd: input.cwd,
    ...(input.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: input.additionalDirectories }),
    desiredConfig: input.desiredConfig,
  });
  return input.lifecycle === 'materialized'
    ? markChatBackingMaterialized(provisional)
    : provisional;
}

function assertNoDuplicatePersistedBackings(
  candidates: readonly ChatBacking[],
): void {
  const chatUris = new Set<ChatUri>();
  const sdkSessionIds = new Set<string>();
  for (const candidate of candidates) {
    if (chatUris.has(candidate.chatUri)) {
      throw new Error('chat resource is already persisted');
    }
    if (sdkSessionIds.has(candidate.sdkSessionId)) {
      throw new Error('sdkSessionId is already persisted');
    }
    chatUris.add(candidate.chatUri);
    sdkSessionIds.add(candidate.sdkSessionId);
  }
}

function assertNoPersistedConflict(
  backing: ChatBacking,
  rows: readonly PersistedChatBacking[],
): void {
  const sameChat = rows.find((row) => row.chatUri === backing.chatUri);
  if (sameChat !== undefined) {
    throw new Error('chat resource is already persisted');
  }
  const sameSdkSession = rows.find((row) => row.sdkSessionId === backing.sdkSessionId);
  if (sameSdkSession !== undefined) {
    throw new Error('sdkSessionId is already persisted');
  }
}

function assertOverlayRepository(repository: ClaudeAgentHostOverlayRepository): void {
  if (typeof repository !== 'object' || repository === null) {
    throw new TypeError('overlayRepository must be an object');
  }
  if (typeof repository.saveChatBacking !== 'function') {
    throw new TypeError('overlayRepository must provide saveChatBacking');
  }
  if (typeof repository.listChatBackings !== 'function') {
    throw new TypeError('overlayRepository must provide listChatBackings');
  }
  if (typeof repository.deleteChatBacking !== 'function') {
    throw new TypeError('overlayRepository must provide deleteChatBacking');
  }
  if (repository.getChatBacking !== undefined && typeof repository.getChatBacking !== 'function') {
    throw new TypeError('overlayRepository.getChatBacking must be a function when provided');
  }
  if (repository.updateChatBacking !== undefined && typeof repository.updateChatBacking !== 'function') {
    throw new TypeError('overlayRepository.updateChatBacking must be a function when provided');
  }
  if (repository.close !== undefined && typeof repository.close !== 'function') {
    throw new TypeError('overlayRepository.close must be a function when provided');
  }
}

function requireOverlayRepository(
  repository: ClaudeAgentHostOverlayRepository | undefined,
): ClaudeAgentHostOverlayRepository {
  if (repository === undefined) {
    throw new Error('overlay repository is not configured');
  }
  return repository;
}

async function closeOverlayRepository(
  repository: ClaudeAgentHostOverlayRepository | undefined,
  closeHook?: () => void | PromiseLike<void>,
): Promise<void> {
  if (closeHook !== undefined) {
    await closeHook();
    return;
  }
  await repository?.close?.();
}

function composeServerOptions(
  options: ClaudeAgentHostOptions,
  handler: ProtocolServerHandler,
): AgentHostServerOptions {
  const direct: ClaudeAgentHostServerOptions = {
    ...(options.fastifyOptions === undefined ? {} : { fastifyOptions: options.fastifyOptions }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
    ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
    ...(options.highWaterMarkBytes === undefined
      ? {}
      : { highWaterMarkBytes: options.highWaterMarkBytes }),
    ...(options.slowClientHighWaterMarkBytes === undefined
      ? {}
      : { slowClientHighWaterMarkBytes: options.slowClientHighWaterMarkBytes }),
    ...(options.connectionIdAllocator === undefined
      ? {}
      : { connectionIdAllocator: options.connectionIdAllocator }),
    ...(options.allocateConnectionId === undefined
      ? {}
      : { allocateConnectionId: options.allocateConnectionId }),
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
  };

  return {
    ...(options.server ?? {}),
    ...(options.serverOptions ?? {}),
    ...direct,
    handler,
    // The host owns disposal ordering. A caller cannot replace this handler or
    // make the transport dispose it before the registry has drained runtimes.
    disposeHandlerOnClose: false,
  };
}

async function performShutdown(
  server: FastifyInstance,
  registry: ClaudeChatRegistry,
  disposeHandler: () => void,
  closePersistence: () => void | PromiseLike<void>,
): Promise<void> {
  let firstError: unknown;
  const sockets = [...server.websocketServer.clients];
  try {
    await server.close();
    await waitForSocketClose(sockets);
  } catch (error) {
    firstError = error;
  }

  try {
    disposeHandler();
  } catch (error) {
    firstError ??= error;
  }

  try {
    await registry.shutdown();
  } catch (error) {
    firstError ??= error;
  }

  try {
    await closePersistence();
  } catch (error) {
    firstError ??= error;
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

async function waitForSocketClose(
  sockets: readonly { readonly readyState: number; once(event: string, listener: () => void): unknown }[],
): Promise<void> {
  await Promise.all(sockets.map((socket) => {
    if (socket.readyState === 3) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      socket.once('close', resolve);
    });
  }));
}

function assertHostOptions(options: ClaudeAgentHostOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('options must be an object');
  }
  if (typeof options.nowServer !== 'function') {
    throw new TypeError('nowServer must be provided');
  }
  if (typeof options.nowAction !== 'function') {
    throw new TypeError('nowAction must be provided');
  }
  if (options.sdkService !== undefined && (
    typeof options.sdkService.startup !== 'function'
    || typeof options.sdkService.getSessionMessages !== 'function'
  )) {
    throw new TypeError('sdkService must provide startup and getSessionMessages');
  }
  if (options.createSdkSessionId !== undefined && typeof options.createSdkSessionId !== 'function') {
    throw new TypeError('createSdkSessionId must be a function when provided');
  }
  if (options.createChatId !== undefined && typeof options.createChatId !== 'function') {
    throw new TypeError('createChatId must be a function when provided');
  }
  if (options.createSdkUuid !== undefined && typeof options.createSdkUuid !== 'function') {
    throw new TypeError('createSdkUuid must be a function when provided');
  }
  if (options.canUseTool !== undefined && typeof options.canUseTool !== 'function') {
    throw new TypeError('canUseTool must be a function when provided');
  }
  if (options.runtimeFactory !== undefined && typeof options.runtimeFactory !== 'function') {
    throw new TypeError('runtimeFactory must be a function when provided');
  }
  if (options.workspaceFilesystem !== undefined && (
    typeof options.workspaceFilesystem.realpath !== 'function'
    || typeof options.workspaceFilesystem.stat !== 'function'
  )) {
    throw new TypeError('workspaceFilesystem must provide realpath and stat');
  }
  if (options.overlayRepository !== undefined) {
    assertOverlayRepository(options.overlayRepository);
  }
  if (options.persistence !== undefined) {
    assertOverlayRepository(options.persistence);
  }
  if (
    options.closeOverlayRepository !== undefined
    && typeof options.closeOverlayRepository !== 'function'
  ) {
    throw new TypeError('closeOverlayRepository must be a function when provided');
  }
}

function assertHostAcceptsHistory(shuttingDown: boolean): void {
  if (shuttingDown) {
    throw new Error('Claude Agent Host is shutting down');
  }
}

const defaultCanUseTool = async (..._args: Parameters<CanUseTool>): Promise<PermissionResult> => ({
  behavior: 'deny',
  message: DEFAULT_PERMISSION_MESSAGE,
});
