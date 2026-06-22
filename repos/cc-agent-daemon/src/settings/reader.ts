import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultClaudeHome } from "../history/paths.js";
import { PERMISSION_MODES, type PermissionMode } from "../session/types.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudePersonalSettings = {
  models: {
    default?: string;
    opus?: string;
    sonnet?: string;
    haiku?: string;
    advisor?: string;
  };
  permissions: {
    allow: string[];
    deny: string[];
    defaultMode?: PermissionMode;
    additionalDirectories: string[];
  };
  effortLevel?: EffortLevel;
};

const effortLevels = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const permissionModes = new Set<PermissionMode>(PERMISSION_MODES);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function asEffort(value: unknown): EffortLevel | undefined {
  const s = asString(value);
  return s && effortLevels.has(s as EffortLevel) ? (s as EffortLevel) : undefined;
}

function asPermissionMode(value: unknown): PermissionMode | undefined {
  const s = asString(value);
  return s && permissionModes.has(s as PermissionMode) ? (s as PermissionMode) : undefined;
}

export async function readClaudePersonalSettings(claudeHome = defaultClaudeHome()): Promise<ClaudePersonalSettings> {
  let raw: string;
  try {
    raw = await readFile(join(claudeHome, "settings.json"), "utf8");
  } catch {
    return emptySettings();
  }

  const parsed = asRecord(JSON.parse(raw));
  const env = asRecord(parsed.env);
  const permissions = asRecord(parsed.permissions);

  return {
    models: {
      default: asString(parsed.model),
      opus: asString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      sonnet: asString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      haiku: asString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      advisor: asString(parsed.advisorModel),
    },
    permissions: {
      allow: asStringArray(permissions.allow),
      deny: asStringArray(permissions.deny),
      defaultMode: asPermissionMode(permissions.defaultMode),
      additionalDirectories: asStringArray(permissions.additionalDirectories),
    },
    effortLevel: asEffort(parsed.effortLevel),
  };
}

function emptySettings(): ClaudePersonalSettings {
  return {
    models: {},
    permissions: { allow: [], deny: [], additionalDirectories: [] },
  };
}
