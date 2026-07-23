import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionMode } from "../session/types.js";
import type { EffortLevel } from "../settings/reader.js";
import { readClaudePersonalSettings } from "../settings/reader.js";
import type { MetaStore, ConversationRow } from "../store/db.js";
import type { SessionRegistry } from "../session/registry.js";
import { loadSessionMessages } from "../history/reader.js";
import { latestAssistantModel, mapHistoryEntries } from "./messages.js";
import { resolveConversationConfig, resolveModelSelection } from "./config.js";
import type {
  ConversationEntry,
  ConversationRuntimeState,
  ConversationSnapshot,
  ModelFamily,
  ResolvedConversationConfig,
} from "./types.js";

type OpenInput = {
  conversationId?: string;
  workspacePath: string;
  subscribe?: boolean;
};

export class ConversationService {
  private spawnPromises = new Map<string, Promise<void>>();
  private sendPromises = new Map<string, Promise<{ accepted: true; conversationId: string; turnId: string }>>();

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly store: MetaStore,
  ) {}

  private ensureConversation(input: OpenInput): ConversationRow {
    if (!input.conversationId) return this.store.createConversation(input.workspacePath);
    const existing = this.store.getConversation(input.conversationId);
    if (existing) return existing;
    return this.store.ensureConversation(input.conversationId, input.workspacePath, input.conversationId);
  }

  private findRunner(conversation: ConversationRow) {
    return this.sessions.get(conversation.conversationId)
      ?? (conversation.sdkSessionId ? this.sessions.get(conversation.sdkSessionId) : undefined);
  }

  private async loadState(conversation: ConversationRow): Promise<{
    entries: ConversationEntry[];
    config: ResolvedConversationConfig;
  }> {
    const history = conversation.sdkSessionId
      ? await loadSessionMessages(conversation.sdkSessionId, conversation.workspacePath)
      : [];
    const settings = await readClaudePersonalSettings();
    const configEntries = this.store.listConversationConfigEntries(conversation.conversationId);
    const config = resolveConversationConfig(settings, configEntries, latestAssistantModel(history));
    const entries: ConversationEntry[] = [
      ...mapHistoryEntries(history),
      ...configEntries.map((entry): ConversationEntry => {
        if (entry.type === "model_changed") return {
            type: "model_changed",
            id: entry.id,
            timestamp: entry.createdAt,
            family: (entry.payload.family ?? "sonnet") as ModelFamily,
            modelId: String(entry.payload.modelId ?? "sonnet"),
          };
        if (entry.type === "effort_changed") return {
            type: "effort_changed",
            id: entry.id,
            timestamp: entry.createdAt,
            effort: String(entry.payload.effort ?? "high") as EffortLevel,
          };
        return {
          type: "permission_mode_changed",
          id: entry.id,
          timestamp: entry.createdAt,
          mode: String(entry.payload.mode ?? "default") as PermissionMode,
        };
      }),
    ].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
    return { entries, config };
  }

  async open(input: OpenInput, conn?: ClientConnection): Promise<ConversationSnapshot> {
    const conversation = this.ensureConversation(input);
    const runner = this.findRunner(conversation);
    if (runner) {
      runner.bindConversationId(conversation.conversationId);
      if (input.subscribe !== false && conn) runner.subscribe(conn, true);
    }
    const { entries, config } = await this.loadState(conversation);
    const turn = runner?.getTurnStatus();
    let runtime: { state: ConversationRuntimeState; runtimeId?: string } = { state: "cold" };
    if (runner) {
      const status = runner.getStatus();
      runtime = {
        state: status === "starting" ? "spawning" : status,
        runtimeId: runner.runtimeId,
      };
    }
    return {
      conversation: {
        id: conversation.conversationId,
        sdkSessionId: conversation.sdkSessionId ?? undefined,
        workspacePath: conversation.workspacePath,
      },
      runtime,
      config,
      currentTurn: turn ? { turnId: turn.id, status: turn.status } : undefined,
      messages: entries,
    };
  }

  async get(conversationId: string): Promise<ConversationSnapshot> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const runner = this.findRunner(conversation);
    const { entries, config } = await this.loadState(conversation);
    const turn = runner?.getTurnStatus();
    let runtime: ConversationSnapshot["runtime"] = { state: "cold" };
    if (runner) {
      const status = runner.getStatus();
      runtime = {
        state: status === "starting" ? "spawning" : status,
        runtimeId: runner.runtimeId,
      };
    }
    return {
      conversation: {
        id: conversation.conversationId,
        sdkSessionId: conversation.sdkSessionId ?? undefined,
        workspacePath: conversation.workspacePath,
      },
      runtime,
      config,
      currentTurn: turn ? { turnId: turn.id, status: turn.status } : undefined,
      messages: entries,
    };
  }

  private async ensureRuntime(
    conversation: ConversationRow,
    config: ResolvedConversationConfig,
    conn: ClientConnection,
  ): Promise<void> {
    const pending = this.spawnPromises.get(conversation.conversationId);
    if (pending) {
      await pending;
      const runner = this.findRunner(conversation);
      runner?.subscribe(conn, true);
      return;
    }
    const existing = this.findRunner(conversation);
    if (existing) {
      existing.bindConversationId(conversation.conversationId);
      existing.subscribe(conn, true);
      return;
    }
    const spawn = (async () => {
      await this.sessions.create(
        {
          cwd: conversation.workspacePath,
          resumeSessionId: conversation.sdkSessionId ?? undefined,
          model: config.model.requestedId,
          effort: config.effort.requested,
          permissionMode: config.permissionMode,
          settingSources: ["user", "project"],
        },
        conn,
        undefined,
        (sdkSessionId) => {
          this.store.bindConversationSdkSession(conversation.conversationId, sdkSessionId);
          this.store.migrateSessionMeta(conversation.conversationId, sdkSessionId, conversation.workspacePath);
        },
        conversation.conversationId,
      );
    })().finally(() => this.spawnPromises.delete(conversation.conversationId));
    this.spawnPromises.set(conversation.conversationId, spawn);
    return spawn;
  }

  private async sendOnce(
    conversationId: string,
    content: string,
    conn: ClientConnection,
  ): Promise<{ accepted: true; conversationId: string; turnId: string }> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const { config } = await this.loadState(conversation);
    await this.ensureRuntime(conversation, config, conn);
    const runner = this.findRunner(conversation) ?? this.sessions.get(conversation.conversationId);
    if (!runner) throw new Error("conversation runtime failed to start");
    const { turnId } = await runner.send(content);
    return { accepted: true, conversationId: conversation.conversationId, turnId };
  }

  async send(
    conversationId: string,
    content: string,
    conn: ClientConnection,
    clientMessageId?: string,
  ): Promise<{ accepted: true; conversationId: string; turnId: string }> {
    if (!clientMessageId) return this.sendOnce(conversationId, content, conn);

    const stored = this.store.getConversationSendReceipt(conversationId, clientMessageId);
    if (stored) {
      if (stored.content !== content) throw new Error("clientMessageId was already used with different content");
      return { accepted: true, conversationId, turnId: stored.turnId };
    }

    const key = JSON.stringify([conversationId, clientMessageId]);
    const pending = this.sendPromises.get(key);
    if (pending) return pending;
    const send = this.sendOnce(conversationId, content, conn)
      .then((result) => {
        this.store.saveConversationSendReceipt(conversationId, clientMessageId, content, result.turnId);
        return result;
      })
      .finally(() => this.sendPromises.delete(key));
    this.sendPromises.set(key, send);
    return send;
  }

  async setModel(conversationId: string, model: string): Promise<ResolvedConversationConfig["model"]> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const settings = await readClaudePersonalSettings();
    const selection = resolveModelSelection(model, settings);
    const runner = this.findRunner(conversation);
    if (runner) await runner.setModel(selection.modelId);
    const entry = this.store.appendConversationConfigEntry(conversation.conversationId, "model_changed", selection);
    runner?.notify("conversation/event", {
      conversationId: conversation.conversationId,
      entry: { type: "model_changed", id: entry.id, timestamp: entry.createdAt, ...selection },
    });
    return { family: selection.family, requestedId: selection.modelId, source: "conversation" };
  }

  async setEffort(conversationId: string, effort: EffortLevel): Promise<ResolvedConversationConfig["effort"]> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const runner = this.findRunner(conversation);
    if (runner) await runner.setEffort(effort);
    const entry = this.store.appendConversationConfigEntry(conversation.conversationId, "effort_changed", { effort });
    runner?.notify("conversation/event", {
      conversationId: conversation.conversationId,
      entry: { type: "effort_changed", id: entry.id, timestamp: entry.createdAt, effort },
    });
    return { requested: effort, effective: effort, source: "conversation" };
  }

  async setPermissionMode(conversationId: string, mode: PermissionMode): Promise<void> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const runner = this.findRunner(conversation);
    if (runner) await runner.setPermissionMode(mode);
    const entry = this.store.appendConversationConfigEntry(
      conversation.conversationId,
      "permission_mode_changed",
      { mode },
    );
    runner?.notify("conversation/event", {
      conversationId: conversation.conversationId,
      entry: { type: "permission_mode_changed", id: entry.id, timestamp: entry.createdAt, mode },
    });
  }

  async interrupt(conversationId: string) {
    const conversation = this.store.getConversation(conversationId);
    const runner = conversation ? this.findRunner(conversation) : undefined;
    if (!runner) throw new Error("conversation runtime is not active");
    return runner.interrupt();
  }

  detach(conversationId: string, connId: string): void {
    const conversation = this.store.getConversation(conversationId);
    const runner = conversation ? this.findRunner(conversation) : undefined;
    runner?.unsubscribe(connId);
  }
}
