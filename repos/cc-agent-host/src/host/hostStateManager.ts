import { CHAT_ACTION_TYPES, type ChatAction } from '../domain/actions.js';
import { chatReducer, createChatState } from '../domain/chatReducer.js';
import type { ChatState } from '../domain/chat.js';
import type { ChatUri, RootUri } from '../domain/ids.js';
import { parseChatUri, parseResourceUri, parseRootUri, type AgentResource } from '../domain/resources.js';
import { CATALOG_ACTION_TYPES, catalogReducer, type CatalogAction } from '../catalog/reducer.js';
import type { RootCatalogState } from '../catalog/types.js';
import {
  canReplayFrom,
  ReplayBuffer,
} from '../protocol/replayBuffer.js';
import {
  cloneAndFreeze,
  type DeepReadonly,
  type ActionOrigin,
  type ActionEnvelope,
  type ChatActionEnvelope,
  type ChatReconnectResult,
  type ChatStateSnapshot,
  type ReconnectResult,
  type StateSnapshot,
} from '../protocol/types.js';

const CHAT_ACTION_TYPE_SET = new Set<string>(Object.values(CHAT_ACTION_TYPES));

function assertChatUri(resource: ChatUri): void {
  parseChatUri(resource);
}

function assertChatAction(action: ChatAction): void {
  const candidate: unknown = action;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('type' in candidate) ||
    typeof candidate.type !== 'string' ||
    !CHAT_ACTION_TYPE_SET.has(candidate.type)
  ) {
    throw new TypeError('action is not a valid chat action');
  }
}

const CATALOG_ACTION_TYPE_SET = new Set<string>(Object.values(CATALOG_ACTION_TYPES));

function assertRootUri(resource: RootUri): void {
  parseRootUri(resource);
}

function assertCatalogAction(action: CatalogAction): void {
  const candidate: unknown = action;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || !('type' in candidate)
    || typeof candidate.type !== 'string'
    || !CATALOG_ACTION_TYPE_SET.has(candidate.type)
  ) {
    throw new TypeError('action is not a valid catalog action');
  }
}

/** Listener return values are ignored; promise-like results are observed for rejection. */
export type EnvelopeListener = (envelope: ChatActionEnvelope) => unknown;
export type HostAction = ChatAction | CatalogAction;
export type HostState = ChatState | RootCatalogState;
export type HostActionEnvelope = ActionEnvelope<HostAction, AgentResource>;
export type HostStateSnapshot = StateSnapshot<HostState, AgentResource>;
export type HostReconnectResult = ReconnectResult<HostAction, HostState, AgentResource>;
export type HostEnvelopeListener = (envelope: HostActionEnvelope) => unknown;
export type ListenerErrorReporter = (error: unknown) => unknown;

export interface HostStateManagerDeps {
  readonly now: () => string;
  readonly replayCapacity: number;
  readonly onListenerError?: ListenerErrorReporter;
}

export class HostStateManager {
  private readonly now: () => string;
  private readonly onListenerError: ListenerErrorReporter | undefined;
  private readonly states = new Map<ChatUri, ChatState>();
  private readonly catalogStates = new Map<RootUri, RootCatalogState>();
  private readonly channelsWithActions = new Set<AgentResource>();
  private readonly replayBuffer: ReplayBuffer<HostAction, AgentResource>;
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly hostListeners = new Set<HostEnvelopeListener>();
  private readonly pendingEmissions: HostActionEnvelope[] = [];
  private emitting = false;
  private _serverSeq = 0;

  public constructor(deps: HostStateManagerDeps, onEnvelope?: EnvelopeListener) {
    this.now = deps.now;
    this.onListenerError = deps.onListenerError;
    this.replayBuffer = new ReplayBuffer<HostAction, AgentResource>({ maxActions: deps.replayCapacity });
    if (onEnvelope !== undefined) {
      this.listeners.add(onEnvelope);
    }
  }

  public get serverSeq(): number {
    return this._serverSeq;
  }

  public get currentServerSeq(): number {
    return this._serverSeq;
  }

