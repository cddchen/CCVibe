import { describe, expect, it } from "vitest";
import type { ClaudePersonalSettings } from "../settings/reader.js";
import type { ConversationConfigEntryRow } from "../store/db.js";
import { identifyModelFamily, resolveConversationConfig, resolveModelSelection } from "./config.js";

const settings: ClaudePersonalSettings = {
  models: {
    default: "my-opus",
    sonnet: "my-sonnet",
    opus: "my-opus",
    haiku: "my-haiku",
  },
  permissions: { allow: [], deny: [], additionalDirectories: [], defaultMode: "acceptEdits" },
  effortLevel: "medium",
};

function entry(
  type: ConversationConfigEntryRow["type"],
  payload: Record<string, unknown>,
  createdAt: string,
): ConversationConfigEntryRow {
  return { id: `${type}-${createdAt}`, conversationId: "conversation-1", type, payload, createdAt };
}

describe("conversation config resolution", () => {
  it("recognizes aliases, standard IDs and custom settings model IDs", () => {
    expect(identifyModelFamily("sonnet", settings)).toBe("sonnet");
    expect(identifyModelFamily("claude-opus-4-7", settings)).toBe("opus");
    expect(identifyModelFamily("my-haiku", settings)).toBe("haiku");
    expect(resolveModelSelection("unknown-model", settings)).toEqual({ family: "sonnet", modelId: "my-sonnet" });
  });

  it("uses explicit conversation changes ahead of history and settings", () => {
    const resolved = resolveConversationConfig(settings, [
      entry("model_changed", { family: "haiku", modelId: "my-haiku" }, "2026-01-01T00:00:00Z"),
      entry("effort_changed", { effort: "xhigh" }, "2026-01-01T00:00:01Z"),
      entry("permission_mode_changed", { mode: "plan" }, "2026-01-01T00:00:02Z"),
    ], "claude-sonnet-4-6");

    expect(resolved.model).toEqual({ family: "haiku", requestedId: "my-haiku", source: "conversation" });
    expect(resolved.effort).toEqual({ requested: "xhigh", source: "conversation" });
    expect(resolved.permissionMode).toBe("plan");
  });

  it("falls back through history, settings and defaults", () => {
    expect(resolveConversationConfig(settings, [], "claude-haiku-4-5").model).toEqual({
      family: "haiku",
      requestedId: "my-haiku",
      source: "history",
    });
    expect(resolveConversationConfig(settings, []).model.source).toBe("settings");
    expect(resolveConversationConfig({ models: {}, permissions: { allow: [], deny: [], additionalDirectories: [] } }, [])).toMatchObject({
      model: { family: "sonnet", requestedId: "sonnet", source: "fallback" },
      effort: { requested: "high", source: "fallback" },
      permissionMode: "default",
    });
  });
});
