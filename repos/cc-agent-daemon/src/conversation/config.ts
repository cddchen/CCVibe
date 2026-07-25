import type { ClaudePersonalSettings, EffortLevel } from "../settings/reader.js";
import type { ConfigSource, ModelFamily, ResolvedConversationConfig } from "./types.js";
import type { ConversationConfigEntryRow } from "../store/db.js";
import { PERMISSION_MODES } from "../session/types.js";

export type ModelSelection = { family: ModelFamily; modelId: string };

function configuredModel(settings: ClaudePersonalSettings, family: ModelFamily): string {
  return settings.models[family] ?? family;
}

export function identifyModelFamily(model: string, settings: ClaudePersonalSettings): ModelFamily | undefined {
  const normalized = model.trim().toLowerCase();
  if (normalized === "sonnet" || normalized === "opus" || normalized === "haiku") return normalized;
  for (const family of ["sonnet", "opus", "haiku"] as const) {
    if (settings.models[family]?.toLowerCase() === normalized) return family;
  }
  const match = normalized.match(/^claude-(sonnet|opus|haiku)(?:-|$)/);
  return match?.[1] as ModelFamily | undefined;
}

export function resolveModelSelection(model: string, settings: ClaudePersonalSettings): ModelSelection {
  const family = identifyModelFamily(model, settings) ?? "sonnet";
  return { family, modelId: configuredModel(settings, family) };
}

function latestEntry(entries: ConversationConfigEntryRow[], type: string): ConversationConfigEntryRow | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === type) return entries[index];
  }
  return undefined;
}

/** Removes persisted configuration events that did not change the effective conversation state. */
export function meaningfulConfigEntries(
  settings: ClaudePersonalSettings,
  entries: ConversationConfigEntryRow[],
  observedModels: Array<{ model: string; timestamp: string }> = [],
): ConversationConfigEntryRow[] {
  const baseline = resolveConversationConfig(settings, []);
  let model = { family: baseline.model.family, modelId: baseline.model.requestedId };
  let effort = baseline.effort.requested;
  let permissionMode = baseline.permissionMode;
  const meaningful: ConversationConfigEntryRow[] = [];
  const observations = [...observedModels].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let observationIndex = 0;

  for (const entry of entries) {
    while (observationIndex < observations.length
      && observations[observationIndex].timestamp <= entry.createdAt) {
      model = resolveModelSelection(observations[observationIndex].model, settings);
      observationIndex += 1;
    }
    if (entry.type === "model_changed") {
      const candidate = typeof entry.payload.modelId === "string"
        ? entry.payload.modelId
        : String(entry.payload.family ?? "sonnet");
      const next = resolveModelSelection(candidate, settings);
      if (next.family === model.family && next.modelId === model.modelId) continue;
      model = next;
    } else if (entry.type === "effort_changed") {
      const next = entry.payload.effort;
      if (typeof next !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(next)) continue;
      if (next === effort) continue;
      effort = next as EffortLevel;
    } else {
      const next = entry.payload.mode;
      if (typeof next !== "string" || !(PERMISSION_MODES as readonly string[]).includes(next)) continue;
      if (next === permissionMode) continue;
      permissionMode = next as ResolvedConversationConfig["permissionMode"];
    }
    meaningful.push(entry);
  }
  return meaningful;
}

export function resolveConversationConfig(
  settings: ClaudePersonalSettings,
  configEntries: ConversationConfigEntryRow[],
  historyModel?: string,
): ResolvedConversationConfig {
  const modelEntry = latestEntry(configEntries, "model_changed");
  let modelSource: ConfigSource;
  let selectedModel: ModelSelection;
  if (modelEntry) {
    const payload = modelEntry.payload as { family?: unknown; modelId?: unknown };
    const candidate = typeof payload.modelId === "string" ? payload.modelId : String(payload.family ?? "sonnet");
    selectedModel = resolveModelSelection(candidate, settings);
    modelSource = "conversation";
  } else if (historyModel) {
    selectedModel = resolveModelSelection(historyModel, settings);
    modelSource = "history";
  } else if (settings.models.default) {
    selectedModel = resolveModelSelection(settings.models.default, settings);
    modelSource = "settings";
  } else {
    selectedModel = resolveModelSelection("sonnet", settings);
    modelSource = "fallback";
  }

  const effortEntry = latestEntry(configEntries, "effort_changed");
  let effort: EffortLevel;
  let effortSource: "conversation" | "settings" | "fallback";
  const storedEffort = (effortEntry?.payload as { effort?: unknown } | undefined)?.effort;
  if (typeof storedEffort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(storedEffort)) {
    effort = storedEffort as EffortLevel;
    effortSource = "conversation";
  } else if (settings.effortLevel) {
    effort = settings.effortLevel;
    effortSource = "settings";
  } else {
    effort = "high";
    effortSource = "fallback";
  }

  const permissionEntry = latestEntry(configEntries, "permission_mode_changed");
  const storedPermissionMode = (permissionEntry?.payload as { mode?: unknown } | undefined)?.mode;
  const permissionMode = typeof storedPermissionMode === "string"
    && (PERMISSION_MODES as readonly string[]).includes(storedPermissionMode)
    ? storedPermissionMode as ResolvedConversationConfig["permissionMode"]
    : settings.permissions.defaultMode ?? "default";

  return {
    model: {
      family: selectedModel.family,
      requestedId: selectedModel.modelId,
      source: modelSource,
    },
    effort: { requested: effort, source: effortSource },
    permissionMode,
  };
}
