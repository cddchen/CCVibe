import type { ClientId, ConnectionId } from '../domain/ids.js';
import { parseClientId, parseConnectionId } from '../domain/ids.js';
import { parseResourceUri, type AgentResource } from '../domain/resources.js';
import { cloneAndFreeze } from '../protocol/types.js';

/** Capabilities used by the first protocol client registration. */
export interface ClientCapabilities {
  readonly partialBlocks: boolean;
  readonly approvalEdits: boolean;
}

/** Immutable public view of one logical client. */
export interface LogicalClientSnapshot<C = ClientCapabilities> {
  readonly clientId: ClientId;
  readonly activeConnectionId: ConnectionId | undefined;
  readonly subscriptions: readonly AgentResource[];
  readonly maxAcceptedClientSeq: number;
  readonly capabilities: C | undefined;
}

/** Alias kept for callers that use the domain name from the Phase 1 plan. */
export type LogicalClient<C = ClientCapabilities> = LogicalClientSnapshot<C>;

export interface LogicalClientRegistrationOptions<C = ClientCapabilities> {
  readonly capabilities?: C;
  readonly subscriptions?: readonly AgentResource[];
  readonly maxAcceptedClientSeq?: number;
}

export interface LogicalClientRegistration<C = ClientCapabilities>
  extends LogicalClientRegistrationOptions<C> {
  readonly clientId: ClientId;
  readonly connectionId: ConnectionId;
}

export interface LogicalClientRegistrationResult<C = ClientCapabilities> {
  readonly client: LogicalClientSnapshot<C>;
  readonly replacedConnectionId?: ConnectionId;
}

/** The registry intentionally retains records for the lifetime of its process. */
export interface LogicalClientRegistryOptions {
  readonly cacheLifetime?: 'process';
}

interface MutableLogicalClient<C> {
  readonly clientId: ClientId;
  activeConnectionId: ConnectionId | undefined;
  readonly subscriptions: Set<AgentResource>;
  maxAcceptedClientSeq: number;
  capabilities: C | undefined;
}

interface NormalizedRegistration<C> {
  readonly clientId: ClientId;
  readonly connectionId: ConnectionId;
  readonly hasCapabilities: boolean;
  readonly capabilities: C | undefined;
  readonly hasSubscriptions: boolean;
  readonly subscriptions: readonly AgentResource[];
  readonly hasMaxAcceptedClientSeq: boolean;
  readonly maxAcceptedClientSeq: number;
}

/**
 * Tracks stable logical clients independently from short-lived transports.
 *
 * Every mutating operation is synchronous and completes as one state
 * transition. A stale connection can never close or update the replacement
 * connection. There is deliberately no timer or automatic eviction: the
 * registry is an explicit process-lifetime cache until a later persistence or
 * lifecycle policy is introduced.
 */
export class LogicalClientRegistry<C = ClientCapabilities> {
  public readonly cacheLifetime = 'process' as const;

  private readonly clients = new Map<ClientId, MutableLogicalClient<C>>();
  private readonly activeConnections = new Map<ConnectionId, ClientId>();
  private readonly fencedConnections = new Set<ConnectionId>();

  public constructor(_options: LogicalClientRegistryOptions = {}) {}

  public get size(): number {
    return this.clients.size;
  }

  /** Register a new client, or atomically replace an existing client's transport. */
  public register(input: LogicalClientRegistration<C>): LogicalClientRegistrationResult<C>;
  public register(
    clientId: ClientId,
    connectionId: ConnectionId,
    capabilities?: C,
  ): LogicalClientRegistrationResult<C>;
  public register(
    clientId: ClientId,
    connectionId: ConnectionId,
    options: LogicalClientRegistrationOptions<C>,
  ): LogicalClientRegistrationResult<C>;
  public register(
    inputOrClientId: LogicalClientRegistration<C> | ClientId,
    connectionIdOrUndefined?: ConnectionId,
    capabilitiesOrOptions?: C | LogicalClientRegistrationOptions<C>,
  ): LogicalClientRegistrationResult<C> {
    const normalized = normalizeRegistration(inputOrClientId, connectionIdOrUndefined, capabilitiesOrOptions);
    this.assertConnectionAvailable(normalized.clientId, normalized.connectionId);
    const existing = this.clients.get(normalized.clientId);
    if (existing === undefined) {
      const client: MutableLogicalClient<C> = {
        clientId: normalized.clientId,
        activeConnectionId: normalized.connectionId,
        subscriptions: new Set(normalized.subscriptions),
        maxAcceptedClientSeq: normalized.hasMaxAcceptedClientSeq ? normalized.maxAcceptedClientSeq : 0,
        capabilities: normalized.hasCapabilities ? normalized.capabilities : undefined,
      };
      this.clients.set(normalized.clientId, client);
      this.bindConnection(client, normalized.connectionId);
      return Object.freeze({ client: this.snapshotOf(client) });
    }

    return this.replaceNormalized(existing, normalized);
  }

