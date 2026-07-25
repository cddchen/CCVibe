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
  | "conversation/event";
