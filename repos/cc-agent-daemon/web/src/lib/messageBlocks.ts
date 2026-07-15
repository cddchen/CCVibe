/** Content blocks aligned with Claude Code / CUI message rendering */

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type MessageBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export type ToolResultState = {
  status: "pending" | "completed" | "error";
  content?: string;
  isError?: boolean;
};

export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
};

export type MessageMetrics = {
  usage?: TokenUsage;
  elapsedSeconds?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  /** User: plain text. Assistant: structured blocks. */
  content: string | MessageBlock[];
  streaming?: boolean;
  model?: string;
  metrics?: MessageMetrics;
};

export function isAssistantBlocks(
  content: ChatMessage["content"],
): content is MessageBlock[] {
  return Array.isArray(content);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromObject(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const input = asNumber(o.input_tokens ?? o.inputTokenCount ?? o.input);
  const output = asNumber(o.output_tokens ?? o.outputTokenCount ?? o.output);
  const derivedTotal = input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
  const total = asNumber(o.total_tokens ?? o.totalTokenCount ?? o.total) ?? derivedTotal;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total };
}

/**
 * Live usage from a streaming `BetaRawMessageStreamEvent`. `message_start`
 * carries `input_tokens` (output usually 0); `message_delta` carries the
 * cumulative `output_tokens`. Mirrors cc CLI, which updates its token counter
 * from these events during streaming rather than waiting for the result.
 */
function usageFromStreamEvent(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const input = asNumber(o.input_tokens);
  const output = asNumber(o.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { input, output, total: (input ?? 0) + (output ?? 0) };
}

function elapsedSecondsFromObject(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const seconds = asNumber(o.elapsed_seconds ?? o.elapsedSeconds ?? o.duration_seconds ?? o.durationSeconds);
  if (seconds !== undefined) return seconds;
  const ms = asNumber(o.duration_ms ?? o.durationMs ?? o.elapsed_ms ?? o.elapsedMs);
  return ms === undefined ? undefined : Math.round((ms / 1000) * 10) / 10;
}

function metricsFromObject(raw: unknown): MessageMetrics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const usage = usageFromObject(o.usage) ?? usageFromObject(o.message && typeof o.message === "object" ? (o.message as Record<string, unknown>).usage : undefined);
  const elapsedSeconds = elapsedSecondsFromObject(o);
  if (!usage && elapsedSeconds === undefined) return undefined;
  return { usage, elapsedSeconds };
}

function asBlocks(raw: unknown): MessageBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") {
      out.push({ type: "text", text: o.text });
    } else if (o.type === "thinking" && typeof o.thinking === "string" && o.thinking !== "") {
      // Resumed/compacted turns persist thinking as signature-only with empty
      // text. cc CLI's thinking renderer does `if (!thinking) return null`, so
      // mirror it: skip textless thinking instead of showing an empty box.
      out.push({ type: "thinking", thinking: o.thinking });
    } else if (o.type === "tool_use" && typeof o.id === "string" && typeof o.name === "string") {
      out.push({
        type: "tool_use",
        id: o.id,
        name: o.name,
        input: (o.input as Record<string, unknown>) ?? {},
      });
    }
  }
  return out;
}

/** Parse one SDK notification message into display updates. Non-dialog SDK/system data is not rendered. */
export function applySdkMessage(
  blocks: MessageBlock[],
  toolResults: Record<string, ToolResultState>,
  msg: unknown,
): { blocks: MessageBlock[]; toolResults: Record<string, ToolResultState>; metrics?: MessageMetrics; model?: string } {
  const m = msg as {
    type?: string;
    subtype?: string;
    event?: {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
      content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
      message?: { model?: string; usage?: unknown };
      usage?: unknown;
    };
    message?: { content?: unknown; model?: string; usage?: unknown };
    content?: unknown;
  };

  let nextBlocks = [...blocks];
  let nextTools = { ...toolResults };

  if (m.type === "stream_event" && m.event) {
    const ev = m.event;
    const delta = ev.delta;
    if (delta?.thinking) {
      nextBlocks = appendThinkingDelta(nextBlocks, delta.thinking);
    } else if (delta?.type === "thinking_delta" && delta.thinking) {
      nextBlocks = appendThinkingDelta(nextBlocks, delta.thinking);
    } else if (delta?.type === "text_delta" && delta.text) {
      nextBlocks = appendTextDelta(nextBlocks, delta.text);
    } else if (ev.type === "content_block_delta" && delta?.text) {
      nextBlocks = appendTextDelta(nextBlocks, delta.text);
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      const cb = ev.content_block;
      if (cb.id && cb.name) {
        nextBlocks.push({ type: "tool_use", id: cb.id, name: cb.name, input: cb.input ?? {} });
        nextTools[cb.id] = { status: "pending" };
      }
    }

    let metrics: MessageMetrics | undefined;
    let model: string | undefined;
    if (ev.type === "message_start" && ev.message) {
      model = ev.message.model;
      const usage = usageFromStreamEvent(ev.message.usage);
      if (usage) metrics = { usage };
    } else if (ev.type === "message_delta") {
      const usage = usageFromStreamEvent(ev.usage);
      if (usage) metrics = { usage };
    }
    return { blocks: nextBlocks, toolResults: nextTools, metrics, model };
  }

  if (m.type === "assistant") {
    const raw = m.message?.content ?? m.content;
    const parsed = asBlocks(raw);
    if (parsed.length > 0) {
      nextBlocks = mergeLiveAssistantSnapshot(nextBlocks, parsed);
      for (const b of nextBlocks) {
        if (b.type === "tool_use" && !nextTools[b.id]) {
          nextTools[b.id] = { status: "pending" };
        }
      }
    }
    return { blocks: nextBlocks, toolResults: nextTools, metrics: metricsFromObject(m), model: m.message?.model };
  }

  if (m.type === "user") {
    const raw = m.message?.content ?? m.content;
    if (Array.isArray(raw)) {
      for (const b of raw) {
        const o = b as Record<string, unknown>;
        if (o.type === "tool_result" && typeof o.tool_use_id === "string") {
          const id = o.tool_use_id;
          const content = toolResultContent(o.content);
          nextTools[id] = {
            status: o.is_error ? "error" : "completed",
            content,
            isError: !!o.is_error,
          };
        }
      }
    }
    return { blocks: nextBlocks, toolResults: nextTools };
  }

  if (m.type === "result") {
    return { blocks: nextBlocks, toolResults: nextTools, metrics: metricsFromObject(m) };
  }

  return { blocks: nextBlocks, toolResults: nextTools };
}

function toolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((x) =>
        typeof x === "object" && x && "text" in x ? String((x as { text: string }).text) : "",
      )
      .join("\n");
  }
  return "";
}

function appendTextDelta(blocks: MessageBlock[], delta: string): MessageBlock[] {
  const copy = [...blocks];
  const last = copy[copy.length - 1];
  if (last?.type === "text") {
    copy[copy.length - 1] = { type: "text", text: last.text + delta };
  } else {
    copy.push({ type: "text", text: delta });
  }
  return copy;
}

function appendThinkingDelta(blocks: MessageBlock[], delta: string): MessageBlock[] {
  const copy = [...blocks];
  const last = copy[copy.length - 1];
  if (last?.type === "thinking") {
    copy[copy.length - 1] = { type: "thinking", thinking: last.thinking + delta };
  } else {
    copy.push({ type: "thinking", thinking: delta });
  }
  return copy;
}

export type HistoryJsonlEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  duration_ms?: number;
  durationMs?: number;
  elapsed_ms?: number;
  elapsedMs?: number;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { content?: unknown; model?: string; usage?: unknown };
};

/**
 * Compaction writes a `compact_boundary` system entry plus a `type:"user"` entry
 * carrying the "This session is being continued…" summary, flagged with
 * `isCompactSummary` and `isVisibleInTranscriptOnly`. These are synthetic
 * context, not real dialog turns, and must never render as chat messages.
 */
export function isNonDialogHistoryEntry(entry: HistoryJsonlEntry): boolean {
  return (
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true ||
    entry.subtype === "compact_boundary"
  );
}

function isToolResultOnlyUser(entry: HistoryJsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const c = entry.message?.content;
  if (!Array.isArray(c) || c.length === 0) return false;
  return c.every(
    (b) => typeof b === "object" && b && (b as { type?: string }).type === "tool_result",
  );
}

function mergeBlockLists(acc: MessageBlock[], next: MessageBlock[]): MessageBlock[] {
  const out = [...acc];
  for (const b of next) {
    const last = out[out.length - 1];
    if (b.type === "thinking" && last?.type === "thinking") {
      out[out.length - 1] = { type: "thinking", thinking: last.thinking + b.thinking };
    } else if (b.type === "text" && last?.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + b.text };
    } else {
      out.push(b);
    }
  }
  return out;
}

function mergeLiveAssistantSnapshot(current: MessageBlock[], snapshot: MessageBlock[]): MessageBlock[] {
  if (snapshot.length === 0) return current;
  if (current.length === 0) return snapshot;

  const snapshotHasStructure = snapshot.some((b) => b.type !== "text");
  if (!snapshotHasStructure) {
    let lastStructuredIndex = -1;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (current[i].type !== "text") {
        lastStructuredIndex = i;
        break;
      }
    }
    if (lastStructuredIndex === -1) return snapshot;
    return [...current.slice(0, lastStructuredIndex + 1), ...snapshot];
  }

  const first = snapshot[0];
  const matchIndex = current.findIndex((b) => {
    if (first.type === "tool_use") return b.type === "tool_use" && b.id === first.id;
    if (first.type === "thinking") return b.type === "thinking" && b.thinking === first.thinking;
    return b.type === "text" && b.text === first.text;
  });
  if (matchIndex >= 0) return [...current.slice(0, matchIndex), ...snapshot];

  return mergeBlockLists(current, snapshot);
}

