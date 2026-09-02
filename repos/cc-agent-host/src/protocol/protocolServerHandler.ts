import type { HostAction, HostState } from '../host/hostStateManager.js';
import {
  parseConnectionId,
  type ClientId,
  type ConnectionId,
} from '../domain/ids.js';
import type { AgentResource } from '../domain/resources.js';
import type {
  ChatCommandActor,
  ChatCommandReceipt,
  CatalogCreateChatReceipt,
} from '../chat/chatCommandActor.js';
import type { CatalogWorkspace } from '../catalog/types.js';
import {
  WORKSPACE_RESOLVE_ERROR_CODES,
  WorkspaceResolverError,
} from '../catalog/workspaceResolver.js';
import {
  authorizeResource,
  type AccessControlList,
  type AuthorizationAction,
  type ResourceAcl,
} from '../security/acl.js';
import {
  createPrincipal,
  type Principal,
} from '../security/identity.js';
import {
  LogicalClientRegistry,
  type ClientCapabilities,
} from '../host/logicalClientRegistry.js';
import {
  errorResponse,
  isJsonRpcFailure,
  JSON_RPC_ERRORS,
  notification,
  parseJsonRpcMessage,
  successResponse,
  type JsonRpcErrorDescriptor,
  type JsonRpcId,
  type JsonRpcRequest,
} from './jsonRpc.js';
import {
  MAX_HOST_EPOCH_BYTES,
  MAX_PROTOCOL_VERSION_BYTES,
  MAX_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  utf8ByteLength,
} from './limits.js';
import {
  dispatchActionParamsSchema,
  catalogCreateChatParamsSchema,
  configureChatParamsSchema,
  initializeParamsSchema,
  reconnectParamsSchema,
  resolveApprovalParamsSchema,
  resolveInputParamsSchema,
  resolveWorkspaceParamsSchema,
  subscribeParamsSchema,
  supportedCommandsParamsSchema,
  toSafeValidationIssues,
  unsubscribeParamsSchema,
  type DispatchActionParams,
  type CatalogCreateChatParams,
  type ConfigureChatParams,
  type InitializeParams,
  type InitializeResult,
  type ReconnectParams,
  type ResolveApprovalParams,
  type ResolveInputParams,
  type ResolveWorkspaceParams,
  type SubscribeParams,
  type SupportedCommandsParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
} from './schemas.js';
import {
  SubscriptionBuffer,
  type SubscriptionToken,
} from './subscriptionBuffer.js';
import type {
  ActionEnvelope,
  ReconnectResult,
  StateSnapshot,
} from './types.js';
import type { ProtocolStateProvider } from './stateProvider.js';

/** Transport-neutral authentication context attached after verification. */
export interface ProtocolAuthenticatedContext<TPrincipal = unknown> {
  readonly authenticated: true;
  readonly principal: TPrincipal;
  readonly scheme: 'Bearer';
}

export interface ProtocolAnonymousContext {
  readonly authenticated: false;
  readonly scheme: 'Anonymous';
}

export type ProtocolAuthenticationContext<TPrincipal = unknown> =
  | ProtocolAuthenticatedContext<TPrincipal>
  | ProtocolAnonymousContext;

/** The only transport contract required by the protocol handler. */
export interface ProtocolConnection<TPrincipal = unknown> {
  readonly id: ConnectionId;
  /**
   * Optional authentication values attached by a transport adapter. The
   * protocol only reads the already-verified principal and never extracts
   * credentials or knows about a concrete transport implementation.
   */
  readonly principal?: TPrincipal;
  readonly authentication?: ProtocolAuthenticationContext<TPrincipal>;
  readonly auth?: ProtocolAuthenticationContext<TPrincipal>;
  send(text: string): void | Promise<void>;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

/** Resolve an already-authenticated identity without coupling protocol to WSS/HTTP. */
export type ProtocolPrincipalResolver = (
  connection: ProtocolConnection<unknown>,
) => Principal | undefined;

/** Host-owned workspace path resolution; the protocol handler performs no I/O. */
export type ProtocolWorkspaceResolver = (
  channel: import('../domain/ids.js').RootUri,
  path: string,
) => CatalogWorkspace | PromiseLike<CatalogWorkspace>;

/** Pure policy inputs consumed by the protocol authorization boundary. */
export interface ProtocolAuthorizationOptions {
  /** One immutable policy value for all resources. */
  readonly acl?: AccessControlList | ResourceAcl;
  /** Descriptive aliases accepted by composition callers. */
  readonly accessControlList?: AccessControlList | ResourceAcl;
  readonly resourceAcl?: AccessControlList | ResourceAcl;
  /** Optional fixed identity for in-process callers without a transport context. */
  readonly principal?: Principal;
  /** Per-connection identity supplied by an authentication adapter. */
  readonly principalResolver?: ProtocolPrincipalResolver;
  readonly principalForConnection?: ProtocolPrincipalResolver;
  readonly resolvePrincipal?: ProtocolPrincipalResolver;
  /** Require an identity even when no ACL value is installed. */
  readonly required?: boolean;
}

export interface ProtocolServerHandlerOptions {
  readonly hostEpoch: string;
  /** Server-priority protocol versions. */
  readonly protocolVersions?: readonly string[];
  /** Backward-compatible descriptive alias. */
  readonly supportedProtocolVersions?: readonly string[];
  readonly stateProvider: ProtocolStateProvider<HostAction, HostState, AgentResource>;
  readonly logicalClientRegistry?: LogicalClientRegistry<ClientCapabilities>;
  /** Backward-compatible short alias. */
  readonly clientRegistry?: LogicalClientRegistry<ClientCapabilities>;
  readonly fakeChatActor?: ChatCommandActor;
  /** Backward-compatible short alias. */
  readonly chatActor?: ChatCommandActor;
  /** Catalog create is supplied by the actor that owns command dedupe/backings. */
  readonly catalogChatCreator?: Pick<ChatCommandActor, 'createChat'>;
  readonly supportedCommandsProvider?: (channel: import('../domain/ids.js').ChatUri) => Promise<readonly {
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string;
    readonly aliases?: readonly string[];
  }[]>;
  readonly chatConfigurator?: (
    channel: import('../domain/ids.js').ChatUri,
    patch: Omit<ConfigureChatParams, 'channel'>,
  ) => Promise<Readonly<{ modelId?: string; effort?: string; permissionMode: string }>>;
  /** Filesystem/host composition resolves and publishes a canonical workspace. */
  readonly workspaceResolver?: ProtocolWorkspaceResolver;
  readonly supportedResources?: ReadonlySet<AgentResource>;
  /** Transport-neutral authentication and resource policy boundary. */
  readonly authorization?: ProtocolAuthorizationOptions;
  /** Top-level aliases keep direct protocol construction ergonomic. */
  readonly acl?: AccessControlList | ResourceAcl;
  readonly accessControlList?: AccessControlList | ResourceAcl;
  readonly resourceAcl?: AccessControlList | ResourceAcl;
  readonly principal?: Principal;
  readonly principalResolver?: ProtocolPrincipalResolver;
  readonly principalForConnection?: ProtocolPrincipalResolver;
  readonly resolvePrincipal?: ProtocolPrincipalResolver;
  readonly requireAuthorization?: boolean;
}

/** The successful reconnect result exposed by the RPC method. */
export type ReconnectRpcResult = ReconnectResult<HostAction, HostState, AgentResource> & {
  readonly hostEpoch: string;
};

interface ConnectionContext {
  readonly connection: ProtocolConnection;
  readonly id: ConnectionId;
  readonly principal: Principal | undefined;
  readonly subscriptions: SubscriptionBuffer<HostAction, AgentResource>;
  readonly activeResources: Set<AgentResource>;
  readonly knownResources: Set<AgentResource>;
  readonly heldActions: Map<number, ActionEnvelope<HostAction, AgentResource>>;
  requestTail: Promise<void>;
  sendTail: Promise<void>;
  clientId: ClientId | undefined;
  initialized: boolean;
  fenced: boolean;
  failed: boolean;
  closed: boolean;
  outputHold: boolean;
}

class ProtocolRequestError extends Error {
  public readonly descriptor: JsonRpcErrorDescriptor;
  public readonly data: unknown;

