import type { ChatAction } from '../domain/actions.js';
import type { ChatState } from '../domain/chat.js';
import type { ChatUri } from '../domain/ids.js';
import { parseResourceUri, resourceKind, type AgentResource } from '../domain/resources.js';
import type { HostAction, HostState } from '../host/hostStateManager.js';
import { MAX_HOST_EPOCH_BYTES, utf8ByteLength } from './limits.js';
import { HostStateManager } from '../host/hostStateManager.js';
import {
  cloneAndFreeze,
  type ActionEnvelope,
  type ReconnectResult,
  type StateSnapshot,
} from './types.js';

/** A small transport-neutral lifetime handle for a state listener. */
export interface Disposable {
  dispose(): void;
}

/** A set of snapshots captured at one Host sequence cut. */
export interface SnapshotBatch<
  S = ChatState,
  R extends AgentResource = AgentResource,
> {
  readonly snapshots: readonly StateSnapshot<S, R>[];
  readonly missing: readonly R[];
  readonly throughSeq: number;
  readonly serverSeq: number;
}

/**
 * The state surface needed by a protocol handler.
 *
 * The resource and state/action parameters deliberately remain generic. The
 * Phase 1 chat adapter reports root and session resources as missing rather
 * than inventing state for them.
 */
export interface ProtocolStateProvider<
  A = ChatAction,
  S = ChatState,
  R extends AgentResource = AgentResource,
> {
  readonly serverSeq: number;
  /** Providers that have a host epoch expose it; Phase 0 providers may omit it. */
  readonly hostEpoch?: string;
  snapshot(resource: R): StateSnapshot<S, R> | undefined;
  snapshots(resources: readonly R[]): SnapshotBatch<S, R>;
  reconnect(lastSeen: number, resources: ReadonlySet<R>): ReconnectResult<A, S, R>;
  onAction(listener: (envelope: ActionEnvelope<A, R>) => void): Disposable;
}

export interface ChatHostStateProviderOptions {
  readonly hostEpoch: string;
}

export type HostStateProviderOptions = ChatHostStateProviderOptions;

type HostProviderSnapshot = StateSnapshot<HostState, AgentResource>;
type HostProviderActionEnvelope = ActionEnvelope<HostAction, AgentResource>;
type HostProviderReconnectResult = ReconnectResult<HostAction, HostState, AgentResource> & {
  readonly hostEpoch: string;
};

/**
 * Adapts the chat-only Phase 0 HostStateManager to the generic protocol state
 * provider surface. Root and session resources are intentionally not backed by
 * this adapter and are returned in `missing`.
 */
export class ChatHostStateProvider implements ProtocolStateProvider<HostAction, HostState, AgentResource> {
  private readonly host: HostStateManager;
  private readonly _hostEpoch: string;

  public constructor(host: HostStateManager, hostEpoch: string);
  public constructor(host: HostStateManager, options: ChatHostStateProviderOptions);
  public constructor(host: HostStateManager, hostEpochOrOptions: string | ChatHostStateProviderOptions) {
    this.host = host;
    const hostEpoch =
      typeof hostEpochOrOptions === 'string' ? hostEpochOrOptions : hostEpochOrOptions.hostEpoch;
    assertHostEpoch(hostEpoch);
    this._hostEpoch = hostEpoch;
  }

  public get serverSeq(): number {
    return this.host.serverSeq;
  }

  public get hostEpoch(): string {
    return this._hostEpoch;
  }

  public snapshot(resource: AgentResource): HostProviderSnapshot | undefined {
    const parsed = parseResourceUri(resource);
    if (parsed.kind !== 'chat') {
      return undefined;
    }

    return this.host.snapshot(parsed.uri);
  }

  public snapshots(resources: readonly AgentResource[]): SnapshotBatch<HostState, AgentResource> {
    const snapshots: HostProviderSnapshot[] = [];
    const missing: AgentResource[] = [];
    const seen = new Set<AgentResource>();
    const throughSeq = this.host.serverSeq;

    for (const resource of resources) {
      if (seen.has(resource)) {
        continue;
      }
      seen.add(resource);

      const snapshot = this.snapshot(resource);
      if (snapshot === undefined) {
        missing.push(resource);
      } else {
        snapshots.push(snapshot);
      }
    }

    return cloneAndFreeze({
      snapshots,
      missing,
      throughSeq,
      serverSeq: throughSeq,
    });
  }

