import type {
  AgentMessage,
  MessageLifecycleEvent,
  MessageMetrics,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolCallStatus,
  ToolResultMessage,
  UserMessage,
} from "./types.js";

type ContentBlock = TextContent | ThinkingContent | ToolCallContent;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metricsFrom(raw: unknown): MessageMetrics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const usageRaw = value.usage && typeof value.usage === "object"
    ? value.usage as Record<string, unknown>
    : value.message && typeof value.message === "object"
      ? ((value.message as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined;
  const input = asNumber(usageRaw?.input_tokens ?? usageRaw?.input);
  const output = asNumber(usageRaw?.output_tokens ?? usageRaw?.output);
  const explicitTotal = asNumber(usageRaw?.total_tokens ?? usageRaw?.total);
  const usage = input !== undefined || output !== undefined || explicitTotal !== undefined
    ? { input, output, total: explicitTotal ?? (input ?? 0) + (output ?? 0) }
    : undefined;
  const seconds = asNumber(value.elapsed_seconds ?? value.elapsedSeconds ?? value.duration_seconds);
  const milliseconds = asNumber(value.duration_ms ?? value.durationMs ?? value.elapsed_ms);
  const elapsedSeconds = seconds ?? (milliseconds === undefined ? undefined : Math.round(milliseconds / 100) / 10);
  return usage || elapsedSeconds !== undefined ? { usage, elapsedSeconds } : undefined;
}

function mergeMetrics(current: MessageMetrics | undefined, next: MessageMetrics | undefined): MessageMetrics | undefined {
  if (!next) return current;
  const input = next.usage?.input ?? current?.usage?.input;
  const output = next.usage?.output ?? current?.usage?.output;
  const total = input !== undefined || output !== undefined
    ? (input ?? 0) + (output ?? 0)
    : next.usage?.total ?? current?.usage?.total;
  const usage = input !== undefined || output !== undefined || total !== undefined ? { input, output, total } : undefined;
  return { usage, elapsedSeconds: next.elapsedSeconds ?? current?.elapsedSeconds };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function parseAgentContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({ type: "text", text: value.text });
    } else if (value.type === "thinking" && typeof value.thinking === "string" && value.thinking) {
      blocks.push({ type: "thinking", thinking: value.thinking });
    } else if (value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") {
      blocks.push({
        type: "tool_call",
        toolCallId: value.id,
        toolName: value.name,
        input: value.input && typeof value.input === "object" ? value.input as Record<string, unknown> : {},
        status: "pending",
      });
    }
  }
  return blocks;
}

export class ConversationProjector {
  private turnId: string | undefined;
  private agentIndex = 0;
  private currentAgent: AgentMessage | undefined;
  private inputJson = new Map<number, string>();
  private toolNames = new Map<string, string>();

  beginTurn(turnId: string, content: string): MessageLifecycleEvent[] {
    this.turnId = turnId;
    this.agentIndex = 0;
    this.currentAgent = undefined;
    this.inputJson.clear();
    const message: UserMessage = {
      type: "user_message",
      id: turnId,
      turnId,
      timestamp: new Date().toISOString(),
      content,
      status: "completed",
    };
    return [
      { type: "message_start", message: clone(message) },
      { type: "message_end", message: clone(message) },
    ];
  }

  private ensureAgent(model?: string): { message: AgentMessage; started: boolean } | undefined {
    if (!this.turnId) return undefined;
    if (this.currentAgent) {
      if (model) this.currentAgent.model = model;
      return { message: this.currentAgent, started: false };
    }
    const message: AgentMessage = {
      type: "agent_message",
      id: `agent:${this.turnId}:${this.agentIndex++}`,
      turnId: this.turnId,
      timestamp: new Date().toISOString(),
      status: "streaming",
      model,
      content: [],
    };
    this.currentAgent = message;
    return { message, started: true };
  }

  private messageEvent(started: boolean): MessageLifecycleEvent[] {
    if (!this.currentAgent) return [];
    return [{
      type: started ? "message_start" : "message_update",
      message: clone(this.currentAgent),
    }];
  }

  private setBlock(index: number, block: ContentBlock): void {
    if (!this.currentAgent) return;
    this.currentAgent.content[index] = block;
    this.currentAgent.content = this.currentAgent.content.filter(Boolean);
  }

  private appendDelta(index: number, kind: "text" | "thinking", delta: string): void {
    if (!this.currentAgent) return;
    const current = this.currentAgent.content[index];
    if (kind === "text") {
      const text = current?.type === "text" ? current.text : "";
      this.setBlock(index, { type: "text", text: text + delta });
    } else {
      const thinking = current?.type === "thinking" ? current.thinking : "";
      this.setBlock(index, { type: "thinking", thinking: thinking + delta });
    }
  }

  private finishAgent(status: AgentMessage["status"] = "completed"): MessageLifecycleEvent[] {
    if (!this.currentAgent) return [];
    this.currentAgent.status = status;
    const event: MessageLifecycleEvent = { type: "message_end", message: clone(this.currentAgent) };
    this.currentAgent = undefined;
    this.inputJson.clear();
    return [event];
  }

  finish(status: AgentMessage["status"]): MessageLifecycleEvent[] {
    return this.finishAgent(status);
  }

  setToolStatus(toolCallId: string | undefined, status: ToolCallStatus): MessageLifecycleEvent[] {
    if (!toolCallId || !this.currentAgent) return [];
    const block = this.currentAgent.content.find(
      (item): item is ToolCallContent => item.type === "tool_call" && item.toolCallId === toolCallId,
    );
    if (!block || block.status === status) return [];
    block.status = status;
    return [{ type: "message_update", message: clone(this.currentAgent) }];
  }