  public constructor(descriptor: JsonRpcErrorDescriptor, data?: unknown) {
    super(descriptor.message);
    this.name = 'ProtocolRequestError';
    this.descriptor = descriptor;
    this.data = data;
  }
}

interface SubscribeTransaction {
  readonly resource: AgentResource;
  readonly token: SubscriptionToken<AgentResource> | undefined;
  readonly wasActive: boolean;
  readonly wasKnown: boolean;
}

const METHODS = new Set([
  'initialize',
  'subscribe',
  'unsubscribe',
  'reconnect',
  'dispatchAction',
  'catalog/createChat',
  'catalog/resolveWorkspace',
  'chat/supportedCommands',
  'chat/configure',
  'chat/resolveApproval',
  'chat/resolveInput',
]);
const EMPTY_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([PROTOCOL_VERSION]);

/**
 * Transport-independent JSON-RPC orchestration for the Phase 1 protocol.
 *
 * Host state is owned by the injected provider/actor. This class owns only
 * connection protocol state, output barriers, and logical-client bindings.
 */
export class ProtocolServerHandler {
  private readonly hostEpoch: string;
  private readonly supportedProtocolVersions: readonly string[];
  private readonly stateProvider: ProtocolStateProvider<HostAction, HostState, AgentResource>;
  private readonly clientRegistry: LogicalClientRegistry<ClientCapabilities>;
  private readonly chatActor: ChatCommandActor;
  private readonly catalogChatCreator: Pick<ChatCommandActor, 'createChat'>;
  private readonly supportedCommandsProvider: ProtocolServerHandlerOptions['supportedCommandsProvider'];
  private readonly chatConfigurator: ProtocolServerHandlerOptions['chatConfigurator'];
  private readonly workspaceResolver: ProtocolServerHandlerOptions['workspaceResolver'];
  private readonly supportedResources: ReadonlySet<AgentResource> | undefined;
  private readonly acl: AccessControlList | ResourceAcl | undefined;
  private readonly principal: Principal | undefined;
  private readonly principalResolver: ProtocolPrincipalResolver | undefined;
  private readonly authorizationRequired: boolean;
  private readonly connections = new Map<ConnectionId, ConnectionContext>();
  private readonly actionDisposable: { dispose(): void };
  private disposed = false;

  public constructor(options: ProtocolServerHandlerOptions) {
    assertHostEpoch(options.hostEpoch);
    this.hostEpoch = options.hostEpoch;
    const configuredProtocolVersions = options.protocolVersions !== undefined
      ? options.protocolVersions
      : options.supportedProtocolVersions !== undefined
        ? options.supportedProtocolVersions
        : EMPTY_PROTOCOL_VERSIONS;
    assertProtocolVersions(configuredProtocolVersions);
    this.supportedProtocolVersions = Object.freeze([...configuredProtocolVersions]);
    this.stateProvider = options.stateProvider;
    const clientRegistry = options.logicalClientRegistry ?? options.clientRegistry;
    const chatActor = options.fakeChatActor ?? options.chatActor;
    if (clientRegistry === undefined) {
      throw new TypeError('logicalClientRegistry is required');
    }
    if (chatActor === undefined) {
      throw new TypeError('fakeChatActor is required');
    }
    this.clientRegistry = clientRegistry;
    this.chatActor = chatActor;
    this.catalogChatCreator = options.catalogChatCreator ?? chatActor;
    this.supportedCommandsProvider = options.supportedCommandsProvider;
    this.chatConfigurator = options.chatConfigurator;
    this.workspaceResolver = options.workspaceResolver;
    this.supportedResources = options.supportedResources === undefined
      ? undefined
      : new Set(options.supportedResources);
    const authorization = options.authorization;
    this.acl = authorization?.acl
      ?? authorization?.accessControlList
      ?? authorization?.resourceAcl
      ?? options.acl
      ?? options.accessControlList
      ?? options.resourceAcl;
    this.principal = authorization?.principal ?? options.principal;
    this.principalResolver = authorization?.principalResolver
      ?? authorization?.principalForConnection
      ?? authorization?.resolvePrincipal
      ?? options.principalResolver
      ?? options.principalForConnection
      ?? options.resolvePrincipal;
    const explicitAuthorizationRequired = authorization?.required ?? options.requireAuthorization;
    this.authorizationRequired = explicitAuthorizationRequired ?? this.acl !== undefined;
    this.actionDisposable = this.stateProvider.onAction((envelope) => this.onHostAction(envelope));
  }

  /** Queue one incoming frame behind all earlier frames from this connection. */
  public handle(connection: ProtocolConnection, raw: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const context = this.contextFor(connection);
    const task = context.requestTail.then(
      () => this.process(context, raw),
      () => this.process(context, raw),
    );
    context.requestTail = task.catch(() => undefined);
    return task.catch(() => undefined);
  }

