import {
  applyHostChatAction,
  applyHostRootCatalogAction,
  type HostResourceState,
} from '../domain/hostReducer';
import {
  parseResourceUri,
  type AgentResource,
  type ChatUri,
  type RootUri,
} from '../protocol/resourceUri';
import type {
  HostActionEnvelope,
  HostInitializeResult,
  HostReconnectResult,
  HostStateSnapshot,
} from '../protocol/hostWire';
import { decideServerSeqApply } from './serverSeq';

export type SyncConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'paused'
  | 'replaced'
  | 'error';

export interface SyncState {
  readonly status: SyncConnectionStatus;
  readonly address?: string;
  readonly hostEpoch?: string;
  readonly lastSeenServerSeq: number;
  readonly subscriptions: readonly AgentResource[];
  readonly resources: readonly HostResourceState[];
  readonly missing: readonly AgentResource[];
  readonly errorCode?: string;
  readonly replacementReason?: string;
  readonly updatedAt?: string;
}

export type SyncCommand =
  | { readonly type: 'connection/status'; readonly status: SyncConnectionStatus; readonly errorCode?: string; readonly updatedAt?: string }
  | { readonly type: 'initialize/succeeded'; readonly result: HostInitializeResult; readonly requestedSubscriptions: readonly string[] }
  | { readonly type: 'reconnect/succeeded'; readonly result: HostReconnectResult }
  | { readonly type: 'subscription/succeeded'; readonly snapshot: HostStateSnapshot }
  | { readonly type: 'subscription/removed'; readonly resource: AgentResource }
  | { readonly type: 'state/action'; readonly envelope: HostActionEnvelope }
  | { readonly type: 'client/replaced'; readonly reason: string };

export interface SyncStore {
  getState(): SyncState;
  dispatch(command: SyncCommand): SyncState;
  subscribe(listener: (state: SyncState) => void): () => void;
}

export interface CreateSyncStateOptions {
  readonly address?: string;
  readonly subscriptions?: readonly string[];
  readonly updatedAt?: string;
}

export function createSyncState(options: CreateSyncStateOptions = {}): SyncState {
  const subscriptions = uniqueResources(options.subscriptions ?? ['agent-root://']);
  return freezeState({
    status: 'idle',
    ...(options.address === undefined ? {} : { address: options.address }),
    hostEpoch: undefined,
    lastSeenServerSeq: 0,
    subscriptions,
    resources: [],
    missing: [],
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
  });
}

export function reduceSyncCommand(state: SyncState, command: SyncCommand): SyncState {
  switch (command.type) {
    case 'connection/status':
      return setSyncStatus(state, command.status, {
        ...(command.errorCode === undefined ? {} : { errorCode: command.errorCode }),
        ...(command.updatedAt === undefined ? {} : { updatedAt: command.updatedAt }),
      });
    case 'initialize/succeeded':
      return applyInitializeResult(state, command.result, command.requestedSubscriptions);
    case 'reconnect/succeeded':
      return applyReconnectResult(state, command.result);
    case 'subscription/succeeded':
      return applySubscriptionSnapshot(state, command.snapshot);
    case 'subscription/removed':
      return removeSubscription(state, command.resource);
    case 'state/action':
      return applyHostAction(state, command.envelope);
    case 'client/replaced':
      return setSyncStatus(state, 'replaced', { replacementReason: command.reason });
  }
}

