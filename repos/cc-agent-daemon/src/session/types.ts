import type { PermissionMode as SdkPermissionMode } from "@anthropic-ai/claude-agent-sdk";

export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const satisfies readonly SdkPermissionMode[];

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type SessionCreateOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string | { preset: "claude_code"; append?: string };
  settingSources?: ("project" | "user" | "local")[];
  resumeSessionId?: string;
  forkSessionId?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export type ActiveSessionInfo = {
  sessionId: string;
  cwd: string;
  status: string;
  subscriberCount: number;
};