  /** Safely detach one transport without deleting its logical client record. */
  public onConnectionClosed(connectionId: ConnectionId): void {
    let parsed: ConnectionId;
    try {
      parsed = parseConnectionId(connectionId);
    } catch {
      return;
    }

    const context = this.connections.get(parsed);
    if (context !== undefined) {
      context.closed = true;
      context.outputHold = false;
      this.cancelAllBarriers(context);
      context.heldActions.clear();
      this.connections.delete(parsed);
      if (context.clientId !== undefined) {
        this.clientRegistry.close(parsed);
      }
    } else {
      this.clientRegistry.close(parsed);
    }
  }

  /** Dispose the listener and detach all transports without touching host state. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.actionDisposable.dispose();
    for (const context of this.connections.values()) {
      this.onConnectionClosed(context.id);
    }
    this.connections.clear();
  }

  private contextFor(connection: ProtocolConnection): ConnectionContext {
    const id = parseConnectionId(connection.id);
    const existing = this.connections.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const context: ConnectionContext = {
      connection,
      id,
      principal: this.resolvePrincipal(connection),
      subscriptions: new SubscriptionBuffer<HostAction, AgentResource>(),
      activeResources: new Set<AgentResource>(),
      knownResources: new Set<AgentResource>(),
      heldActions: new Map<number, ActionEnvelope<HostAction, AgentResource>>(),
      requestTail: Promise.resolve(),
      sendTail: Promise.resolve(),
      clientId: undefined,
      initialized: false,
      fenced: false,
      failed: false,
      closed: false,
      outputHold: false,
    };
    this.connections.set(id, context);
    return context;
  }

  /**
   * Resolve only an already-authenticated identity.  This adapter deliberately
   * understands no Authorization header, URL, cookie, or verifier state; a
   * transport may attach its verified principal directly or through the
   * transport-neutral context shape. Invalid values fail closed when policy is
   * enabled.
   */
  private resolvePrincipal(connection: ProtocolConnection): Principal | undefined {
    if (this.principalResolver !== undefined) {
      try {
        // A configured resolver is authoritative. An explicit undefined or
        // malformed result must not fall through to a principal accidentally
        // attached by another adapter.
        return normalizePrincipal(this.principalResolver(connection));
      } catch {
        return undefined;
      }
    }

    const fromConnection = principalFromConnection(connection);
    if (fromConnection !== undefined) {
      return fromConnection;
    }
    return this.principal;
  }

  private async process(context: ConnectionContext, raw: string): Promise<void> {
    if (context.closed || context.failed) {
      return;
    }

    const parsed = parseJsonRpcMessage(raw);
    if (isJsonRpcFailure(parsed)) {
      await this.trySend(context, JSON.stringify(parsed));
      return;
    }

    const request = parsed as JsonRpcRequest<unknown>;
    if (!METHODS.has(request.method)) {
      await this.sendError(context, request.id, JSON_RPC_ERRORS.MethodNotFound);
      return;
    }

    if (context.fenced) {
      await this.sendError(context, request.id, JSON_RPC_ERRORS.ClientReplaced);
      return;
    }

    if (request.method === 'initialize' && context.initialized) {
      await this.sendError(context, request.id, JSON_RPC_ERRORS.InvalidRequest);
      return;
    }

    if (!context.initialized && request.method !== 'initialize' && request.method !== 'reconnect') {
      await this.sendError(context, request.id, JSON_RPC_ERRORS.NotInitialized);
      return;
    }

    try {
      switch (request.method) {
        case 'initialize':
          await this.handleInitialize(context, request.id, this.parseParams(request, initializeParamsSchema));
          return;
        case 'subscribe':
          await this.handleSubscribe(context, request.id, this.parseParams(request, subscribeParamsSchema));
          return;
        case 'unsubscribe':
          await this.handleUnsubscribe(context, request.id, this.parseParams(request, unsubscribeParamsSchema));
          return;
        case 'reconnect':
          await this.handleReconnect(context, request.id, this.parseParams(request, reconnectParamsSchema));
          return;
        case 'dispatchAction':
          await this.handleDispatch(context, request.id, this.parseParams(request, dispatchActionParamsSchema));
          return;
        case 'catalog/createChat':
          await this.handleCreateChat(context, request.id, this.parseParams(request, catalogCreateChatParamsSchema));
          return;
        case 'catalog/resolveWorkspace':
          await this.handleResolveWorkspace(context, request.id, this.parseWorkspaceParams(request));
          return;
        case 'chat/supportedCommands':
          await this.handleSupportedCommands(context, request.id, this.parseParams(request, supportedCommandsParamsSchema));
          return;
        case 'chat/configure':
          await this.handleConfigureChat(context, request.id, this.parseParams(request, configureChatParamsSchema));
          return;
        case 'chat/resolveApproval':
          await this.handleResolveApproval(context, request.id, this.parseParams(request, resolveApprovalParamsSchema));
          return;
        case 'chat/resolveInput':
          await this.handleResolveInput(context, request.id, this.parseParams(request, resolveInputParamsSchema));
          return;
        default:
          return;
      }
    } catch (error) {
      const mapped = mapProtocolError(error);
      await this.sendError(context, request.id, mapped.descriptor, mapped.data);
    }
  }

