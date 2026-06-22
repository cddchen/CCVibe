export type PermissionRequest = {
  sessionId: string;
  requestId: string | number;
  toolName: string;
  input?: unknown;
};

export type PermissionRespondParams = {
  sessionId: string;
  requestId: string | number;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
};

export function permissionInputText(input: unknown): string {
  if (input === undefined) return "{}";
  return JSON.stringify(input, null, 2);
}

export function parseUpdatedInput(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("updatedInput 必须是 JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function buildPermissionRespondParams(
  request: PermissionRequest,
  behavior: "allow" | "deny",
  opts?: { updatedInputText?: string; denyMessage?: string },
): PermissionRespondParams {
  const base = {
    sessionId: request.sessionId,
    requestId: request.requestId,
    behavior,
  };

  if (behavior === "deny") {
    return {
      ...base,
      message: opts?.denyMessage?.trim() || "用户拒绝",
    };
  }

  const updatedInput = parseUpdatedInput(opts?.updatedInputText ?? "");
  return updatedInput ? { ...base, updatedInput } : base;
}
