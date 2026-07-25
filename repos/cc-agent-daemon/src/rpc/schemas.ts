import { z } from "zod";
import { PERMISSION_MODES } from "../session/types.js";

export const authParams = z.object({ token: z.string().min(1) });

export const historyListParams = z.object({
  workspacePath: z.string().min(1),
});

export const workspaceAddParams = z.object({ path: z.string().min(1) });
export const workspaceRemoveParams = z.object({ id: z.string().min(1) });
export const workspaceCheckTrustParams = z.object({ path: z.string().min(1) });

export const permissionRespondParams = z.object({
  conversationId: z.string().min(1),
  requestId: z.union([z.string(), z.number()]),
  behavior: z.enum(["allow", "deny"]),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  updatedPermissions: z.array(z.record(z.string(), z.unknown())).optional(),
  message: z.string().optional(),
});

export const conversationOpenParams = z.object({
  conversationId: z.string().min(1).optional(),
  workspacePath: z.string().min(1),
  subscribe: z.boolean().optional(),
});

export const conversationIdParams = z.object({ conversationId: z.string().min(1) });
export const conversationGetParams = conversationIdParams;

export const conversationSendParams = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
  clientMessageId: z.string().min(1).optional(),
});

export const conversationSetModelParams = z.object({
  conversationId: z.string().min(1),
  model: z.string().min(1),
});

export const conversationSetEffortParams = z.object({
  conversationId: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
});

export const conversationSetPermissionModeParams = z.object({
  conversationId: z.string().min(1),
  mode: z.enum(PERMISSION_MODES),
});