  private parseParams<T>(request: JsonRpcRequest<unknown>, schema: { safeParse(value: unknown): unknown }): T {
    const result = schema.safeParse(request.params) as
      | { success: true; data: T }
      | { success: false; error: unknown };
    if (!result.success) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.InvalidParams, {
        issues: toSafeValidationIssues(result.error),
      });
    }
    return result.data;
  }

  private parseWorkspaceParams(request: JsonRpcRequest<unknown>): ResolveWorkspaceParams {
    const result = resolveWorkspaceParamsSchema.safeParse(request.params);
    if (result.success) {
      return result.data;
    }

    const issues = toSafeValidationIssues(result.error);
    const hasPathIssue = issues.some((issue) => issue.path[0] === 'path');
    throw new ProtocolRequestError(JSON_RPC_ERRORS.InvalidParams, hasPathIssue
      ? { code: WORKSPACE_RESOLVE_ERROR_CODES.invalidPath }
      : { issues });
  }

  private async handleInitialize(
    context: ConnectionContext,
    id: JsonRpcId,
    params: InitializeParams,
  ): Promise<void> {
    this.requireAuthentication(context);
    const protocolVersion = this.negotiate(params.protocolVersions);
    const resources = dedupeResources(params.initialSubscriptions);
    // Unauthorized initial subscriptions are omitted from the returned
    // `missing` list. This keeps initialize from becoming a resource-existence
    // oracle while allowing an authorized client to initialize other channels.
    const authorizedResources = resources.filter((resource) => (
      this.isAuthorized(context, 'subscribe', resource)
    ));
    const supportedResources = authorizedResources.filter((resource) => this.isSupported(resource));
    const priorClient = this.clientRegistry.snapshot(params.clientId);
    const priorSupportedSubscriptions = priorClient?.subscriptions.filter((resource) => (
      this.isSupported(resource) && this.isAuthorized(context, 'subscribe', resource)
    )) ?? [];
    const registration = this.clientRegistry.register({
      clientId: params.clientId,
      connectionId: context.id,
      capabilities: params.capabilities,
      subscriptions: priorSupportedSubscriptions,
    });
    context.clientId = params.clientId;
    if (registration.replacedConnectionId !== undefined) {
      this.fenceReplacedConnection(registration.replacedConnectionId);
    }

    context.outputHold = true;
    const tokens = new Map<AgentResource, SubscriptionToken<AgentResource>>();
    for (const resource of supportedResources) {
      context.knownResources.add(resource);
      tokens.set(resource, context.subscriptions.begin(resource));
    }

    let responseSent = false;
    try {
      const batch = this.stateProvider.snapshots(supportedResources);
      const snapshots = filterSnapshots(batch.snapshots, supportedResources, this.supportedResources);
      const result: InitializeResult<HostState> = {
        protocolVersion,
        hostEpoch: this.hostEpoch,
        serverSeq: batch.serverSeq,
        snapshots,
        missing: missingResources(
          authorizedResources,
          [
            ...batch.missing.filter((resource) => authorizedResources.includes(resource)),
            ...authorizedResources.filter((resource) => !this.isSupported(resource)),
          ],
          snapshots,
        ),
      };
      responseSent = await this.trySendResponse(context, id, result);
      if (!responseSent || !this.isCurrent(context)) {
        return;
      }

      const snapshotsByResource = new Map<AgentResource, StateSnapshot<HostState, AgentResource>>();
      for (const snapshot of snapshots) {
        snapshotsByResource.set(snapshot.resource, snapshot);
      }
      const committed: ActionEnvelope<HostAction, AgentResource>[] = [];
      const active: AgentResource[] = [];
      for (const resource of supportedResources) {
        const token = tokens.get(resource);
        if (token === undefined) {
          continue;
        }
        const snapshot = snapshotsByResource.get(resource);
        if (snapshot === undefined) {
          context.subscriptions.cancel(token);
          context.activeResources.delete(resource);
          continue;
        }
        active.push(resource);
        context.activeResources.add(resource);
        committed.push(...context.subscriptions.commit(token, snapshot.fromSeq));
      }
      context.knownResources.clear();
      for (const resource of active) {
        context.knownResources.add(resource);
      }
      this.clientRegistry.replaceSubscriptions(context.clientId, context.id, active);
      context.initialized = true;
      this.flushHeld(context, committed);
    } finally {
      context.outputHold = false;
      if (!responseSent && !context.fenced) {
        this.cancelTokens(context, tokens);
        context.knownResources.clear();
      }
    }
  }

  private async handleSubscribe(
    context: ConnectionContext,
    id: JsonRpcId,
    params: SubscribeParams,
  ): Promise<void> {
    this.requireCurrentClient(context);
    const resource = params.channel;
    this.requireAuthorized(context, 'subscribe', resource);
    const supported = this.isSupported(resource);
    const wasActive = supported && context.activeResources.has(resource) && context.subscriptions.isActive(resource);
    const wasKnown = supported && context.knownResources.has(resource);
    const transaction: SubscribeTransaction = {
      resource,
      token: !supported || wasActive ? undefined : context.subscriptions.begin(resource),
      wasActive,
      wasKnown,
    };
    context.outputHold = true;
    if (supported && !wasKnown) {
      context.knownResources.add(resource);
    }

    let responseSent = false;
    let succeeded = false;
    let committed: readonly ActionEnvelope<HostAction, AgentResource>[] = [];
    let successCutoff: number | undefined;
    try {
      let snapshot: StateSnapshot<HostState, AgentResource> | undefined;
      try {
        snapshot = supported ? this.stateProvider.snapshot(resource) : undefined;
      } catch (error) {
        const mapped = mapProtocolError(error);
        responseSent = await this.sendError(context, id, mapped.descriptor, mapped.data);
        return;
      }

      if (snapshot === undefined) {
        responseSent = await this.sendError(context, id, JSON_RPC_ERRORS.ResourceNotFound, { resource });
        return;
      }

      // Commit the new barrier before sending the response. Actions that arrive
      // while the response is in flight are then held by outputHold, while any
      // actions buffered before the snapshot cut are returned by commit(). This
      // also makes malformed provider snapshot cuts fail before a success is
      // sent, so the rollback path has one response ordering to maintain.
      if (transaction.token !== undefined) {
        committed = context.subscriptions.commit(transaction.token, snapshot.fromSeq);
        context.activeResources.add(resource);
      } else {
        successCutoff = snapshot.fromSeq;
      }

      responseSent = await this.trySendResponse(context, id, { snapshot } satisfies SubscribeResult<HostState>);
      if (!responseSent || !this.isCurrent(context)) {
        return;
      }

      this.clientRegistry.addSubscription(context.clientId as ClientId, context.id, resource);
      succeeded = true;
    } catch (error) {
      // Keep the output barrier up while mapping unexpected setup failures. The
      // error response must be queued before held actions are released.
      if (!responseSent) {
        const mapped = mapProtocolError(error);
        responseSent = await this.sendError(context, id, mapped.descriptor, mapped.data);
      }
    } finally {
      const canFanOut = responseSent && this.isCurrent(context);
      context.outputHold = false;

      if (!succeeded) {
        this.rollbackSubscribe(context, transaction);
        if (canFanOut) {
          // Any held action was received while this request was pending. Only
          // resources restored by rollback may be delivered; the failed new
          // resource has no active subscription and is therefore dropped.
          this.flushHeld(context, []);
        } else {
          context.heldActions.clear();
        }
      } else if (canFanOut) {
        const cutoffs = successCutoff === undefined
          ? undefined
          : new Map([[resource, successCutoff]]);
        this.flushHeld(context, committed, cutoffs);
      } else {
        context.heldActions.clear();
      }
    }
  }

  private async handleUnsubscribe(
    context: ConnectionContext,
    id: JsonRpcId,
    params: UnsubscribeParams,
  ): Promise<void> {
    const clientId = this.requireCurrentClient(context);
    const resource = params.channel;
    this.requireAuthorized(context, 'subscribe', resource);
    const removed = context.activeResources.delete(resource);
    context.subscriptions.unsubscribe(resource);
    context.knownResources.delete(resource);
    if (removed) {
      this.clientRegistry.removeSubscription(clientId, context.id, resource);
    }
    await this.trySendResponse(context, id, { removed } satisfies UnsubscribeResult);
  }

  private async handleReconnect(
    context: ConnectionContext,
    id: JsonRpcId,
    params: ReconnectParams,
  ): Promise<void> {
    this.requireAuthentication(context);
    if (context.initialized && context.clientId !== params.clientId) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.InvalidParams);
    }
    if (context.initialized) {
      this.requireCurrentClient(context);
    }

    const priorClient = this.clientRegistry.snapshot(params.clientId);
    if (priorClient === undefined) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.ResourceNotFound, { clientId: params.clientId });
    }
    const clientId = params.clientId;
    const resources = dedupeResources(params.subscriptions);
    // As with initialize, do not echo denied resources through `missing`.
    const authorizedResources = resources.filter((resource) => (
      this.isAuthorized(context, 'subscribe', resource)
    ));
    const supportedResources = authorizedResources.filter((resource) => this.isSupported(resource));
    const declared = new Set(priorClient.subscriptions);
    for (const resource of authorizedResources) {
      if (!declared.has(resource)) {
        throw new ProtocolRequestError(JSON_RPC_ERRORS.ResourceNotFound, { resource });
      }
    }

    const priorSupportedSubscriptions = priorClient.subscriptions.filter((resource) => (
      this.isSupported(resource) && this.isAuthorized(context, 'subscribe', resource)
    ));
    const registration = this.clientRegistry.register({
      clientId,
      connectionId: context.id,
      subscriptions: priorSupportedSubscriptions,
    });
    context.clientId = clientId;
    context.initialized = true;
    if (registration.replacedConnectionId !== undefined) {
      this.fenceReplacedConnection(registration.replacedConnectionId);
    }

    const previousActive = new Set(context.activeResources);
    const reconnectStartSeq = this.stateProvider.serverSeq;
    context.outputHold = true;
    const tokens = new Map<AgentResource, SubscriptionToken<AgentResource>>();
    for (const resource of supportedResources) {
      context.knownResources.add(resource);
      tokens.set(resource, context.subscriptions.begin(resource));
    }
    let responseSent = false;
    let setupFailed = false;
    try {
      let stateResult: ReconnectResult<HostAction, HostState, AgentResource>;
      try {
        stateResult = params.hostEpoch === this.hostEpoch
          ? this.reconnectForResources(params.lastSeenServerSeq, authorizedResources)
          : this.snapshotReconnect(authorizedResources);
      } catch (error) {
        setupFailed = true;
        const mapped = mapProtocolError(error);
        responseSent = await this.sendError(context, id, mapped.descriptor, mapped.data);
        return;
      }
      const result: ReconnectRpcResult = {
        ...stateResult,
        hostEpoch: this.hostEpoch,
      };
      responseSent = await this.trySendResponse(context, id, result);
      if (!responseSent || !this.isCurrent(context)) {
        return;
      }

      const missing = new Set(result.missing);
      const snapshotsByResource = new Map<AgentResource, StateSnapshot<HostState, AgentResource>>();
      if (result.type === 'snapshot') {
        for (const snapshot of result.snapshots) {
          snapshotsByResource.set(snapshot.resource, snapshot);
        }
      }
      const committed: ActionEnvelope<HostAction, AgentResource>[] = [];
      const active: AgentResource[] = [];
      for (const resource of supportedResources) {
        const token = tokens.get(resource);
        if (token === undefined) {
          continue;
        }
        if (missing.has(resource)) {
          context.subscriptions.cancel(token);
          context.activeResources.delete(resource);
          continue;
        }
        active.push(resource);
        context.activeResources.add(resource);
        const baseline = result.type === 'snapshot'
          ? snapshotsByResource.get(resource)?.fromSeq
          : result.throughSeq;
        if (baseline === undefined) {
          context.subscriptions.cancel(token);
          context.activeResources.delete(resource);
          continue;
        }
        committed.push(...context.subscriptions.commit(token, baseline));
      }
      for (const resource of previousActive) {
        if (!active.includes(resource)) {
          context.subscriptions.unsubscribe(resource);
        }
      }
      context.activeResources.clear();
      for (const resource of active) {
        context.activeResources.add(resource);
      }
      context.knownResources.clear();
      for (const resource of active) {
        context.knownResources.add(resource);
      }
      this.clientRegistry.replaceSubscriptions(clientId, context.id, active);
      this.flushHeld(context, committed);
    } finally {
      context.outputHold = false;
      if ((setupFailed || !responseSent) && !context.fenced && !context.closed) {
        const restored: ActionEnvelope<HostAction, AgentResource>[] = [];
        for (const [resource, token] of tokens) {
          if (previousActive.has(resource)) {
            context.activeResources.add(resource);
            restored.push(...context.subscriptions.commit(token, reconnectStartSeq));
          } else {
            context.subscriptions.cancel(token);
            context.activeResources.delete(resource);
          }
        }
        this.flushHeld(context, restored);
      }
    }
  }

  private async handleDispatch(
    context: ConnectionContext,
    id: JsonRpcId,
    params: DispatchActionParams,
  ): Promise<void> {
    const clientId = this.requireCurrentClient(context);
    const requiredAction: AuthorizationAction = params.action.type === 'chat/send'
      ? 'send'
      : 'interrupt';
    this.requireAuthorized(context, requiredAction, params.channel);
    this.requireSubscribedChannel(context, params.channel);

    const receipt: ChatCommandReceipt = await this.chatActor.dispatch(
      clientId,
      params.clientSeq,
      params.commandId,
      params.channel,
      params.action,
    );
    if (receipt.status === 'accepted') {
      this.clientRegistry.recordProcessedClientSeq(clientId, params.clientSeq);
    }
    await this.trySendResponse(context, id, { receipt });
  }

  private async handleCreateChat(
    context: ConnectionContext,
    id: JsonRpcId,
    params: CatalogCreateChatParams,
  ): Promise<void> {
    const clientId = this.requireCurrentClient(context);
    this.requireAuthorized(context, 'configure', params.channel);
    this.requireSubscribedChannel(context, params.channel);

    const creator = this.catalogChatCreator.createChat;
    const receipt: CatalogCreateChatReceipt = creator === undefined
      ? {
          status: 'rejected',
          code: 'CATALOG_CREATE_UNAVAILABLE',
          message: 'catalog chat creation is not configured',
        }
      : await creator.call(
          this.catalogChatCreator,
          clientId,
          params.clientSeq,
          params.commandId,
          params.channel,
          {
            workspaceId: params.workspaceId,
            modelId: params.modelId,
            ...(params.effort === undefined ? {} : { effort: params.effort }),
            ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
            ...(params.initialPrompt === undefined ? {} : { initialPrompt: params.initialPrompt }),
          },
        );
    if (receipt.status === 'accepted') {
      this.clientRegistry.recordProcessedClientSeq(clientId, params.clientSeq);
    }
    await this.trySendResponse(context, id, { receipt });
  }

  private async handleResolveWorkspace(
    context: ConnectionContext,
    id: JsonRpcId,
    params: ResolveWorkspaceParams,
  ): Promise<void> {
    this.requireCurrentClient(context);
    this.requireAuthorized(context, 'configure', params.channel);
    this.requireSubscribedChannel(context, params.channel);
    if (this.workspaceResolver === undefined) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.MethodNotFound);
    }

    const workspace = await this.workspaceResolver(params.channel, params.path);
    await this.trySendResponse(context, id, { workspace });
  }

  private async handleSupportedCommands(
    context: ConnectionContext,
    id: JsonRpcId,
    params: SupportedCommandsParams,
  ): Promise<void> {
    this.requireCurrentClient(context);
    this.requireAuthorized(context, 'read', params.channel);
    this.requireSubscribedChannel(context, params.channel);
    const commands = this.supportedCommandsProvider === undefined
      ? []
      : await this.supportedCommandsProvider(params.channel);
    await this.trySendResponse(context, id, { commands });
  }

  private async handleConfigureChat(
    context: ConnectionContext,
    id: JsonRpcId,
    params: ConfigureChatParams,
  ): Promise<void> {
    this.requireCurrentClient(context);
    this.requireAuthorized(context, 'configure', params.channel);
    this.requireSubscribedChannel(context, params.channel);
    if (this.chatConfigurator === undefined) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.MethodNotFound);
    }
    const { channel, ...patch } = params;
    const config = await this.chatConfigurator(channel, patch);
    await this.trySendResponse(context, id, { config });
  }

  private async handleResolveApproval(
    context: ConnectionContext,
    id: JsonRpcId,
    params: ResolveApprovalParams,
  ): Promise<void> {
    const clientId = this.requireCurrentClient(context);
    this.requireAuthorized(context, 'approve', params.channel);
    this.requireSubscribedChannel(context, params.channel);
    const resolver = this.chatActor.resolveApproval;
    const receipt = resolver === undefined
      ? {
          status: 'rejected' as const,
          code: 'INTERACTION_NOT_CONFIGURED',
          message: 'chat interaction resolution is not configured',
        }
      : await this.chatActor.resolveApproval!(
          clientId,
          params.clientSeq,
          params.commandId,
          params.channel,
          {
            approvalId: params.approvalId,
            decision: params.decision,
            ...(params.updatedInput === undefined ? {} : { updatedInput: params.updatedInput }),
            ...(params.updatedPermissions === undefined
              ? {}
              : { updatedPermissions: params.updatedPermissions }),
            ...(params.decisionClassification === undefined
              ? {}
              : { decisionClassification: params.decisionClassification }),
            ...(params.message === undefined ? {} : { message: params.message }),
            ...(params.interrupt === undefined ? {} : { interrupt: params.interrupt }),
          },
        );
    if (receipt.status === 'accepted') {
      this.clientRegistry.recordProcessedClientSeq(clientId, params.clientSeq);
    }
    await this.trySendResponse(context, id, { receipt });
  }

  private async handleResolveInput(
    context: ConnectionContext,
    id: JsonRpcId,
    params: ResolveInputParams,
  ): Promise<void> {
    const clientId = this.requireCurrentClient(context);
    this.requireAuthorized(context, 'approve', params.channel);
    this.requireSubscribedChannel(context, params.channel);
    const resolver = this.chatActor.resolveInput;
    const receipt = resolver === undefined
      ? {
          status: 'rejected' as const,
          code: 'INTERACTION_NOT_CONFIGURED',
          message: 'chat interaction resolution is not configured',
        }
      : await this.chatActor.resolveInput!(
          clientId,
          params.clientSeq,
          params.commandId,
          params.channel,
          {
            inputId: params.inputId,
            ...(params.answers === undefined ? {} : { answers: params.answers }),
          },
        );
    if (receipt.status === 'accepted') {
      this.clientRegistry.recordProcessedClientSeq(clientId, params.clientSeq);
    }
    await this.trySendResponse(context, id, { receipt });
  }

  /** Require an authenticated identity when the handler is configured to do so. */
  private requireAuthentication(context: ConnectionContext): void {
    if (this.authorizationRequired && context.principal === undefined) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.AuthorizationDenied);
    }
  }

  /**
   * Evaluate the immutable security policy before touching any actor, sequence,
   * subscription, or host-state mutation. With no policy configured the
   * Phase 0–6 in-process behavior remains available; `required` still provides
   * a fail-closed authentication gate for callers that opt into it.
   */
  private isAuthorized(
    context: ConnectionContext,
    action: AuthorizationAction,
    resource: AgentResource,
  ): boolean {
    if (this.acl === undefined) {
      return !this.authorizationRequired || context.principal !== undefined;
    }
    if (context.principal === undefined) {
      return false;
    }
    return authorizeResource(context.principal, action, resource, this.acl).kind === 'allow';
  }

  private requireAuthorized(
    context: ConnectionContext,
    action: AuthorizationAction,
    resource: AgentResource,
  ): void {
    if (!this.isAuthorized(context, action, resource)) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.AuthorizationDenied);
    }
  }

  private requireSubscribedChannel(context: ConnectionContext, channel: AgentResource): void {
    if (!this.isSupported(channel)) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.ResourceNotFound, { resource: channel });
    }
    if (context.activeResources.has(channel)) {
      return;
    }
    if (this.stateProvider.snapshot(channel) === undefined) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.ResourceNotFound, { resource: channel });
    }
    throw new ProtocolRequestError(JSON_RPC_ERRORS.CommandRejected, {
      code: 'NOT_SUBSCRIBED',
      message: 'chat channel is not subscribed',
    });
  }

  private requireCurrentClient(context: ConnectionContext): ClientId {
    if (context.clientId === undefined || !this.clientRegistry.isActive(context.clientId, context.id)) {
      throw new ProtocolRequestError(JSON_RPC_ERRORS.ClientReplaced);
    }
    return context.clientId;
  }

  private negotiate(offered: readonly string[]): typeof PROTOCOL_VERSION {
    for (const supported of this.supportedProtocolVersions) {
      if (offered.includes(supported)) {
        if (supported !== PROTOCOL_VERSION) {
          throw new ProtocolRequestError(JSON_RPC_ERRORS.UnsupportedProtocol);
        }
        return PROTOCOL_VERSION;
      }
    }
    throw new ProtocolRequestError(JSON_RPC_ERRORS.UnsupportedProtocol);
  }

  private reconnectForResources(
    lastSeen: number,
    resources: readonly AgentResource[],
  ): ReconnectResult<HostAction, HostState, AgentResource> {
    const supportedResources = resources.filter((resource) => this.isSupported(resource));
    const result = this.stateProvider.reconnect(lastSeen, new Set(supportedResources));
    const missing = missingResources(
      resources,
      [...result.missing, ...resources.filter((resource) => !this.isSupported(resource))],
      result.type === 'snapshot' ? result.snapshots : undefined,
    );
    if (result.type === 'replay') {
      return {
        type: 'replay',
        actions: filterActions(result.actions, resources, this.supportedResources),
        missing,
        throughSeq: result.throughSeq,
        serverSeq: result.serverSeq,
      };
    }

    return {
      type: 'snapshot',
      snapshots: filterSnapshots(result.snapshots, resources, this.supportedResources),
      missing,
      throughSeq: result.throughSeq,
      serverSeq: result.serverSeq,
    };
  }

  private snapshotReconnect(resources: readonly AgentResource[]): ReconnectResult<HostAction, HostState, AgentResource> {
    const supportedResources = resources.filter((resource) => this.isSupported(resource));
    const batch = this.stateProvider.snapshots(supportedResources);
    const snapshots = filterSnapshots(batch.snapshots, resources, this.supportedResources);
    return {
      type: 'snapshot',
      snapshots,
      missing: missingResources(
        resources,
        [...batch.missing, ...resources.filter((resource) => !this.isSupported(resource))],
        snapshots,
      ),
      throughSeq: batch.throughSeq,
      serverSeq: batch.serverSeq,
    };
  }

  private isSupported(resource: AgentResource): boolean {
    return this.supportedResources === undefined || this.supportedResources.has(resource);
  }

  private isCurrent(context: ConnectionContext): boolean {
    return !context.fenced && !context.closed && context.clientId !== undefined &&
      this.clientRegistry.isActive(context.clientId, context.id);
  }

  private async trySendResponse(context: ConnectionContext, id: JsonRpcId, result: unknown): Promise<boolean> {
    return this.trySend(context, JSON.stringify(successResponse(id, result)));
  }

  private async sendError(
    context: ConnectionContext,
    id: JsonRpcId | null,
    descriptor: JsonRpcErrorDescriptor,
    data?: unknown,
  ): Promise<boolean> {
    return this.trySend(context, JSON.stringify(errorResponse(id, descriptor, data)));
  }

  private async trySend(context: ConnectionContext, text: string, requireCurrent = false): Promise<boolean> {
    if (context.closed || context.failed || (requireCurrent && !this.isCurrent(context))) {
      return false;
    }
    try {
      await this.enqueueSend(context, text, requireCurrent);
      return !context.failed && !context.closed && (!requireCurrent || this.isCurrent(context));
    } catch {
      return false;
    }
  }

  private enqueueSend(context: ConnectionContext, text: string, requireCurrent = false): Promise<void> {
    const task = context.sendTail.then(async () => {
      if (context.closed || context.failed) {
        throw new Error('connection is unavailable');
      }
      if (requireCurrent && !this.isCurrent(context)) {
        return;
      }
      await context.connection.send(text);
    });
    context.sendTail = task.catch((error: unknown) => {
      this.failConnection(context, error);
    });
    return task;
  }

  private failConnection(context: ConnectionContext, _error: unknown): void {
    if (context.failed || context.closed) {
      return;
    }
    context.failed = true;
    this.onConnectionClosed(context.id);
    try {
      context.connection.close(1011, 'send failed');
    } catch {
      // A failed transport is already detached; close is best effort.
    }
  }

  private fenceReplacedConnection(connectionId: ConnectionId): void {
    const context = this.connections.get(connectionId);
    if (context === undefined || context.closed || context.fenced) {
      return;
    }
    context.fenced = true;
    context.outputHold = false;
    this.cancelAllBarriers(context);
    context.heldActions.clear();
    const replaced = JSON.stringify(notification('client/replaced', { reason: 'client connection replaced' }));
    void this.enqueueSend(context, replaced).catch(() => undefined);
    try {
      // Do not let an older unresolved async send keep a fenced transport open.
      // The replacement notification remains best effort on the serialized
      // output queue; the transport close callback owns final detachment.
      context.connection.close(4001, 'client replaced');
    } catch {
      // Best effort close after fencing the connection in memory.
    }
  }

  private onHostAction(envelope: ActionEnvelope<HostAction, AgentResource>): void {
    if (this.disposed || !this.isSupported(envelope.channel)) {
      return;
    }
    for (const context of this.connections.values()) {
      if (context.closed || context.failed || context.fenced) {
        continue;
      }
      // Re-check the policy at fan-out time as a defense against an
      // application mutating/replacing its policy between subscription and an
      // emitted action. Unauthorized state is never queued or sent.
      if (!this.isAuthorized(context, 'subscribe', envelope.channel)) {
        continue;
      }
      const received = context.subscriptions.receive(envelope);
      if (received.type === 'buffer') {
        continue;
      }
      if (received.type !== 'deliver') {
        continue;
      }
      if (context.outputHold) {
        context.heldActions.set(envelope.serverSeq, envelope);
      } else {
        this.sendAction(context, envelope);
      }
    }
  }

  private sendAction(context: ConnectionContext, envelope: ActionEnvelope<HostAction, AgentResource>): void {
    if (!this.isCurrent(context) || !this.isAuthorized(context, 'subscribe', envelope.channel)) {
      return;
    }
    const text = JSON.stringify(notification('state/action', envelope));
    void this.trySend(context, text, true);
  }

  private flushHeld(
    context: ConnectionContext,
    committed: readonly ActionEnvelope<HostAction, AgentResource>[],
    cutoffs?: ReadonlyMap<AgentResource, number>,
  ): void {
    if (!this.isCurrent(context)) {
      context.heldActions.clear();
      return;
    }

    const bySeq = new Map<number, ActionEnvelope<HostAction, AgentResource>>();
    for (const envelope of context.heldActions.values()) {
      bySeq.set(envelope.serverSeq, envelope);
    }
    for (const envelope of committed) {
      bySeq.set(envelope.serverSeq, envelope);
    }
    context.heldActions.clear();
    const ordered = [...bySeq.values()].sort((left, right) => left.serverSeq - right.serverSeq);
    for (const envelope of ordered) {
      const cutoff = cutoffs?.get(envelope.channel);
      if (
        context.activeResources.has(envelope.channel) &&
        (cutoff === undefined || envelope.serverSeq > cutoff)
      ) {
        this.sendAction(context, envelope);
      }
    }
  }

  private rollbackSubscribe(context: ConnectionContext, transaction: SubscribeTransaction): void {
    if (transaction.token !== undefined) {
      context.subscriptions.cancel(transaction.token);
    }
    if (!this.isCurrent(context)) {
      context.subscriptions.unsubscribe(transaction.resource);
      context.activeResources.delete(transaction.resource);
      context.knownResources.delete(transaction.resource);
      return;
    }

    if (transaction.wasActive) {
      context.activeResources.add(transaction.resource);
    } else {
      context.activeResources.delete(transaction.resource);
    }
    if (transaction.wasKnown) {
      context.knownResources.add(transaction.resource);
    } else {
      context.knownResources.delete(transaction.resource);
    }
  }

  private cancelTokens(
    context: ConnectionContext,
    tokens: ReadonlyMap<AgentResource, SubscriptionToken<AgentResource>>,
  ): void {
    for (const token of tokens.values()) {
      context.subscriptions.cancel(token);
    }
  }

  private cancelAllBarriers(context: ConnectionContext): void {
    for (const resource of context.knownResources) {
      context.subscriptions.unsubscribe(resource);
    }
    for (const resource of context.activeResources) {
      context.subscriptions.unsubscribe(resource);
    }
    context.knownResources.clear();
    context.activeResources.clear();
  }
}

