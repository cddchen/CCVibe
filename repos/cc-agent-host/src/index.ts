export * from './domain/actions.js';
export * from './domain/chat.js';
export {
  chatReducer,
  createChatState,
  reduceChatActions,
} from './domain/chatReducer.js';
export * from './domain/ids.js';
export * from './domain/resources.js';
export * from './catalog/types.js';
export * from './catalog/reducer.js';
export * from './security/identity.js';
export * from './security/acl.js';
export * from './security/auth.js';
export * from './security/redaction.js';
export {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_ERRORS,
  JSON_RPC_VERSION,
  MAX_JSON_FRAME_BYTES,
  errorResponse,
  isJsonRpcFailure,
  notification,
  parseJsonRpcMessage,
  parseJsonRpcNotification,
  parseJsonRpcRequest,
  successResponse,
} from './protocol/jsonRpc.js';
export type {
  JsonRpcError,
  JsonRpcErrorCode,
  JsonRpcErrorDescriptor,
  JsonRpcErrorName,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
  ParsedJsonRpcNotification,
  ParsedJsonRpcRequest,
} from './protocol/jsonRpc.js';
export type {
  ClientAction,
  CatalogCreateChatParams,
  CatalogCreateChatResult,
  DispatchActionParams,
  DispatchActionResult,
  InitializeParams,
  InitializeResult,
  ReconnectParams,
  SafeValidationIssue,
  SubscribeParams,
  SubscribeResult,
  UnsubscribeParams,
  UnsubscribeResult,
  ResolveApprovalParams,
  ResolveInputParams,
  InteractionResolutionResult,
} from './protocol/schemas.js';
export {
  approvalIdSchema,
  catalogCreateChatParamsSchema,
  catalogCreateChatSchema,
  createChatParamsSchema,
  inputRequestIdSchema,
  resolveApprovalParamsSchema,
  resolveApprovalSchema,
  resolveInputParamsSchema,
  resolveInputSchema,
} from './protocol/schemas.js';
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
  MAX_URI_SEGMENT_BYTES,
  PROTOCOL_VERSION,
} from './protocol/limits.js';
export {
  createSubscriptionBuffer,
  SubscriptionBuffer,
} from './protocol/subscriptionBuffer.js';
export type {
  SubscriptionBarrier,
  SubscriptionReceiveResult,
  SubscriptionToken,
} from './protocol/subscriptionBuffer.js';
export type {
  ActionEnvelope,
  ActionOrigin,
  ChatActionEnvelope,
  ChatReconnectResult,
  ChatStateSnapshot,
  DeepReadonly,
  ReconnectResult,
  ReconnectResultCut,
  ReplayReconnectResult,
  SnapshotReconnectResult,
  StateSnapshot,
} from './protocol/types.js';
export {
  canReplayFrom,
  ReplayBuffer,
  selectReplayActions,
} from './protocol/replayBuffer.js';
export type { ReplayBufferOptions } from './protocol/replayBuffer.js';
export { HostStateManager } from './host/hostStateManager.js';
export type {
  EnvelopeListener,
  HostAction,
  HostActionEnvelope,
  HostEnvelopeListener,
  HostReconnectResult,
  HostState,
  HostStateManagerDeps,
  HostStateSnapshot,
  ListenerErrorReporter,
} from './host/hostStateManager.js';
export { LogicalClientRegistry } from './host/logicalClientRegistry.js';
export type {
  ClientCapabilities,
  LogicalClient,
  LogicalClientRegistration,
  LogicalClientRegistrationOptions,
  LogicalClientRegistrationResult,
  LogicalClientRegistryOptions,
  LogicalClientSnapshot,
} from './host/logicalClientRegistry.js';
export {
  ChatHostStateProvider,
  CatalogHostStateProvider,
  HostStateProvider,
  RootCatalogStateProvider,
} from './protocol/stateProvider.js';
export type {
  ChatHostStateProviderOptions,
  Disposable,
  HostStateProviderOptions,
  ProtocolStateProvider,
  SnapshotBatch,
} from './protocol/stateProvider.js';
export type {
  ChatCommandAcceptedValue,
  ChatCommandActor,
  ChatCommandActorAcceptedValue,
  ChatCommandActorReceipt,
  ChatCommandReceipt,
  ChatCommandRejectionCode,
  CatalogChatCreator,
  CatalogChatCreateEffect,
  CatalogCreateChatInput,
  CatalogCreateChatReceipt,
  CatalogCreateChatValue,
  ChatApprovalResolutionInput,
  ChatInputResolutionInput,
  ChatInteractionResolutionState,
  ChatInteractionResolutionValue,
  ChatInteractionResolutionReceipt,
  ChatInteractionResolutionResult,
  ChatInteractionResolver,
} from './chat/chatCommandActor.js';
export { ClaudeChatActor, ClaudeChatActorError, mapClaudeChatActorRejection } from './chat/claudeChatActor.js';
export type {
  ClaudeChatActorAcceptedValue,
  ClaudeChatActorDeps,
  ClaudeChatInteractionResolutionReceipt,
  ClaudeChatInteractionResolutionValue,
  ClaudeChatActorReceipt,
  ClaudeChatActorRegistry,
  ClaudeChatActorRejectionCode,
} from './chat/claudeChatActor.js';
export { FakeChatActor, FakeChatActorError, mapFakeChatActorRejection } from './chat/fakeChatActor.js';
export type {
  ClientAction as FakeChatClientAction,
  FakeChatActorAcceptedValue,
  FakeChatActorDeps,
  FakeChatActorReceipt,
  FakeChatActorRejectionCode,
} from './chat/fakeChatActor.js';
export { ProtocolServerHandler } from './protocol/protocolServerHandler.js';
export type {
  ProtocolAnonymousContext,
  ProtocolAuthenticatedContext,
  ProtocolAuthenticationContext,
  ProtocolConnection,
  ProtocolAuthorizationOptions,
  ProtocolPrincipalResolver,
  ProtocolServerHandlerOptions,
  ReconnectRpcResult,
} from './protocol/protocolServerHandler.js';
export { SequencerByKey } from './chat/sequencer.js';
export type { SequencerTask } from './chat/sequencer.js';
export { CommandDeduper } from './chat/commandDeduper.js';
export type {
  AcceptedCommandReceipt,
  CommandDeduperOptions,
  CommandEffect,
  CommandKey,
  CommandReceipt,
  CommandRejection,
  CommandRejectionMapper,
  CommandRejectionResult,
  RejectedCommandReceipt,
} from './chat/commandDeduper.js';
export {
  PendingInteractionRegistry,
  createCanUseToolAdapter,
} from './interaction/pendingInteractionRegistry.js';
export type {
  ApprovalDecisionInput,
  ApprovalRequestedAction as InteractionApprovalRequestedAction,
  ApprovalResolvedAction as InteractionApprovalResolvedAction,
  AskUserQuestion,
  AskUserQuestionInput,
  CanUseToolContext,
  CanUseToolContextResolver,
  CanUseToolOptions,
  CanUseToolParameters,
  InputAnswers as InteractionInputAnswers,
  InputRequestedAction as InteractionInputRequestedAction,
  InputResolvedAction as InteractionInputResolvedAction,
  InteractionAction,
  InteractionActionDispatcher,
  InteractionChat,
  InteractionId,
  InteractionKind,
  InteractionTimer,
  InteractionTurn,
  PendingApprovalSnapshot,
  PendingInputSnapshot,
  PendingInteractionRegistryOptions,
  PendingInteractionSnapshot,
  RequestApprovalInput,
  RequestInputInput,
  ResolveApprovalInput,
  ResolveInputInput,
  ResolveResult,
} from './interaction/pendingInteractionRegistry.js';
export {
  createAgentHostServer,
  createWebSocketProtocolConnection,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_HIGH_WATER_MARK_BYTES,
  DEFAULT_SLOW_CLIENT_HIGH_WATER_MARK_BYTES,
  HEARTBEAT_TIMEOUT_CLOSE_CODE,
  MESSAGE_TOO_LARGE_CLOSE_CODE,
  MESSAGE_TOO_LARGE_CLOSE_REASON,
  SERVER_SHUTDOWN_CLOSE_CODE,
  SLOW_CLIENT_CLOSE_CODE,
  UNSUPPORTED_DATA_CLOSE_CODE,
} from './transport/fastifyServer.js';
export type {
  AgentHostProtocolHandler,
  AgentHostServerOptions,
  CreateAgentHostServerOptions,
  AgentHostTimer,
  ConnectionIdAllocator,
  WebSocketProtocolConnectionOptions,
  WebSocketTransportSocket,
} from './transport/fastifyServer.js';
export {
  ConfigurationError,
  formatHostPort,
  loadAgentHostConfig,
  parseAgentHostConfig,
  safeConfigSummary,
} from './server/config.js';
export type {
  AgentHostConfigParseOptions,
  AgentHostEnvironment,
  AgentHostServerConfig,
} from './server/config.js';
export {
  createStaticBearerTokenVerifier,
  installGracefulShutdown,
  main as runAgentHostCliMain,
  runAgentHostCli,
  startAgentHostFromConfig,
} from './server/start.js';
export type {
  AgentHostListenAddress,
  AgentHostLifecycle,
  AgentHostStartupDependencies,
  RunningAgentHost,
  SignalProcessLike,
  StartedAgentHost,
} from './server/start.js';
export { ClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';
export type { ClaudeAgentSdkServiceOptions } from './claude/claudeAgentSdkService.js';
export { projectCatalogSessions } from './claude/catalogSource.js';
export type {
  CatalogListSessionInfo,
  CatalogListSessionsParameters,
  CatalogListSessionsResult,
  CatalogSource,
  CatalogSourceSnapshot,
} from './claude/catalogSource.js';
export { buildClaudeOptions } from './claude/options.js';
export type {
  BuildClaudeOptionsInput,
  ClaudeSession,
  ClaudeSessionResume,
  ClaudeSessionStart,
} from './claude/options.js';
export {
  applyClaudeEffort,
  applyClaudeModel,
  applyClaudePermissionMode,
  applyClaudeRuntimeConfig,
} from './claude/runtimeConfig.js';
export type {
  ClaudeRuntimeConfig,
  ClaudeRuntimeQuery,
} from './claude/runtimeConfig.js';
export { AsyncInputQueue } from './claude/asyncInputQueue.js';
export type {
  ClaudeRuntimeState,
  ClaudeTurnHandle,
  ClaudeTurnOutcome,
} from './claude/runtimeTypes.js';
export {
  createChatBacking,
  markChatBackingMaterialized,
  updateChatBackingConfig,
} from './claude/chatBacking.js';
export type {
  ChatBacking,
  ChatBackingLifecycle,
  CreateChatBackingInput,
} from './claude/chatBacking.js';
export { ClaudeChatRegistry } from './claude/claudeChatRegistry.js';
export type { ClaudeChatRegistrySnapshot } from './claude/claudeChatRegistry.js';
export { ClaudeRuntimeActionBridge } from './claude/runtimeActionBridge.js';
export type {
  ClaudeLiveMapperDiagnostic,
  ClaudeLiveMapperFactory,
  ClaudeLiveMapperLike,
  ClaudeRuntimeActionBridgeDiagnostic,
  ClaudeRuntimeActionBridgeOptions,
} from './claude/runtimeActionBridge.js';
export {
  createClaudeAgentHost,
} from './claude/createClaudeAgentHost.js';
export type {
  ClaudeAgentHost,
  ClaudeAgentHostChatRegistry,
  ClaudeAgentHostCreateChatInput,
  ClaudeAgentHostOptions,
  ClaudeAgentHostOverlayRepository,
  ClaudeAgentHostRuntime,
  ClaudeAgentHostRuntimeFactory,
  ClaudeAgentHostRuntimeFactoryInput,
  ClaudeAgentHostRuntimeSession,
  ClaudeAgentHostSdkService,
  ClaudeAgentHostServerOptions,
} from './claude/createClaudeAgentHost.js';

export {
  OverlayRepository,
  OverlayConflictError,
  OverlayValidationError,
  decodeApprovalAuditEntryRow,
  decodeApprovalAuditRow,
  decodeChatBackingRow,
  decodeChatOverlayRow,
  decodeCommandReceiptRow,
  decodeReceiptRow,
  encodeApprovalAuditEntryRow,
  encodeApprovalAuditRow,
  encodeChatBackingRow,
  encodeChatOverlayRow,
  encodeCommandReceiptRow,
  encodeReceiptRow,
  toPersistedChatBacking,
} from './persistence/overlayRepository.js';
export type {
  ApprovalAuditFilter,
  ChatBackingWriteInput,
  DomainChatBackingWriteInput,
  JsonCommandReceipt,
  SaveChatBackingInput,
} from './persistence/overlayRepository.js';
export type {
  ApprovalAuditEntry,
  ApprovalAuditRow,
  ApprovalAuditStatus,
  ChatBackingRow,
  PersistedChatBacking,
  PersistedCommandReceipt,
} from './persistence/types.js';
export {
  PersistenceStore,
  OverlayPersistenceStore,
  SqlitePersistenceStore,
  createPersistenceStore,
  createSqlitePersistenceStore,
  openPersistenceStore,
  openSqlitePersistenceStore,
} from './persistence/store.js';
export type {
  CreatePersistenceStoreOptions,
  PersistenceMigrationOptions,
  PersistenceStoreTransaction,
} from './persistence/store.js';
export {
  applyMigrations,
  createSqlitePort,
  decodeApprovalAudit,
  decodeApprovalAuditRow as decodePersistenceApprovalAuditRow,
  decodeChatBacking,
  decodeChatBackingRow as decodePersistenceChatBackingRow,
  decodeCommandReceipt,
  decodeCommandReceiptRow as decodePersistenceCommandReceiptRow,
  encodeApprovalAudit,
  encodeChatBacking,
  encodeCommandReceipt,
  migrate,
  migratePersistenceSchema,
  pendingMigrations,
  selectMigrations,
} from './persistence/schema.js';
export type { AppliedMigrationVersionInput } from './persistence/schema.js';
export type {
  ApprovalAuditEntry as PersistenceApprovalAuditEntry,
  ApprovalAuditRow as PersistenceApprovalAuditRow,
  ChatBackingRow as PersistenceChatBackingRow,
  CommandReceiptPayload,
  CommandReceiptRow as PersistenceCommandReceiptRow,
  JsonObject as PersistenceJsonObject,
  JsonValue as PersistenceJsonValue,
  PersistenceErrorDetails,
  PersistenceMigration,
  SchemaMigrationRow,
  SqliteDatabaseLike,
  SqliteParameters,
  SqlitePort,
  SqliteRunResult,
  SqliteStatementLike,
  SqliteStoragePort,
  SqliteValue,
} from './persistence/types.js';
