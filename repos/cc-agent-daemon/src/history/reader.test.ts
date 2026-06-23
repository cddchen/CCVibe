import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMessageChain, listAllLocalProjects, listSessions, loadSessionMessages, type JsonlEntry } from "./reader.js";
import { decodeProjectDirName, encodeProjectPath, projectSessionsDir } from "./paths.js";

describe("buildMessageChain", () => {
  it("rebuilds chain via parentUuid", () => {
    const entries: JsonlEntry[] = [
      { uuid: "a", parentUuid: null, type: "user" },
      { uuid: "b", parentUuid: "a", type: "assistant" },
      { uuid: "c", parentUuid: "b", type: "user" },
    ];
    const chain = buildMessageChain(entries);
    expect(chain.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
  });

  it("returns original when no uuids", () => {
    const entries: JsonlEntry[] = [{ type: "user" }];
    expect(buildMessageChain(entries)).toEqual(entries);
  });
});

describe("history paths", () => {
  it("decodes encoded absolute paths outside /Users", () => {
    const workspace = "/private/var/folders/workspace";
    expect(decodeProjectDirName(encodeProjectPath(workspace))).toBe(workspace);
  });
});

describe("history reader", () => {
  const originalClaudeHome = process.env.CLAUDE_HOME;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = originalClaudeHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeSession(claudeHome: string, workspace: string, sessionId: string, entries: JsonlEntry[]): void {
    const dir = projectSessionsDir(workspace, claudeHome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
  }

  it("lists sessions using streamed summaries and skips agent sessions", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    const workspace = tempDir("ccd-workspace-");
    process.env.CLAUDE_HOME = claudeHome;

    writeSession(claudeHome, workspace, "s1", [
      { uuid: "u1", type: "user", timestamp: "2026-01-01T00:00:00.000Z" },
      { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);
    writeSession(claudeHome, workspace, "agent-hidden", [
      { uuid: "x", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z" },
    ]);

    const sessions = await listSessions(workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s1",
      messageCount: 2,
      firstTimestamp: "2026-01-01T00:00:00.000Z",
      lastTimestamp: "2026-01-01T00:00:01.000Z",
    });
  });

  it("uses JSONL cwd to recover workspace paths with hyphenated components", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    const root = tempDir("ccd-root-");
    const workspace = join(root, "hyphen-project");
    mkdirSync(workspace, { recursive: true });
    process.env.CLAUDE_HOME = claudeHome;

    writeSession(claudeHome, workspace, "s1", [
      { uuid: "u1", type: "user", cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" },
    ]);

    const projects = await listAllLocalProjects();
    expect(projects).toEqual([
      expect.objectContaining({
        workspacePath: workspace,
        sessions: [expect.objectContaining({ sessionId: "s1", messageCount: 1 })],
      }),
    ]);
  });

  it("listAllLocalProjects populates sessions and excludes agent-* files", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    const workspace = tempDir("ccd-workspace-");
    process.env.CLAUDE_HOME = claudeHome;

    writeSession(claudeHome, workspace, "visible-1", [
      { uuid: "u1", type: "user", timestamp: "2026-01-01T00:00:00.000Z" },
      { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);
    writeSession(claudeHome, workspace, "agent-hidden", [
      { uuid: "x", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z" },
    ]);

    const projects = await listAllLocalProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].sessions.map((s) => s.sessionId)).toEqual(["visible-1"]);
    expect(projects[0].sessions[0].messageCount).toBe(2);
  });

  it("loads a session and rebuilds the latest parent chain", async () => {
    const claudeHome = tempDir("ccd-claude-home-");
    const workspace = tempDir("ccd-workspace-");
    process.env.CLAUDE_HOME = claudeHome;

    writeSession(claudeHome, workspace, "s1", [
      { uuid: "root", type: "user", timestamp: "2026-01-01T00:00:00.000Z" },
      { uuid: "old", parentUuid: "root", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z" },
      { uuid: "latest", parentUuid: "root", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z" },
    ]);

    const entries = await loadSessionMessages("s1", workspace);
    expect(entries.map((e) => e.uuid)).toEqual(["root", "latest"]);
  });
});
