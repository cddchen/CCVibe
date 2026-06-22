import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultClaudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

export function projectsDir(claudeHome = defaultClaudeHome()): string {
  return join(claudeHome, "projects");
}

/** Claude encodes project paths: every `/` → `-` (leading slash becomes leading `-`). */
export function encodeProjectPath(workspacePath: string): string {
  const normalized = resolveWorkspacePath(workspacePath);
  return normalized.replace(/\//g, "-");
}

function resolveWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath).replace(/\\/g, "/");
}

/** Claude stores project folders as encoded dir names under ~/.claude/projects/ */
export function decodeProjectDirName(encoded: string): string {
  const absolute = encoded.startsWith("-");
  const name = absolute ? encoded.slice(1) : encoded;
  const decoded = name.replace(/-/g, "/");
  return absolute ? `/${decoded}` : decoded;
}

export function projectSessionsDir(workspacePath: string, claudeHome = defaultClaudeHome()): string {
  return join(projectsDir(claudeHome), encodeProjectPath(workspacePath));
}