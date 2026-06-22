import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessageChain } from "./reader.js";

// Web module — import via relative path for vitest (no separate web test runner)
import {
  historyEntriesToChatMessages,
  historyEntryToChatMessage,
  type HistoryJsonlEntry,
} from "../../web/src/lib/messageBlocks.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function assistantBlocks(entry: HistoryJsonlEntry) {
  const c = entry.message?.content;
  if (!Array.isArray(c)) return [];
  return c.map((b) => (b as { type?: string }).type);
}

describe("historyEntriesToChatMessages", () => {
  it("merges thinking then text from separate assistant JSONL lines into one bubble", () => {
    const entries: HistoryJsonlEntry[] = [
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: { content: [{ type: "thinking", thinking: "ponder" }], model: "m1" },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: { content: [{ type: "text", text: "hello" }], model: "m1" },
      },
    ];
    const msgs = historyEntriesToChatMessages(entries);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].id).toBe("a2");
    expect(assistant[0].content).toEqual([
      { type: "thinking", thinking: "ponder" },
      { type: "text", text: "hello" },
    ]);
  });

  it("keeps separate assistant bubbles when separated by a user message", () => {
    const entries: HistoryJsonlEntry[] = [
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "a" }] } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "one" }] },
      },
      { type: "user", uuid: "u2", message: { content: [{ type: "text", text: "b" }] } },
      {
        type: "assistant",
        uuid: "a2",
        message: { content: [{ type: "text", text: "two" }] },
      },
    ];
    const msgs = historyEntriesToChatMessages(entries);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("does not split assistant turn on tool_result-only user rows", () => {
    const entries: HistoryJsonlEntry[] = [
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "go" }] } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "run" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      },
      {
        type: "user",
        uuid: "tr1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "tr1",
        message: { content: [{ type: "text", text: "done" }] },
      },
    ];
    const msgs = historyEntriesToChatMessages(entries);
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    const blocks = assistant[0].content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "text"]);
  });

  it("matches single-entry behavior via historyEntryToChatMessage", () => {
    const entry: HistoryJsonlEntry = {
      type: "assistant",
      uuid: "solo",
      message: { content: [{ type: "text", text: "x" }] },
    };
    expect(historyEntriesToChatMessages([entry])).toEqual([historyEntryToChatMessage(entry)]);
  });
});

describe("historyEntriesToChatMessages (real jsonl sample)", () => {
  it("collapses thinking+text pairs from a saved session", () => {
    const jsonlPath = join(
      __dirname,
      "../../../../.claude/projects/-Users-cdd-Documents-cc/9baf104d-0104-4d39-ae56-f07ae28ba736.jsonl",
    );
    let raw: string;
    try {
      raw = readFileSync(jsonlPath, "utf8");
    } catch {
      return; // skip when fixture not on this machine
    }
    const entries = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as HistoryJsonlEntry);
    const chain = buildMessageChain(entries);
    const msgs = historyEntriesToChatMessages(chain);

    let prev: (typeof msgs)[0] | null = null;
    for (const m of msgs) {
      if (m.role !== "assistant") {
        prev = null;
        continue;
      }
      const blocks = m.content as { type: string }[];
      const kinds = blocks.map((b) => b.type);
      if (prev?.role === "assistant") {
        const prevKinds = (prev.content as { type: string }[]).map((b) => b.type);
        const prevEndsText = prevKinds[prevKinds.length - 1] === "text";
        const curStartsThinking = kinds[0] === "thinking";
        expect(!(prevEndsText && curStartsThinking)).toBe(true);
      }
      prev = m;
    }

    const hasThinkingTextCombo = msgs.some((m) => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
      const kinds = m.content.map((b) => b.type);
      return kinds.includes("thinking") && kinds.includes("text");
    });
    expect(hasThinkingTextCombo).toBe(true);
  });
});