  public reconnect(lastSeen: number, resources: ReadonlySet<AgentResource>): HostProviderReconnectResult {
    const chatResources = new Set<ChatUri>();
    const orderedResources: AgentResource[] = [];
    for (const resource of resources) {
      // Parse before narrowing so a forged branded value cannot bypass the
      // resource-kind split at this orchestration boundary.
      const parsed = parseResourceUri(resource);
      orderedResources.push(resource);
      if (parsed.kind === 'chat') {
        chatResources.add(parsed.uri);
      }
    }

    const chatResult = this.host.reconnectResources(lastSeen, chatResources);
    const chatMissing = new Set<AgentResource>(chatResult.missing);
    const missing: AgentResource[] = [];
    for (const resource of orderedResources) {
      if (resourceKind(resource) !== 'chat' || chatMissing.has(resource)) {
        missing.push(resource);
      }
    }

    if (chatResult.type === 'replay') {
      return cloneAndFreeze({
        type: 'replay',
        actions: chatResult.actions,
        missing,
        throughSeq: chatResult.throughSeq,
        serverSeq: chatResult.serverSeq,
        hostEpoch: this._hostEpoch,
      });
    }

    return cloneAndFreeze({
      type: 'snapshot',
        snapshots: chatResult.snapshots,
      missing,
      throughSeq: chatResult.throughSeq,
      serverSeq: chatResult.serverSeq,
      hostEpoch: this._hostEpoch,
    });
  }

  public onAction(listener: (envelope: HostProviderActionEnvelope) => void): Disposable {
    const unsubscribe = this.host.subscribe((envelope) => listener(envelope));
    return Object.freeze({ dispose: unsubscribe });
  }
}

/** Unified provider for chat and the root catalog resource. */
export class HostStateProvider implements ProtocolStateProvider<HostAction, HostState, AgentResource> {
  private readonly host: HostStateManager;
  private readonly _hostEpoch: string;

  public constructor(host: HostStateManager, hostEpoch: string);
  public constructor(host: HostStateManager, options: HostStateProviderOptions);
  public constructor(host: HostStateManager, hostEpochOrOptions: string | HostStateProviderOptions) {
    this.host = host;
    const hostEpoch = typeof hostEpochOrOptions === 'string'
      ? hostEpochOrOptions
      : hostEpochOrOptions.hostEpoch;
    assertHostEpoch(hostEpoch);
    this._hostEpoch = hostEpoch;
  }

  public get serverSeq(): number {
    return this.host.serverSeq;
  }

  public get hostEpoch(): string {
    return this._hostEpoch;
  }

  public snapshot(resource: AgentResource): StateSnapshot<HostState, AgentResource> | undefined {
    const parsed = parseResourceUri(resource);
    if (parsed.kind === 'session') {
      return undefined;
    }
    return this.host.snapshotResource(parsed.uri);
  }

  public snapshots(resources: readonly AgentResource[]): SnapshotBatch<HostState, AgentResource> {
    return this.host.snapshotResources(resources);
  }

  public reconnect(lastSeen: number, resources: ReadonlySet<AgentResource>): ReconnectResult<HostAction, HostState, AgentResource> {
    const result = this.host.reconnectResources(lastSeen, resources);
    return cloneAndFreeze({ ...result, hostEpoch: this._hostEpoch });
  }

  public onAction(listener: (envelope: ActionEnvelope<HostAction, AgentResource>) => void): Disposable {
    return Object.freeze({ dispose: this.host.subscribeAll(listener) });
  }
}

export { HostStateProvider as CatalogHostStateProvider, HostStateProvider as RootCatalogStateProvider };

function assertHostEpoch(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('hostEpoch must be a non-empty string');
  }
  if (utf8ByteLength(value) > MAX_HOST_EPOCH_BYTES) {
    throw new RangeError('hostEpoch exceeds the maximum length');
  }
}
