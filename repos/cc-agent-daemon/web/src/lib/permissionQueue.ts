import type { PermissionRequest } from "./permissionResponses";

function permissionKey(permission: Pick<PermissionRequest, "conversationId" | "requestId">): string {
  return `${permission.conversationId}\u0000${String(permission.requestId)}`;
}

export function upsertPermission(
  queue: PermissionRequest[],
  permission: PermissionRequest,
): PermissionRequest[] {
  const key = permissionKey(permission);
  const index = queue.findIndex((item) => permissionKey(item) === key);
  if (index < 0) return [...queue, permission];
  const next = [...queue];
  next[index] = permission;
  return next;
}

export function resolvePermission(
  queue: PermissionRequest[],
  conversationId: string,
  requestId: string | number,
): PermissionRequest[] {
  const key = permissionKey({ conversationId, requestId });
  return queue.filter((item) => permissionKey(item) !== key);
}
