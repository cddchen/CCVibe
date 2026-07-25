import { describe, expect, it } from "vitest";
import {
  conversationOpenParams,
  conversationSendParams,
  conversationSetEffortParams,
  conversationSetModelParams,
  conversationSetPermissionModeParams,
  permissionRespondParams,
} from "./schemas.js";

describe("conversation RPC schemas", () => {
  it("requires a workspace to open and a conversation to send", () => {
    expect(conversationOpenParams.safeParse({}).success).toBe(false);
    expect(conversationOpenParams.safeParse({ workspacePath: "/x" }).success).toBe(true);
    expect(conversationSendParams.safeParse({ conversationId: "c", content: "hello" }).success).toBe(true);
    expect(conversationSendParams.safeParse({ conversationId: "c", content: "" }).success).toBe(false);
  });

  it("accepts model, effort, and every Claude permission mode", () => {
    expect(conversationSetModelParams.safeParse({ conversationId: "c", model: "custom-model" }).success).toBe(true);
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(conversationSetEffortParams.safeParse({ conversationId: "c", effort }).success).toBe(true);
    }
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]) {
      expect(conversationSetPermissionModeParams.safeParse({ conversationId: "c", mode }).success).toBe(true);
    }
    expect(conversationSetPermissionModeParams.safeParse({ conversationId: "c", mode: "alwaysAllow" }).success).toBe(false);
  });

  it("scopes permission responses to the conversation", () => {
    expect(permissionRespondParams.safeParse({ conversationId: "c", requestId: 1, behavior: "deny" }).success).toBe(true);
    expect(permissionRespondParams.safeParse({
      conversationId: "c", requestId: "r", behavior: "allow", updatedInput: { command: "ls" },
    }).success).toBe(true);
  });
});