  /** Replace an existing logical client's active transport. */
  public replace(input: LogicalClientRegistration<C>): LogicalClientRegistrationResult<C>;
  public replace(clientId: ClientId, connectionId: ConnectionId, capabilities?: C): LogicalClientRegistrationResult<C>;
  public replace(
    clientId: ClientId,
    connectionId: ConnectionId,
    options: LogicalClientRegistrationOptions<C>,
  ): LogicalClientRegistrationResult<C>;
  public replace(
    inputOrClientId: LogicalClientRegistration<C> | ClientId,
    connectionIdOrUndefined?: ConnectionId,
    capabilitiesOrOptions?: C | LogicalClientRegistrationOptions<C>,
  ): LogicalClientRegistrationResult<C> {
    const normalized = normalizeRegistration(inputOrClientId, connectionIdOrUndefined, capabilitiesOrOptions);
    this.assertConnectionAvailable(normalized.clientId, normalized.connectionId);
    const existing = this.requireClient(normalized.clientId);
    return this.replaceNormalized(existing, normalized);
  }

  /**
   * Return whether a connection currently owns the client's fencing token.
   * This is a check only; it never changes the registry.
   */
  public fence(clientId: ClientId, connectionId: ConnectionId): boolean {
    return this.isActive(clientId, connectionId);
  }

  public isActive(clientId: ClientId, connectionId: ConnectionId): boolean {
    const client = this.clients.get(parseClientId(clientId));
    return client?.activeConnectionId === parseConnectionId(connectionId);
  }

  public isConnectionActive(connectionId: ConnectionId): boolean {
    return this.activeConnections.has(parseConnectionId(connectionId));
  }

  public isFenced(connectionId: ConnectionId): boolean {
    return this.fencedConnections.has(parseConnectionId(connectionId));
  }

  /** Throw unless the connection still owns the logical client's fence. */
  public assertActive(clientId: ClientId, connectionId: ConnectionId): void {
    if (!this.isActive(clientId, connectionId)) {
      throw new Error('connection is fenced');
    }
  }

  /**
   * Close a transport without deleting the logical client. A stale close is a
   * no-op, which makes disconnect callbacks safe after replacement.
   */
  public close(connectionId: ConnectionId): boolean;
  public close(clientId: ClientId, connectionId: ConnectionId): boolean;
  public close(firstId: ClientId | ConnectionId, secondId?: ConnectionId): boolean {
    if (secondId !== undefined) {
      const client = this.clients.get(parseClientId(firstId as ClientId));
      if (client === undefined || client.activeConnectionId !== parseConnectionId(secondId)) {
        return false;
      }
      client.activeConnectionId = undefined;
      const parsedConnectionId = parseConnectionId(secondId);
      this.activeConnections.delete(parsedConnectionId);
      this.fencedConnections.add(parsedConnectionId);
      return true;
    }

    const parsedConnectionId = parseConnectionId(firstId as ConnectionId);
    const clientId = this.activeConnections.get(parsedConnectionId);
    if (clientId === undefined) {
      return false;
    }
    const client = this.clients.get(clientId);
    if (client === undefined || client.activeConnectionId !== parsedConnectionId) {
      this.activeConnections.delete(parsedConnectionId);
      return false;
    }
    client.activeConnectionId = undefined;
    this.activeConnections.delete(parsedConnectionId);
    this.fencedConnections.add(parsedConnectionId);
    return true;
  }

  /** Replace the complete logical subscription set, preserving input order and removing duplicates. */
  public replaceSubscriptions(
    clientId: ClientId,
    connectionId: ConnectionId,
    resources: readonly AgentResource[],
  ): LogicalClientSnapshot<C> {
    const client = this.requireActiveClient(clientId, connectionId);
    const normalized = normalizeResources(resources);
    client.subscriptions.clear();
    for (const resource of normalized) {
      client.subscriptions.add(resource);
    }
    return this.snapshotOf(client);
  }

  /** Add one logical subscription. Returns whether it was newly added. */
  public addSubscription(clientId: ClientId, connectionId: ConnectionId, resource: AgentResource): boolean {
    const client = this.requireActiveClient(clientId, connectionId);
    const normalized = normalizeResource(resource);
    const alreadyPresent = client.subscriptions.has(normalized);
    client.subscriptions.add(normalized);
    return !alreadyPresent;
  }

