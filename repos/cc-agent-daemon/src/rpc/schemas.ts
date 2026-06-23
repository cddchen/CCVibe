import { z } from "zod";
import { PERMISSION_MODES } from "../session/types.js";

export const authParams = z.object({ token: z.string().min(1) });

export const sessionCreateParams = z.object({
  cwd: z.string().min(1),
  model: z.string().optional(),
  permissionMode: z
    .enum(PERMISSION_MODES)
    .optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  systemPrompt: z.union([z.string(), z.object({ preset: z.literal("claude_code"), append: z.string().optional() })]).optional(),
  settingSources: z.array(z.enum(["project", "user", "local"])).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  initialMessage: z.string().optional(),
});

export const sessionIdParams = z.object({ sessionId: z.string().min(1) });

export const sessionSendParams = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
});

export const sessionResumeParams = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  permissionMode: z
    .enum(PERMISSION_MODES)
    .optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

export const sessionForkParams = sessionResumeParams;

export const sessionSetPermissionParams = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(PERMISSION_MODES),
});

export const sessionSetMetaParams = z.object({
  sessionId: z.string().min(1),
  customName: z.string().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const historyListParams = z.object({
  workspacePath: z.string().min(1),
});

export const historyLoadParams = z.object({
  sessionId: z.string().min(1),
  workspacePath: z.string().optional(),
});

export const workspaceAddParams = z.object({ path: z.string().min(1) });
export const workspaceRemoveParams = z.object({ id: z.string().min(1) });
export const workspaceCheckTrustParams = z.object({ path: z.string().min(1) });

export const permissionRespondParams = z.object({
  sessionId: z.string().min(1),
  requestId: z.union([z.string(), z.number()]),
  behavior: z.enum(["allow", "deny"]),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
});