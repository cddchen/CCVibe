import { describe, it, expect } from "vitest";
import { sessionCreateParams, sessionResumeParams, sessionSetPermissionParams, permissionRespondParams } from "./schemas.js";

describe("rpc schemas", () => {
  it("sessionCreateParams requires cwd", () => {
    expect(sessionCreateParams.safeParse({}).success).toBe(false);
    expect(sessionCreateParams.safeParse({ cwd: "/x" }).success).toBe(true);
  });

  it("session params accept built-in and custom models with effort", () => {
    const models = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "custom-local-model"];
    const efforts = ["low", "medium", "high", "xhigh", "max"];

    for (const model of models) {
      for (const effort of efforts) {
        expect(sessionCreateParams.safeParse({ cwd: "/x", model, effort }).success).toBe(true);
        expect(sessionResumeParams.safeParse({ cwd: "/x", sessionId: "s", model, effort }).success).toBe(true);
      }
    }
  });

  it("session params reject invalid effort", () => {
    expect(sessionCreateParams.safeParse({ cwd: "/x", model: "custom", effort: "extreme" }).success).toBe(false);
    expect(sessionResumeParams.safeParse({ cwd: "/x", sessionId: "s", model: "custom", effort: "extreme" }).success).toBe(false);
  });

  it("accepts Claude SDK permission modes for create, resume and runtime switching", () => {
    const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

    for (const mode of modes) {
      expect(sessionCreateParams.safeParse({ cwd: "/x", permissionMode: mode }).success).toBe(true);
      expect(sessionResumeParams.safeParse({ cwd: "/x", sessionId: "s", permissionMode: mode }).success).toBe(true);
      expect(sessionSetPermissionParams.safeParse({ sessionId: "s", mode }).success).toBe(true);
    }
  });

  it("rejects unknown permission modes", () => {
    expect(sessionCreateParams.safeParse({ cwd: "/x", permissionMode: "alwaysAllow" }).success).toBe(false);
    expect(sessionResumeParams.safeParse({ cwd: "/x", sessionId: "s", permissionMode: "alwaysAllow" }).success).toBe(false);
    expect(sessionSetPermissionParams.safeParse({ sessionId: "s", mode: "alwaysAllow" }).success).toBe(false);
  });

  it("permissionRespondParams accepts numeric requestId", () => {
    expect(
      permissionRespondParams.safeParse({
        sessionId: "s",
        requestId: 1,
        behavior: "deny",
      }).success,
    ).toBe(true);
  });

  it("permissionRespondParams accepts allow updates and deny messages", () => {
    expect(
      permissionRespondParams.safeParse({
        sessionId: "s",
        requestId: "r",
        behavior: "allow",
        updatedInput: { command: "ls" },
      }).success,
    ).toBe(true);
    expect(
      permissionRespondParams.safeParse({
        sessionId: "s",
        requestId: "r",
        behavior: "deny",
        message: "Use a safer command",
      }).success,
    ).toBe(true);
  });
});