  /** Remove one logical subscription. */
  public removeSubscription(clientId: ClientId, connectionId: ConnectionId, resource: AgentResource): boolean {
    const client = this.requireActiveClient(clientId, connectionId);
    return client.subscriptions.delete(normalizeResource(resource));
  }

  public getSubscriptions(clientId: ClientId): readonly AgentResource[] {
    return this.snapshotOf(this.requireClient(clientId)).subscriptions;
  }

  /** Record a client sequence without making clientSeq the command identity. */
  public recordClientSeq(clientId: ClientId, connectionId: ConnectionId, clientSeq: number): number {
    const client = this.requireActiveClient(clientId, connectionId);
    assertPositiveSafeInteger(clientSeq, 'clientSeq');
    if (clientSeq > client.maxAcceptedClientSeq) {
      client.maxAcceptedClientSeq = clientSeq;
    }
    return client.maxAcceptedClientSeq;
  }

  /**
   * Record a sequence for a command that was already accepted while its
   * transport held the fence. The stable logical record must survive a
   * subsequent send failure or connection replacement.
   */
  public recordProcessedClientSeq(clientId: ClientId, clientSeq: number): number {
    const client = this.requireClient(clientId);
    assertPositiveSafeInteger(clientSeq, 'clientSeq');
    if (clientSeq > client.maxAcceptedClientSeq) {
      client.maxAcceptedClientSeq = clientSeq;
    }
    return client.maxAcceptedClientSeq;
  }

  public updateMaxAcceptedClientSeq(clientId: ClientId, connectionId: ConnectionId, clientSeq: number): number {
    return this.recordClientSeq(clientId, connectionId, clientSeq);
  }

  public acceptClientSeq(clientId: ClientId, connectionId: ConnectionId, clientSeq: number): boolean {
    const previous = this.getMaxAcceptedClientSeq(clientId);
    this.recordClientSeq(clientId, connectionId, clientSeq);
    return clientSeq > previous;
  }

  public getMaxAcceptedClientSeq(clientId: ClientId): number {
    return this.requireClient(clientId).maxAcceptedClientSeq;
  }

  /** Return a fresh immutable snapshot, or undefined for an unknown client. */
  public snapshot(clientId: ClientId): LogicalClientSnapshot<C> | undefined {
    const client = this.clients.get(parseClientId(clientId));
    return client === undefined ? undefined : this.snapshotOf(client);
  }

  public get(clientId: ClientId): LogicalClientSnapshot<C> | undefined {
    return this.snapshot(clientId);
  }

  /** Return immutable snapshots in deterministic registration order. */
  public snapshots(): readonly LogicalClientSnapshot<C>[] {
    const snapshots: LogicalClientSnapshot<C>[] = [];
    for (const client of this.clients.values()) {
      snapshots.push(this.snapshotOf(client));
    }
    return Object.freeze(snapshots);
  }

  private replaceNormalized(
    client: MutableLogicalClient<C>,
    normalized: NormalizedRegistration<C>,
  ): LogicalClientRegistrationResult<C> {
    const previousConnectionId = client.activeConnectionId;
    if (previousConnectionId !== normalized.connectionId) {
      this.unbindConnection(client, previousConnectionId);
      if (previousConnectionId !== undefined) {
        this.fencedConnections.add(previousConnectionId);
      }
      this.bindConnection(client, normalized.connectionId);
    }
    client.activeConnectionId = normalized.connectionId;
    if (normalized.hasCapabilities) {
      client.capabilities = normalized.capabilities;
    }
    if (normalized.hasSubscriptions) {
      client.subscriptions.clear();
      for (const resource of normalized.subscriptions) {
        client.subscriptions.add(resource);
      }
    }
    if (normalized.hasMaxAcceptedClientSeq && normalized.maxAcceptedClientSeq > client.maxAcceptedClientSeq) {
      client.maxAcceptedClientSeq = normalized.maxAcceptedClientSeq;
    }

    const snapshot = this.snapshotOf(client);
    if (previousConnectionId === undefined || previousConnectionId === normalized.connectionId) {
      return Object.freeze({ client: snapshot });
    }
    return Object.freeze({
      client: snapshot,
      replacedConnectionId: previousConnectionId,
    });
  }

  private assertConnectionAvailable(clientId: ClientId, connectionId: ConnectionId): void {
    if (this.fencedConnections.has(connectionId)) {
      throw new Error('connection is fenced');
    }
    const boundClientId = this.activeConnections.get(connectionId);
    if (boundClientId !== undefined && boundClientId !== clientId) {
      throw new Error('connection is already bound to another client');
    }
  }

  private bindConnection(client: MutableLogicalClient<C>, connectionId: ConnectionId): void {
    this.assertConnectionAvailable(client.clientId, connectionId);
    client.activeConnectionId = connectionId;
    this.activeConnections.set(connectionId, client.clientId);
  }