function dedupeResources(resources: readonly AgentResource[]): readonly AgentResource[] {
  const result: AgentResource[] = [];
  const seen = new Set<AgentResource>();
  for (const resource of resources) {
    if (!seen.has(resource)) {
      seen.add(resource);
      result.push(resource);
    }
  }
  return Object.freeze(result);
}

function filterSnapshots(
  snapshots: readonly StateSnapshot<HostState, AgentResource>[],
  resources: readonly AgentResource[],
  supportedResources: ReadonlySet<AgentResource> | undefined,
): readonly StateSnapshot<HostState, AgentResource>[] {
  const requested = new Set(resources);
  return snapshots.filter((snapshot) => requested.has(snapshot.resource) && (
    supportedResources === undefined || supportedResources.has(snapshot.resource)
  ));
}

function filterActions(
  actions: readonly ActionEnvelope<HostAction, AgentResource>[],
  resources: readonly AgentResource[],
  supportedResources: ReadonlySet<AgentResource> | undefined,
): readonly ActionEnvelope<HostAction, AgentResource>[] {
  const requested = new Set(resources);
  return actions.filter((envelope) => requested.has(envelope.channel) && (
    supportedResources === undefined || supportedResources.has(envelope.channel)
  ));
}

function missingResources(
  resources: readonly AgentResource[],
  reportedMissing: readonly AgentResource[],
  snapshots?: readonly StateSnapshot<HostState, AgentResource>[],
): readonly AgentResource[] {
  const missing = new Set(reportedMissing);
  if (snapshots !== undefined) {
    const present = new Set(snapshots.map((snapshot) => snapshot.resource));
    for (const resource of resources) {
      if (!present.has(resource)) {
        missing.add(resource);
      }
    }
  }
  return Object.freeze(resources.filter((resource) => missing.has(resource)));
}

