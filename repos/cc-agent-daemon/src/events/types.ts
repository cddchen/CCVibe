export type SessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "interrupted";

export type NotificationMethod =
  | "session/event"
  | "session/status"
  | "permission/request";

export type SessionEventNotification = {
  sessionId: string;
  message: unknown;
};

export type SessionStatusNotification = {
  sessionId: string;
  status: SessionStatus;
  error?: string;
};

export type PermissionRequestNotification = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
};