  private unbindConnection(client: MutableLogicalClient<C>, connectionId: ConnectionId | undefined): void {
    if (connectionId !== undefined && this.activeConnections.get(connectionId) === client.clientId) {
      this.activeConnections.delete(connectionId);
    }
  }

  private requireClient(clientId: ClientId): MutableLogicalClient<C> {
    const parsedClientId = parseClientId(clientId);
    const client = this.clients.get(parsedClientId);
    if (client === undefined) {
      throw new Error('logical client is not registered');
    }
    return client;
  }

  private requireActiveClient(clientId: ClientId, connectionId: ConnectionId): MutableLogicalClient<C> {
    const client = this.requireClient(clientId);
    this.assertActive(client.clientId, connectionId);
    return client;
  }

  private snapshotOf(client: MutableLogicalClient<C>): LogicalClientSnapshot<C> {
    const subscriptions = Object.freeze([...client.subscriptions]);
    const capabilities = client.capabilities === undefined ? undefined : cloneAndFreeze(client.capabilities);
    return Object.freeze({
      clientId: client.clientId,
      activeConnectionId: client.activeConnectionId,
      subscriptions,
      maxAcceptedClientSeq: client.maxAcceptedClientSeq,
      capabilities,
    });
  }
}

function normalizeRegistration<C>(
  inputOrClientId: LogicalClientRegistration<C> | ClientId,
  connectionIdOrUndefined: ConnectionId | undefined,
  capabilitiesOrOptions: C | LogicalClientRegistrationOptions<C> | undefined,
): NormalizedRegistration<C> {
  let clientId: ClientId;
  let connectionId: ConnectionId;
  let options: LogicalClientRegistrationOptions<C>;

  if (typeof inputOrClientId === 'object') {
    clientId = inputOrClientId.clientId;
    connectionId = inputOrClientId.connectionId;
    options = inputOrClientId;
  } else {
    if (connectionIdOrUndefined === undefined) {
      throw new TypeError('connectionId is required');
    }
    clientId = inputOrClientId;
    connectionId = connectionIdOrUndefined;
    options = positionalOptions(capabilitiesOrOptions);
  }

  const parsedClientId = parseClientId(clientId);
  const parsedConnectionId = parseConnectionId(connectionId);
  const hasCapabilities = Object.prototype.hasOwnProperty.call(options, 'capabilities');
  const hasSubscriptions = Object.prototype.hasOwnProperty.call(options, 'subscriptions');
  const hasMaxAcceptedClientSeq = Object.prototype.hasOwnProperty.call(options, 'maxAcceptedClientSeq');
  const subscriptions = hasSubscriptions ? normalizeResources(options.subscriptions ?? []) : [];
  const maxAcceptedClientSeq = options.maxAcceptedClientSeq ?? 0;
  if (hasMaxAcceptedClientSeq) {
    assertNonNegativeSafeInteger(maxAcceptedClientSeq, 'maxAcceptedClientSeq');
  }

  return {
    clientId: parsedClientId,
    connectionId: parsedConnectionId,
    hasCapabilities,
    capabilities:
      hasCapabilities && options.capabilities !== undefined
        ? cloneAndFreeze(options.capabilities)
        : undefined,
    hasSubscriptions,
    subscriptions,
    hasMaxAcceptedClientSeq,
    maxAcceptedClientSeq,
  };
}

function positionalOptions<C>(value: C | LogicalClientRegistrationOptions<C> | undefined): LogicalClientRegistrationOptions<C> {
  if (value === undefined) {
    return {};
  }
  if (isRegistrationOptions(value)) {
    return value;
  }
  return { capabilities: value };
}

function isRegistrationOptions<C>(value: C | LogicalClientRegistrationOptions<C>): value is LogicalClientRegistrationOptions<C> {
  return typeof value === 'object' && value !== null && (
    Object.prototype.hasOwnProperty.call(value, 'capabilities') ||
    Object.prototype.hasOwnProperty.call(value, 'subscriptions') ||
    Object.prototype.hasOwnProperty.call(value, 'maxAcceptedClientSeq')
  );
}

function normalizeResources(resources: readonly AgentResource[]): readonly AgentResource[] {
  const normalized: AgentResource[] = [];
  const seen = new Set<AgentResource>();
  for (const resource of resources) {
    const parsed = normalizeResource(resource);
    if (!seen.has(parsed)) {
      seen.add(parsed);
      normalized.push(parsed);
    }
  }
  return Object.freeze(normalized);
}

function normalizeResource(resource: AgentResource): AgentResource {
  return parseResourceUri(resource).uri;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