  accept(raw: unknown): MessageLifecycleEvent[] {
    const message = raw as {
      type?: string;
      subtype?: string;
      message?: { content?: unknown; model?: string; usage?: unknown };
      content?: unknown;
      event?: Record<string, unknown>;
      is_error?: boolean;
    };
    if (!this.turnId) return [];

    if (message.type === "stream_event" && message.event) {
      const event = message.event;
      const eventType = String(event.type ?? "");
      const index = typeof event.index === "number" ? event.index : 0;
      const eventMessage = event.message && typeof event.message === "object"
        ? event.message as Record<string, unknown>
        : undefined;
      const agent = this.ensureAgent(typeof eventMessage?.model === "string" ? eventMessage.model : undefined);
      if (!agent) return [];
      const contentBlock = event.content_block && typeof event.content_block === "object"
        ? event.content_block as Record<string, unknown>
        : undefined;
      const delta = event.delta && typeof event.delta === "object"
        ? event.delta as Record<string, unknown>
        : undefined;

      if (eventType === "message_start") {
        this.currentAgent!.metrics = mergeMetrics(this.currentAgent!.metrics, metricsFrom({ usage: eventMessage?.usage }));
      } else if (eventType === "message_delta") {
        this.currentAgent!.metrics = mergeMetrics(this.currentAgent!.metrics, metricsFrom({ usage: event.usage }));
      } else if (eventType === "content_block_start" && contentBlock) {
        if (contentBlock.type === "text") this.setBlock(index, { type: "text", text: String(contentBlock.text ?? "") });
        if (contentBlock.type === "thinking") this.setBlock(index, { type: "thinking", thinking: String(contentBlock.thinking ?? "") });
        if (contentBlock.type === "tool_use" && typeof contentBlock.id === "string" && typeof contentBlock.name === "string") {
          this.toolNames.set(contentBlock.id, contentBlock.name);
          this.setBlock(index, {
            type: "tool_call",
            toolCallId: contentBlock.id,
            toolName: contentBlock.name,
            input: contentBlock.input && typeof contentBlock.input === "object"
              ? contentBlock.input as Record<string, unknown>
              : {},
            status: "building",
          });
        }
      } else if (eventType === "content_block_delta" && delta) {
        if (delta.type === "text_delta" && typeof delta.text === "string") this.appendDelta(index, "text", delta.text);
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") this.appendDelta(index, "thinking", delta.thinking);
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          this.inputJson.set(index, (this.inputJson.get(index) ?? "") + delta.partial_json);
        }
      } else if (eventType === "content_block_stop") {
        const block = this.currentAgent!.content[index];
        if (block?.type === "tool_call") {
          const json = this.inputJson.get(index);
          if (json) {
            try {
              block.input = JSON.parse(json) as Record<string, unknown>;
            } catch {
              block.input = {};
            }
          }
          block.status = "pending";
        }
      }
      return this.messageEvent(agent.started);
    }

    if (message.type === "assistant") {
      const agent = this.ensureAgent(message.message?.model);
      if (!agent) return [];
      const priorToolStatuses = new Map(
        this.currentAgent!.content
          .filter((block): block is ToolCallContent => block.type === "tool_call")
          .map((block) => [block.toolCallId, block.status]),
      );
      this.currentAgent!.content = parseAgentContent(message.message?.content ?? message.content).map((block) => {
        if (block.type !== "tool_call") return block;
        return { ...block, status: priorToolStatuses.get(block.toolCallId) ?? block.status };
      });
      this.currentAgent!.model = message.message?.model ?? this.currentAgent!.model;
      this.currentAgent!.metrics = mergeMetrics(this.currentAgent!.metrics, metricsFrom(message));
      for (const block of this.currentAgent!.content) {
        if (block.type === "tool_call") this.toolNames.set(block.toolCallId, block.toolName);
      }
      return this.messageEvent(agent.started);
    }

    if (message.type === "user" && Array.isArray(message.message?.content)) {
      const toolBlocks = message.message.content.filter((block) => {
        return block && typeof block === "object" && (block as { type?: string }).type === "tool_result";
      }) as Array<Record<string, unknown>>;
      if (toolBlocks.length === 0) return [];
      for (const block of toolBlocks) {
        if (typeof block.tool_use_id === "string") {
          const status = block.is_error === true ? "failed" : "completed";
          this.setToolStatus(block.tool_use_id, status);
        }
      }
      const events = this.finishAgent();
      for (let index = 0; index < toolBlocks.length; index += 1) {
        const block = toolBlocks[index];
        if (typeof block.tool_use_id !== "string") continue;
        const result: ToolResultMessage = {
          type: "tool_result",
          id: `tool-result:${this.turnId}:${block.tool_use_id}:${index}`,
          turnId: this.turnId,
          timestamp: new Date().toISOString(),
          status: block.is_error === true ? "failed" : "completed",
          toolCallId: block.tool_use_id,
          toolName: this.toolNames.get(block.tool_use_id),
          content: toolResultText(block.content),
          isError: block.is_error === true,
        };
        events.push({ type: "message_start", message: clone(result) });
        events.push({ type: "message_end", message: clone(result) });
      }
      return events;
    }

    if (message.type === "result") {
      if (this.currentAgent) this.currentAgent.metrics = mergeMetrics(this.currentAgent.metrics, metricsFrom(message));
      const status: AgentMessage["status"] = message.is_error === true || message.subtype?.startsWith("error_")
        ? "failed"
        : "completed";
      return this.finishAgent(status);
    }

    return [];
  }
}
