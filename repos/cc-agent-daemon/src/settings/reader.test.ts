import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudePersonalSettings } from "./reader.js";

describe("readClaudePersonalSettings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ccd-settings-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeSettings(claudeHome: string, value: unknown): void {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(value));
  }

  it("reads personalized models, permissions and effort level", async () => {
    const claudeHome = tempDir();
    writeSettings(claudeHome, {
      env: {
        ANTHROPIC_AUTH_TOKEN: "secret-token",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku",
      },
      model: "default-custom-model",
      advisorModel: "opus",
      effortLevel: "xhigh",
      permissions: {
        allow: ["Read", "Bash"],
        deny: ["WebFetch"],
        defaultMode: "acceptEdits",
        additionalDirectories: ["/Users/example/project"],
      },
    });

    const settings = await readClaudePersonalSettings(claudeHome);

    expect(settings).toEqual({
      models: {
        default: "default-custom-model",
        opus: "custom-opus",
        sonnet: "custom-sonnet",
        haiku: "custom-haiku",
        advisor: "opus",
      },
      permissions: {
        allow: ["Read", "Bash"],
        deny: ["WebFetch"],
        defaultMode: "acceptEdits",
        additionalDirectories: ["/Users/example/project"],
      },
      effortLevel: "xhigh",
    });
    expect(JSON.stringify(settings)).not.toContain("secret-token");
  });

  it("returns defaults when settings file is missing", async () => {
    await expect(readClaudePersonalSettings(tempDir())).resolves.toEqual({
      models: {},
      permissions: { allow: [], deny: [], additionalDirectories: [] },
    });
  });

  it("accepts all Claude SDK permission default modes", async () => {
    const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

    for (const mode of modes) {
      const claudeHome = tempDir();
      writeSettings(claudeHome, { permissions: { defaultMode: mode } });
      await expect(readClaudePersonalSettings(claudeHome)).resolves.toMatchObject({
        permissions: { defaultMode: mode },
      });
    }
  });

  it("ignores invalid effort level and permission mode", async () => {
    const claudeHome = tempDir();
    writeSettings(claudeHome, {
      effortLevel: "extreme",
      permissions: { defaultMode: "alwaysAllow" },
    });

    await expect(readClaudePersonalSettings(claudeHome)).resolves.toEqual({
      models: {},
      permissions: { allow: [], deny: [], additionalDirectories: [] },
      effortLevel: undefined,
    });
  });
});
