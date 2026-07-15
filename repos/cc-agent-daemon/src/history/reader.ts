import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { decodeProjectDirName, projectSessionsDir, projectsDir } from "./paths.js";

export type HistorySessionSummary = {
  sessionId: string;
  filePath: string;
  messageCount: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
};

export type JsonlEntry = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: unknown;
  summary?: string;
};

export async function listSessions(workspacePath: string): Promise<HistorySessionSummary[]> {
  return listSessionsInDir(projectSessionsDir(resolve(workspacePath)));
}

async function listSessionsInDir(dir: string): Promise<HistorySessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: HistorySessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
    const sessionId = name.replace(/\.jsonl$/, "");
    const filePath = join(dir, name);
    summaries.push(await summarizeJsonl(filePath, sessionId));
  }
  return summaries.sort((a, b) => (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""));
}

export type LocalProjectSessions = {
  workspacePath: string;
  encodedDir: string;
  sessions: HistorySessionSummary[];
};

/** Scan ~/.claude/projects/* for all JSONL session files (same layout as Claude Code). */
export async function listAllLocalProjects(): Promise<LocalProjectSessions[]> {
  const root = projectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }

  const out: LocalProjectSessions[] = [];
  for (const encodedDir of dirs) {
    if (!encodedDir || encodedDir.startsWith(".")) continue;
    const workspacePath = decodeProjectDirName(encodedDir);
    let names: string[];
    try {
      names = await readdir(join(root, encodedDir));
    } catch {
      continue;
    }
    const sessionFiles = names.filter((name) => name.endsWith(".jsonl") && !name.startsWith("agent-"));
    if (sessionFiles.length === 0) continue;
    const discoveredPath = await readWorkspacePathFromProject(root, encodedDir, sessionFiles);
    const sessions = await listSessionsInDir(join(root, encodedDir));
    out.push({ workspacePath: discoveredPath ?? workspacePath, encodedDir, sessions });
  }
  out.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
  return out;
}

export async function loadSessionMessages(
  sessionId: string,
  workspacePath: string,
): Promise<JsonlEntry[]> {
  const filePath = join(projectSessionsDir(resolve(workspacePath)), `${sessionId}.jsonl`);
  const entries = await readJsonl(filePath);
  return buildMessageChain(entries);
}

async function readWorkspacePathFromProject(root: string, encodedDir: string, sessionFiles: string[]): Promise<string | undefined> {
  for (const name of sessionFiles) {
    const filePath = join(root, encodedDir, name);
    const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const entry = JSON.parse(t) as JsonlEntry;
          if (typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
        } catch {}
      }
    } catch {}
  }
  return undefined;
}

async function summarizeJsonl(filePath: string, sessionId: string): Promise<HistorySessionSummary> {
  let messageCount = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  try {
    await stat(filePath);
    const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const entry = JSON.parse(t) as JsonlEntry;
        if (entry.type === "user" || entry.type === "assistant") messageCount += 1;
        if (entry.timestamp) {
          firstTimestamp ??= entry.timestamp;
          lastTimestamp = entry.timestamp;
        }
      } catch {
        // skip bad line
      }
    }
  } catch {
    // leave empty summary
  }
  return { sessionId, filePath, messageCount, firstTimestamp, lastTimestamp };
}

async function readJsonl(filePath: string): Promise<JsonlEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: JsonlEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as JsonlEntry);
    } catch {
      // skip bad line
    }
  }
  return out;
}

/** Rebuild linear chain via parentUuid (best-effort). */
export function buildMessageChain(entries: JsonlEntry[]): JsonlEntry[] {
  const byUuid = new Map<string, JsonlEntry>();
  const indexByUuid = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.uuid) {
      byUuid.set(e.uuid, e);
      indexByUuid.set(e.uuid, i);
    }
  }
  const leaves = entries.filter((e) => e.uuid && !entries.some((x) => x.parentUuid === e.uuid));
  const leaf = leaves[leaves.length - 1] ?? entries[entries.length - 1];
  if (!leaf?.uuid) return entries;

  const chain: JsonlEntry[] = [];
  let cur: JsonlEntry | undefined = leaf;
  const guard = new Set<string>();
  while (cur && cur.uuid && !guard.has(cur.uuid)) {
    guard.add(cur.uuid);
    chain.unshift(cur);
    const parentId: string | null | undefined = cur.parentUuid;
    cur = parentId ? byUuid.get(parentId) : undefined;
  }
  if (!chain.length) return entries;

  // Parallel tool calls write multiple tool_result user rows that share a parent
  // with the spine (or parent the tool_use assistant). parentUuid walk only keeps
  // one child path, so re-attach those sibling tool_results or tools stay "执行中".
  return attachMissingToolResults(chain, entries, indexByUuid);
}

function toolUseIdsIn(entries: JsonlEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; id?: string };
      if (b?.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
    }
  }
  return ids;
}

function isToolResultOnlyEntry(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => {
    const b = block as { type?: string };
    return typeof block === "object" && block != null && b.type === "tool_result";
  });
}

function toolResultIds(entry: JsonlEntry): string[] {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string };
    if (b?.type === "tool_result" && typeof b.tool_use_id === "string") ids.push(b.tool_use_id);
  }
  return ids;
}

function attachMissingToolResults(
  chain: JsonlEntry[],
  all: JsonlEntry[],
  indexByUuid: Map<string, number>,
): JsonlEntry[] {
  const onChain = new Set(chain.map((e) => e.uuid).filter((u): u is string => !!u));
  const needed = toolUseIdsIn(chain);
  if (needed.size === 0) return chain;

  const missing = all.filter((e) => {
    if (!e.uuid || onChain.has(e.uuid) || !isToolResultOnlyEntry(e)) return false;
    return toolResultIds(e).some((id) => needed.has(id));
  });
  if (missing.length === 0) return chain;

  missing.sort((a, b) => (indexByUuid.get(a.uuid!) ?? 0) - (indexByUuid.get(b.uuid!) ?? 0));

  const out = [...chain];
  for (const result of missing) {
    const parentId = result.parentUuid ?? undefined;
    let insertAt = out.length;
    if (parentId) {
      const parentIdx = out.findIndex((e) => e.uuid === parentId);
      if (parentIdx >= 0) insertAt = parentIdx + 1;
    }
    // Keep file order among siblings inserted at the same parent.
    while (
      insertAt < out.length &&
      out[insertAt]?.parentUuid === parentId &&
      (indexByUuid.get(out[insertAt].uuid!) ?? 0) < (indexByUuid.get(result.uuid!) ?? 0)
    ) {
      insertAt += 1;
    }
    out.splice(insertAt, 0, result);
    onChain.add(result.uuid!);
  }
  return out;
}