function assertHostEpoch(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('hostEpoch must be a non-empty string');
  }
  if (utf8ByteLength(value) > MAX_HOST_EPOCH_BYTES) {
    throw new RangeError('hostEpoch exceeds the maximum length');
  }
}

function assertProtocolVersions(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('supported protocol versions must be an array');
  }
  if (value.length === 0) {
    throw new RangeError('at least one supported protocol version is required');
  }
  if (value.length > MAX_PROTOCOL_VERSIONS) {
    throw new RangeError('too many supported protocol versions');
  }
  for (const version of value) {
    if (typeof version !== 'string' || version.length === 0) {
      throw new TypeError('supported protocol versions must be non-empty strings');
    }
    if (utf8ByteLength(version) > MAX_PROTOCOL_VERSION_BYTES) {
      throw new RangeError('supported protocol version exceeds the maximum length');
    }
    if (version !== PROTOCOL_VERSION) {
      throw new RangeError(`unsupported configured protocol version: ${version}`);
    }
  }
}

function mapProtocolError(error: unknown): ProtocolRequestError {
  if (error instanceof ProtocolRequestError) {
    return error;
  }
  if (error instanceof WorkspaceResolverError) {
    const descriptor = error.code === WORKSPACE_RESOLVE_ERROR_CODES.invalidPath
      ? JSON_RPC_ERRORS.InvalidParams
      : error.code === WORKSPACE_RESOLVE_ERROR_CODES.notFound
        ? JSON_RPC_ERRORS.ResourceNotFound
        : JSON_RPC_ERRORS.CommandRejected;
    return new ProtocolRequestError(descriptor, { code: error.code });
  }
  return new ProtocolRequestError(JSON_RPC_ERRORS.InternalError);
}