/**
 * Merge metrics as new SDK events arrive. Input comes from `message_start`,
 * output updates on each `message_delta`, so `total` is always recomputed from
 * the merged input+output (carrying a stale derived total would freeze it
 * mid-stream). An explicit total is only kept when neither input nor output is
 * known.
 */
export function mergeMetrics(
  current: MessageMetrics | undefined,
  next: MessageMetrics | undefined,
): MessageMetrics | undefined {
  if (!next) return current;
  const input = next.usage?.input ?? current?.usage?.input;
  const output = next.usage?.output ?? current?.usage?.output;
  let usage: TokenUsage | undefined;
  if (input !== undefined || output !== undefined) {
    usage = { input, output, total: (input ?? 0) + (output ?? 0) };
  } else {
    const total = next.usage?.total ?? current?.usage?.total;
    usage = total !== undefined ? { total } : undefined;
  }
  return { usage, elapsedSeconds: next.elapsedSeconds ?? current?.elapsedSeconds };
}

/** One SDK turn may be split across multiple assistant JSONL lines; merge like live stream. */
export function historyEntriesToChatMessages(entries: HistoryJsonlEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let group: HistoryJsonlEntry[] = [];

  const flushAssistantGroup = () => {
    if (group.length === 0) return;
    let blocks: MessageBlock[] = [];
    let model: string | undefined;
    let metrics: MessageMetrics | undefined;
    for (const e of group) {
      blocks = mergeBlockLists(blocks, asBlocks(e.message?.content));
      model = model ?? e.message?.model;
      metrics = mergeMetrics(metrics, metricsFromObject(e));
    }
    if (blocks.length === 0) {
      group = [];
      return;
    }
    const leaf = group[group.length - 1];
    out.push({
      id: leaf.uuid ?? crypto.randomUUID(),
      role: "assistant",
      content: blocks,
      model,
      metrics,
    });
    group = [];
  };

  for (const entry of entries) {
    if (isNonDialogHistoryEntry(entry)) {
      // compact_boundary / summary — close current assistant group.
      flushAssistantGroup();
      continue;
    }
    if (isToolResultOnlyUser(entry)) continue;

    if (entry.type === "assistant") {
      group.push(entry);
      continue;
    }

    // Only a real dialog message (usually user text) should split bubbles.
    // Control noise (last-prompt, mode, permission-mode, file-history-snapshot,
    // system stop_hook/turn_duration, …) must not flush the group.
    const cm = historyEntryToChatMessage(entry);
    if (cm) {
      flushAssistantGroup();
      out.push(cm);
    }
  }
  flushAssistantGroup();
  return out;
}

export function historyEntryToChatMessage(entry: HistoryJsonlEntry): ChatMessage | null {
  if (isNonDialogHistoryEntry(entry)) return null;
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  const c = entry.message?.content;
  if (entry.type === "user") {
    if (Array.isArray(c)) {
      const onlyToolResult = c.every(
        (b) => typeof b === "object" && b && (b as { type?: string }).type === "tool_result",
      );
      if (onlyToolResult) return null;
      const text = c
        .filter((b) => typeof b === "object" && b && (b as { type?: string }).type === "text")
        .map((b) => String((b as { text: string }).text))
        .join("\n");
      if (!text) return null;
      return {
        id: entry.uuid ?? crypto.randomUUID(),
        role: "user",
        content: text,
      };
    }
    if (typeof c === "string" && c) {
      return { id: entry.uuid ?? crypto.randomUUID(), role: "user", content: c };
    }
    return null;
  }
  const blocks = asBlocks(c);
  if (blocks.length === 0) return null;
  return {
    id: entry.uuid ?? crypto.randomUUID(),
    role: "assistant",
    content: blocks,
    model: entry.message?.model,
    metrics: metricsFromObject(entry),
  };
}

export function buildToolResultsFromHistory(entries: unknown[]): Record<string, ToolResultState> {
  const out: Record<string, ToolResultState> = {};
  for (const entry of entries) {
    const e = entry as HistoryJsonlEntry;
    if (isNonDialogHistoryEntry(e)) continue;
    if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      const o = b as Record<string, unknown>;
      if (o.type === "tool_result" && typeof o.tool_use_id === "string") {
        out[o.tool_use_id] = {
          status: o.is_error ? "error" : "completed",
          content: toolResultContent(o.content),
          isError: !!o.is_error,
        };
      }
    }
  }
  return out;
}

export function pendingToolsFromBlocks(blocks: MessageBlock[]): Record<string, ToolResultState> {
  const out: Record<string, ToolResultState> = {};
  for (const b of blocks) {
    if (b.type === "tool_use") out[b.id] = { status: "pending" };
  }
  return out;
}
