import type { ConnectionId, TurnId } from '../protocol/ids';
import type { AgentResource, ChatUri, RootUri } from '../protocol/resourceUri';

export type JsonPrimitive = null | string | number | boolean;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type ConnectionMode = 'development' | 'production';

export interface ConnectionConfig {
  readonly connectionId: ConnectionId;
  readonly address: string;
  readonly token: string;
  readonly mode: ConnectionMode;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly address?: string;
  readonly hostEpoch?: string;
  readonly serverSeq: number;
  readonly errorCode?: string;
  readonly updatedAt?: string;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: SessionStatus;
}

export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
}

export interface RootCatalogState {
  readonly resource: RootUri;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly sessions: readonly SessionSummary[];
  readonly models: readonly ModelOption[];
  readonly defaultModelId?: string;
  readonly lastServerSeq: number;
}

export type TurnStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export interface ChatTurn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly text: string;
  readonly status: TurnStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface ChatState {
  readonly resource: ChatUri;
  readonly turns: readonly ChatTurn[];
  readonly activeTurnId?: TurnId;
  readonly lastUpdatedAt?: string;
  readonly lastServerSeq: number;
}

export interface TurnStartedAction {
  readonly type: 'chat/turnStarted';
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly timestamp: string;
}

export interface TextDeltaAction {
  readonly type: 'chat/textDelta';
  readonly turnId: TurnId;
  readonly delta: string;
  readonly timestamp: string;
}

export interface TurnCompletedAction {
  readonly type: 'chat/turnCompleted';
  readonly turnId: TurnId;
  readonly timestamp: string;
}

export interface TurnFailedAction {
  readonly type: 'chat/turnFailed';
  readonly turnId: TurnId;
  readonly error: string;
  readonly timestamp: string;
}

export type ChatAction = TurnStartedAction | TextDeltaAction | TurnCompletedAction | TurnFailedAction;

export interface ActionOrigin {
  readonly clientId: string;
  readonly clientSeq: number;
  readonly commandId: string;
}

export interface ActionEnvelope<A, R extends AgentResource> {
  readonly channel: R;
  readonly action: DeepReadonly<A>;
  readonly serverSeq: number;
  readonly serverTime: string;
  readonly origin?: ActionOrigin;
}

export interface StateSnapshot<S, R extends AgentResource> {
  readonly resource: R;
  readonly state: DeepReadonly<S>;
  readonly fromSeq: number;
}