function normalizePrincipal(value: unknown): Principal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    readonly principalId?: unknown;
    readonly tenantId?: unknown;
    readonly capabilities?: unknown;
  };
  if (
    typeof candidate.principalId !== 'string'
    || typeof candidate.tenantId !== 'string'
    || !Array.isArray(candidate.capabilities)
    || !candidate.capabilities.every((capability): capability is string => typeof capability === 'string')
  ) {
    return undefined;
  }
  try {
    return createPrincipal({
      principalId: candidate.principalId,
      tenantId: candidate.tenantId,
      capabilities: candidate.capabilities,
    });
  } catch {
    return undefined;
  }
}

function principalFromConnection(connection: ProtocolConnection): Principal | undefined {
  const authenticationCandidates = [connection.authentication, connection.auth]
    .filter((candidate): candidate is NonNullable<ProtocolConnection['authentication']> => candidate !== undefined);
  if (authenticationCandidates.length > 0) {
    for (const candidate of authenticationCandidates) {
      if (candidate.authenticated !== true) {
        // An explicit anonymous context is authoritative and must not be
        // overridden by a stray direct-principal field.
        return undefined;
      }
      const principal = normalizePrincipal(candidate.principal);
      if (principal !== undefined) {
        return principal;
      }
    }
    return undefined;
  }

  const direct = normalizePrincipal(connection.principal);
  if (direct !== undefined) {
    return direct;
  }

  return undefined;
}