export function createSyncStore(options: CreateSyncStateOptions = {}): SyncStore {
  let state = createSyncState(options);
  const listeners = new Set<(next: SyncState) => void>();
  return Object.freeze({
    getState: () => state,
    dispatch: (command: SyncCommand) => {
      const next = reduceSyncCommand(state, command);
      if (next !== state) {
        state = next;
        for (const listener of [...listeners]) listener(state);
      }
      return state;
    },
    subscribe: (listener: (next: SyncState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function setSyncStatus(
  state: SyncState,
  status: SyncConnectionStatus,
  details: { readonly errorCode?: string; readonly replacementReason?: string; readonly updatedAt?: string } = {},
): SyncState {
  return freezeState({
    ...state,
    status,
    ...(details.errorCode === undefined ? { errorCode: undefined } : { errorCode: details.errorCode }),
    ...(details.replacementReason === undefined ? { replacementReason: undefined } : { replacementReason: details.replacementReason }),
    ...(details.updatedAt === undefined ? {} : { updatedAt: details.updatedAt }),
  });
}

export function applyInitializeResult(
  state: SyncState,
  result: HostInitializeResult,
  requestedSubscriptions: readonly string[] = state.subscriptions,
): SyncState {
  const resources = snapshotsToResources(result.snapshots);
  const missing = uniqueResources(result.missing);
  const active = uniqueResources(requestedSubscriptions).filter((resource) => (
    resources.some((entry) => entry.resource === resource) && !missing.includes(resource)
  ));
  return freezeState({
    ...state,
    status: 'connected',
    hostEpoch: result.hostEpoch,
    lastSeenServerSeq: result.serverSeq,
    subscriptions: active,
    resources,
    missing,
    errorCode: undefined,
    replacementReason: undefined,
  });
}

export function applyReconnectResult(state: SyncState, result: HostReconnectResult): SyncState {
  const epochChanged = state.hostEpoch !== undefined && state.hostEpoch !== result.hostEpoch;
  if (!epochChanged && result.throughSeq < state.lastSeenServerSeq) {
    throw new RangeError('reconnect cut cannot move lastSeenServerSeq backwards');
  }
  if (epochChanged && result.type === 'replay') {
    throw new TypeError('a changed hostEpoch requires a snapshot reconnect result');
  }

  const missing = uniqueResources(result.missing);
  const subscriptions = state.subscriptions.filter((resource) => !missing.includes(resource));
  if (result.type === 'snapshot') {
    const replacements = snapshotsToResources(result.snapshots, result.throughSeq);
    const replacedResources = new Set(replacements.map((entry) => entry.resource));
    const retained = state.resources.filter((entry) => (
      !replacedResources.has(entry.resource) && !missing.includes(entry.resource)
    ));
    return freezeState({
      ...state,
      status: 'connected',
      hostEpoch: result.hostEpoch,
      lastSeenServerSeq: result.throughSeq,
      subscriptions,
      resources: [...retained, ...replacements],
      missing,
      errorCode: undefined,
      replacementReason: undefined,
    });
  }

  let next = state;
  for (const envelope of [...result.actions].sort((left, right) => left.serverSeq - right.serverSeq)) {
    if (envelope.serverSeq > result.throughSeq) {
      throw new RangeError('reconnect action cannot exceed throughSeq');
    }
    next = applyHostAction(next, envelope);
  }
  const resources = next.resources.map((entry) => ({ ...entry, lastServerSeq: result.throughSeq }));
  return freezeState({
    ...next,
    status: 'connected',
    hostEpoch: result.hostEpoch,
    lastSeenServerSeq: result.throughSeq,
    subscriptions,
    resources,
    missing,
    errorCode: undefined,
    replacementReason: undefined,
  });
}

export function applySubscriptionSnapshot(state: SyncState, snapshot: HostStateSnapshot): SyncState {
  const nextResource = snapshotToResource(snapshot);
  const resources = state.resources.filter((entry) => entry.resource !== snapshot.resource);
  return freezeState({
    ...state,
    subscriptions: uniqueResources([...state.subscriptions, snapshot.resource]),
    resources: [...resources, nextResource],
    missing: state.missing.filter((resource) => resource !== snapshot.resource),
  });
}

export function removeSubscription(state: SyncState, resource: AgentResource): SyncState {
  return freezeState({
    ...state,
    subscriptions: state.subscriptions.filter((candidate) => candidate !== resource),
  });
}

export function applyHostAction(state: SyncState, envelope: HostActionEnvelope): SyncState {
  const decision = decideServerSeqApply(state.lastSeenServerSeq, envelope.serverSeq);
  if (!decision.apply) return state;
  const index = state.resources.findIndex((entry) => entry.resource === envelope.channel);
  if (index < 0) {
    return freezeState({ ...state, lastSeenServerSeq: envelope.serverSeq });
  }

  const current = state.resources[index];
  if (current === undefined || envelope.serverSeq <= current.lastServerSeq) {
    return freezeState({ ...state, lastSeenServerSeq: envelope.serverSeq });
  }

  const parsed = parseResourceUri(envelope.channel);
  const reduced = parsed.kind === 'root'
    ? applyHostRootCatalogAction(current.state as Extract<HostResourceState, { resource: RootUri }>['state'], envelope.action as Extract<HostActionEnvelope, { channel: RootUri }>['action'])
    : parsed.kind === 'chat'
      ? applyHostChatAction(current.state as Extract<HostResourceState, { resource: ChatUri }>['state'], envelope.action as Extract<HostActionEnvelope, { channel: ChatUri }>['action'])
      : current.state;
  const nextResource: HostResourceState = parsed.kind === 'root'
    ? { resource: parsed.uri, state: reduced as Extract<HostResourceState, { resource: RootUri }>['state'], lastServerSeq: envelope.serverSeq }
    : parsed.kind === 'chat'
      ? { resource: parsed.uri, state: reduced as Extract<HostResourceState, { resource: ChatUri }>['state'], lastServerSeq: envelope.serverSeq }
      : current;
  const resources = [...state.resources];
  resources[index] = nextResource;
  return freezeState({ ...state, resources, lastSeenServerSeq: envelope.serverSeq });
}

export function getResourceState(state: SyncState, resource: AgentResource): HostResourceState | undefined {
  return state.resources.find((entry) => entry.resource === resource);
}

function snapshotsToResources(
  snapshots: readonly HostStateSnapshot[],
  sequence: number | undefined = undefined,
): readonly HostResourceState[] {
  const byResource = new Map<AgentResource, HostResourceState>();
  for (const snapshot of snapshots) {
    const resource = snapshotToResource(snapshot);
    byResource.set(resource.resource, sequence === undefined ? resource : { ...resource, lastServerSeq: sequence });
  }
  return Object.freeze([...byResource.values()]);
}

function snapshotToResource(snapshot: HostStateSnapshot): HostResourceState {
  if (snapshot.resource === 'agent-root://') {
    const rootSnapshot = snapshot as Extract<HostStateSnapshot, { resource: RootUri }>;
    return {
      resource: rootSnapshot.resource,
      state: rootSnapshot.state,
      lastServerSeq: rootSnapshot.fromSeq,
    };
  }
  const chatSnapshot = snapshot as Extract<HostStateSnapshot, { resource: ChatUri }>;
  return {
    resource: chatSnapshot.resource,
    state: chatSnapshot.state,
    lastServerSeq: chatSnapshot.fromSeq,
  };
}

function uniqueResources(values: readonly string[]): readonly AgentResource[] {
  const result: AgentResource[] = [];
  const seen = new Set<AgentResource>();
  for (const value of values) {
    const parsed = parseResourceUri(value);
    if (!seen.has(parsed.uri)) {
      seen.add(parsed.uri);
      result.push(parsed.uri);
    }
  }
  return Object.freeze(result);
}

function freezeState(state: SyncState): SyncState {
  return Object.freeze({
    ...state,
    subscriptions: Object.freeze([...state.subscriptions]),
    resources: Object.freeze([...state.resources]),
    missing: Object.freeze([...state.missing]),
  });
}
