export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_permission"
  | "closing"
  | "closed"
  | "error";

export type RuntimeStatus =
  | "starting"
  | "running"
  | "closing"
  | "closed"
  | "crashed";

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "interrupted"
  | "failed"
  | "limited";

export type NotificationMethod =
  | "conversation/event"
  | "session/event"
  | "session/status"
  | "runtime/status"
  | "turn/status"
  | "permission/request";

export type SessionEventNotification = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  message: unknown;
};

export type ConversationEventNotification = {
  conversationId: string;
  entry: unknown;
};

export type SessionStatusNotification = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  status: SessionStatus;
  error?: string;
};

export type RuntimeStatusNotification = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  status: RuntimeStatus;
  error?: string;
};

export type TurnStatusNotification = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  turnId: string;
  status: TurnStatus;
  error?: string;
  resultSubtype?: string;
};

export type PermissionRequestNotification = {
  conversationId: string;
  sessionId: string;
  runtimeId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string;
  agentId?: string;
  suggestions?: unknown[];
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
};