  public subscribe(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to the unified host stream, including root catalog actions. */
  public subscribeAll(listener: HostEnvelopeListener): () => void {
    this.hostListeners.add(listener);
    return () => {
      this.hostListeners.delete(listener);
    };
  }

  public registerChat(resource: ChatUri, initialState: ChatState = createChatState({ resource })): void {
    assertChatUri(resource);
    if (initialState.resource !== undefined) {
      assertChatUri(initialState.resource);
    }
    if (this.states.has(resource)) {
      throw new TypeError('chat resource is already registered');
    }
    if (initialState.resource !== undefined && initialState.resource !== resource) {
      throw new TypeError('chat state resource does not match its channel');
    }
    const state = initialState.resource === undefined ? { ...initialState, resource } : initialState;
    this.states.set(resource, cloneAndFreeze(state));
  }

  public registerCatalog(resource: RootUri, initialState: RootCatalogState): void {
    assertRootUri(resource);
    if (initialState.resource !== resource) {
      throw new TypeError('catalog state resource does not match its channel');
    }
    if (this.catalogStates.has(resource)) {
      throw new TypeError('catalog resource is already registered');
    }
    this.catalogStates.set(resource, cloneAndFreeze(initialState));
  }

  /**
   * Forget one registered chat after its durable overlay has been deleted.
   *
   * This is deliberately a memory-only operation: callers own the persistence
   * transaction boundary and must invoke it only after that transaction has
   * committed. Replay history is retained so an in-flight reconnect can still
   * receive the actions that preceded deletion, while the missing state makes
   * the channel unavailable to subsequent subscriptions.
   */
  public unregisterChat(resource: ChatUri): boolean {
    assertChatUri(resource);
    const removed = this.states.delete(resource);
    this.channelsWithActions.delete(resource);
    return removed;
  }

  public getState(resource: ChatUri): ChatState | undefined {
    assertChatUri(resource);
    return this.states.get(resource);
  }

  public getCatalogState(resource: RootUri): RootCatalogState | undefined {
    assertRootUri(resource);
    return this.catalogStates.get(resource);
  }

  public snapshot(resource: ChatUri): ChatStateSnapshot | undefined {
    assertChatUri(resource);
    return this.snapshotAt(resource, this._serverSeq);
  }

  public getSnapshot(resource: ChatUri): ChatStateSnapshot | undefined {
    return this.snapshot(resource);
  }

  public snapshotResource(resource: AgentResource): HostStateSnapshot | undefined {
    const parsed = parseResourceUri(resource);
    return this.snapshotResourceAt(parsed.uri, this._serverSeq);
  }

  /** Capture one or more registered resources at the same global sequence cut. */
  public snapshotResources(resources: readonly AgentResource[]): {
    readonly snapshots: readonly HostStateSnapshot[];
    readonly missing: readonly AgentResource[];
    readonly throughSeq: number;
    readonly serverSeq: number;
  } {
    const throughSeq = this._serverSeq;
    const snapshots: HostStateSnapshot[] = [];
    const missing: AgentResource[] = [];
    const seen = new Set<AgentResource>();
    for (const resource of resources) {
      const parsed = parseResourceUri(resource);
      if (seen.has(parsed.uri)) {
        continue;
      }
      seen.add(parsed.uri);
      const snapshot = this.snapshotResourceAt(parsed.uri, throughSeq);
      if (snapshot === undefined) {
        missing.push(parsed.uri);
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

  public dispatch(
    channel: ChatUri,
    action: ChatAction,
    origin?: ActionOrigin,
  ): ChatActionEnvelope | undefined {
    assertChatUri(channel);
    assertChatAction(action);
    const current = this.states.get(channel);
    const baseState = current ?? createChatState({ resource: channel });
    const immutableAction = cloneAndFreeze(action);
    const reduced = chatReducer(baseState, immutableAction);

    if (reduced === baseState) {
      return undefined;
    }
    if (this._serverSeq >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('serverSeq has reached the maximum safe integer');
    }

    const committedState = cloneAndFreeze(reduced);
    const serverSeq = this._serverSeq + 1;
    const serverTime = this.now();
    const envelope: ChatActionEnvelope =
      origin === undefined
        ? cloneAndFreeze({ channel, action: immutableAction, serverSeq, serverTime })
        : cloneAndFreeze({
            channel,
            action: immutableAction,
            serverSeq,
            serverTime,
            origin,
          });

    this.states.set(channel, committedState);
    this._serverSeq = serverSeq;
    this.replayBuffer.append(envelope);
    this.channelsWithActions.add(channel);
    this.emit(envelope);
    return envelope;
  }

  public dispatchCatalog(
    channel: RootUri,
    action: CatalogAction,
    origin?: ActionOrigin,
  ): ActionEnvelope<CatalogAction, RootUri> | undefined {
    assertRootUri(channel);
    assertCatalogAction(action);
    const current = this.catalogStates.get(channel);
    if (current === undefined) {
      throw new Error('catalog resource is not registered');
    }
    const immutableAction = cloneAndFreeze(action);
    const reduced = catalogReducer(current, immutableAction);
    if (reduced === current) {
      return undefined;
    }
    // Prepare and validate the clocked envelope before mutating state. The
    // replay append is still performed before publication, so a failed
    // commit cannot consume a sequence or expose a half-committed action.
    const envelope = this.commitEnvelope(channel, immutableAction, origin);
    this.replayBuffer.append(envelope);
    this.catalogStates.set(channel, cloneAndFreeze(reduced));
    this._serverSeq = envelope.serverSeq;
    this.channelsWithActions.add(channel);
    this.emit(envelope);
    return envelope as ActionEnvelope<CatalogAction, RootUri>;
  }

  /** Commit a root refresh as one state transaction while preserving action fanout. */
  public dispatchCatalogBatch(
    channel: RootUri,
    actions: readonly CatalogAction[],
    origin?: ActionOrigin,
  ): readonly ActionEnvelope<CatalogAction, RootUri>[] {
    assertRootUri(channel);
    const current = this.catalogStates.get(channel);
    if (current === undefined) {
      throw new Error('catalog resource is not registered');
    }

    let reduced = current;
    const changed: Array<{ readonly action: CatalogAction; readonly state: RootCatalogState }> = [];
    for (const action of actions) {
      assertCatalogAction(action);
      const immutableAction = cloneAndFreeze(action) as CatalogAction;
      const next = catalogReducer(reduced, immutableAction);
      if (next !== reduced) {
        changed.push({ action: immutableAction, state: next });
        reduced = next;
      }
    }
    if (changed.length === 0) {
      return Object.freeze([]);
    }

    let nextServerSeq = this._serverSeq;
    const envelopes: Array<ActionEnvelope<CatalogAction, RootUri>> = [];
    for (const item of changed) {
      if (nextServerSeq >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('serverSeq has reached the maximum safe integer');
      }
      nextServerSeq += 1;
      const serverTime = this.now();
      envelopes.push(origin === undefined
        ? cloneAndFreeze({
            channel,
            action: item.action,
            serverSeq: nextServerSeq,
            serverTime,
          })
        : cloneAndFreeze({
            channel,
            action: item.action,
            serverSeq: nextServerSeq,
            serverTime,
            origin,
          }));
    }

    for (const envelope of envelopes) {
      this.replayBuffer.append(envelope);
    }
    this.catalogStates.set(channel, cloneAndFreeze(reduced));
    this._serverSeq = nextServerSeq;
    this.channelsWithActions.add(channel);
    for (const envelope of envelopes) {
      this.emit(envelope);
    }
    return Object.freeze(envelopes);
  }

  public reconnect(lastSeenServerSeq: number, channels: ReadonlySet<ChatUri>): ChatReconnectResult {
    for (const channel of channels) {
      assertChatUri(channel);
    }
    return this.reconnectResources(lastSeenServerSeq, channels) as ChatReconnectResult;
  }

  public reconnectResources(
    lastSeenServerSeq: number,
    resources: ReadonlySet<AgentResource>,
  ): HostReconnectResult {
    const missing: AgentResource[] = [];
    for (const resource of resources) {
      parseResourceUri(resource);
      if (!this.hasResource(resource)) {
        missing.push(resource);
      }
    }

    const immutableMissing = cloneAndFreeze(missing);
    const hasRegisteredChannelWithoutActionHistory = [...resources].some(
      (resource) => this.hasResource(resource) && !this.channelsWithActions.has(resource),
    );
    if (
      !hasRegisteredChannelWithoutActionHistory
      && canReplayFrom(this.replayBuffer.oldestBufferedSeq, this._serverSeq, lastSeenServerSeq)
    ) {
      return cloneAndFreeze({
        type: 'replay',
        actions: this.replayBuffer.replayAfter(lastSeenServerSeq, resources),
        missing: immutableMissing,
        throughSeq: this._serverSeq,
        serverSeq: this._serverSeq,
      });
    }

    const fromSeq = this._serverSeq;
    const snapshots: HostStateSnapshot[] = [];
    for (const resource of resources) {
      const snapshot = this.snapshotResourceAt(resource, fromSeq);
      if (snapshot !== undefined) {
        snapshots.push(snapshot);
      }
    }

    return cloneAndFreeze({
      type: 'snapshot',
      snapshots,
      missing: immutableMissing,
      throughSeq: this._serverSeq,
      serverSeq: this._serverSeq,
    });
  }

  private emit(envelope: HostActionEnvelope): void {
    this.pendingEmissions.push(envelope);
    if (this.emitting) {
      return;
    }

    this.emitting = true;
    try {
      while (this.pendingEmissions.length > 0) {
        const next = this.pendingEmissions.shift();
        if (next === undefined) {
          continue;
        }
        for (const listener of [...this.hostListeners]) {
          try {
            const result: unknown = listener(next);
            if (result !== undefined) {
              void Promise.resolve(result).catch((error: unknown) => {
                this.reportListenerError(error);
              });
            }
          } catch (error) {
            this.reportListenerError(error);
          }
        }
        if (next.channel.startsWith('agent-chat://')) {
          for (const listener of [...this.listeners]) {
            if (this.hostListeners.has(listener as unknown as HostEnvelopeListener)) {
              continue;
            }
            try {
              const result: unknown = listener(next as ChatActionEnvelope);
              if (result !== undefined) {
                void Promise.resolve(result).catch((error: unknown) => {
                  this.reportListenerError(error);
                });
              }
            } catch (error) {
              this.reportListenerError(error);
            }
          }
        }
      }
    } finally {
      this.emitting = false;
    }
  }

  private reportListenerError(error: unknown): void {
    if (this.onListenerError === undefined) {
      return;
    }

    try {
      const result: unknown = this.onListenerError(error);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          // Async listener error reporting must not produce unhandled rejections.
        });
      }
    } catch {
      // Listener error reporting must not affect fanout or dispatch.
    }
  }

  private snapshotAt(resource: ChatUri, fromSeq: number): ChatStateSnapshot | undefined {
    const state = this.states.get(resource);
    if (state === undefined) {
      return undefined;
    }

    return cloneAndFreeze({
      resource,
      state,
      fromSeq,
    });
  }

  public snapshotResourceAt(resource: AgentResource, fromSeq: number): HostStateSnapshot | undefined {
    const parsed = parseResourceUri(resource);
    const state = parsed.kind === 'chat'
      ? this.states.get(parsed.uri)
      : parsed.kind === 'root'
        ? this.catalogStates.get(parsed.uri)
        : undefined;
    if (state === undefined) {
      return undefined;
    }
    return cloneAndFreeze({ resource: parsed.uri, state, fromSeq });
  }

  private hasResource(resource: AgentResource): boolean {
    const parsed = parseResourceUri(resource);
    return parsed.kind === 'chat'
      ? this.states.has(parsed.uri)
      : parsed.kind === 'root' && this.catalogStates.has(parsed.uri);
  }

  private commitEnvelope<A extends HostAction, R extends AgentResource>(
    channel: R,
    action: A,
    origin?: ActionOrigin,
  ): ActionEnvelope<A, R> {
    if (this._serverSeq >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('serverSeq has reached the maximum safe integer');
    }
    const serverSeq = this._serverSeq + 1;
    const serverTime = this.now();
    const immutableAction = cloneAndFreeze(action) as DeepReadonly<A>;
    const envelope = origin === undefined
      ? cloneAndFreeze({ channel, action: immutableAction, serverSeq, serverTime })
      : cloneAndFreeze({ channel, action: immutableAction, serverSeq, serverTime, origin });
    return envelope;
  }
}
