import type { ClientConnection } from "../rpc/connection.js";
import type { PermissionMode } from "../session/types.js";
import type { EffortLevel } from "../settings/reader.js";
import { readClaudePersonalSettings } from "../settings/reader.js";
import type { MetaStore, ConversationRow } from "../store/db.js";
import type { SessionRegistry } from "../session/registry.js";
import type { ActiveTurnSnapshot, SessionRunner } from "../session/runner.js";
import { loadSessionMessages } from "../history/reader.js";
import { latestAssistantModel, mapHistoryEntries } from "./messages.js";
import { meaningfulConfigEntries, resolveConversationConfig, resolveModelSelection } from "./config.js";
import type {
  ConversationMessage,
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

export function overlayActiveTurn(
  history: ConversationMessage[],
  activeTurn?: ActiveTurnSnapshot,
): ConversationMessage[] {
  if (!activeTurn) return history;
  return [
    ...history.filter((message) => !("turnId" in message && message.turnId === activeTurn.turnId)),
    ...activeTurn.messages,
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export class ConversationService {
  private spawnPromises = new Map<string, Promise<void>>();
  private sendPromises = new Map<string, Promise<{ accepted: true; conversationId: string; turnId: string }>>();
  private configMutationTails = new Map<string, Promise<void>>();

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

  private async serializeConfigMutation<T>(conversationId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.configMutationTails.get(conversationId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.configMutationTails.set(conversationId, tail);
    await previous.catch(() => {});
    try {
      return await mutation();
    } finally {
      release();
      if (this.configMutationTails.get(conversationId) === tail) this.configMutationTails.delete(conversationId);
    }
  }

  private async loadState(conversation: ConversationRow): Promise<{
    entries: ConversationMessage[];
    config: ResolvedConversationConfig;
  }> {
    const history = conversation.sdkSessionId
      ? await loadSessionMessages(conversation.sdkSessionId, conversation.workspacePath)
      : [];
    const settings = await readClaudePersonalSettings();
    const configEntries = this.store.listConversationConfigEntries(conversation.conversationId);
    const historyModel = latestAssistantModel(history);
    const config = resolveConversationConfig(settings, configEntries, historyModel);
    const historyEntries = mapHistoryEntries(history);
    const visibleConfigEntries = meaningfulConfigEntries(
      settings,
      configEntries,
      historyEntries.flatMap((message) => message.type === "agent_message" && message.model
        ? [{ model: message.model, timestamp: message.timestamp }]
        : []),
    );
    const entries: ConversationMessage[] = [
      ...historyEntries,
      ...visibleConfigEntries.map((entry): ConversationMessage => {
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

  private async loadSnapshotState(
    conversation: ConversationRow,
    runner?: SessionRunner,
  ): Promise<{
    entries: ConversationMessage[];
    config: ResolvedConversationConfig;
    activeTurn?: ActiveTurnSnapshot;
  }> {
    const turnBeforeLoad = runner?.getTurnStatus();
    let state = await this.loadState(conversation);
    let activeTurn = runner?.getActiveTurnSnapshot();

    // A result may arrive while JSONL is being read. The SDK has persisted it
    // before emitting result, so reload once when the active turn disappeared or
    // changed during the read instead of returning a stale pre-result snapshot.
    if (runner && turnBeforeLoad && turnBeforeLoad.id !== activeTurn?.turnId) {
      state = await this.loadState(conversation);
      activeTurn = runner.getActiveTurnSnapshot();
    }
    return { ...state, activeTurn };
  }

  async open(input: OpenInput, conn?: ClientConnection): Promise<ConversationSnapshot> {
    const conversation = this.ensureConversation(input);
    const runner = this.findRunner(conversation);
    if (runner) {
      runner.bindConversationId(conversation.conversationId);
      if (input.subscribe !== false && conn) runner.subscribe(conn, true);
    }
    const { entries, config, activeTurn } = await this.loadSnapshotState(conversation, runner);
    const messages = overlayActiveTurn(entries, activeTurn);
    let runtime: { state: ConversationRuntimeState; runtimeId?: string } = { state: "cold" };
    if (runner) {
      const status = runner.getStatus();
      runtime = {
        state: status === "starting" ? "spawning" : status,
        runtimeId: runner.runtimeId,
      };
    }
    const snapshot: ConversationSnapshot = {
      revision: runner?.getSequence() ?? 0,
      conversation: {
        id: conversation.conversationId,
        sdkSessionId: conversation.sdkSessionId ?? undefined,
        workspacePath: conversation.workspacePath,
      },
      runtime,
      config,
      currentTurn: activeTurn
        ? { turnId: activeTurn.turnId, status: activeTurn.status }
        : undefined,
      messages,
    };
    return snapshot;
  }

  async get(conversationId: string): Promise<ConversationSnapshot> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const runner = this.findRunner(conversation);
    const { entries, config, activeTurn } = await this.loadSnapshotState(conversation, runner);
    const messages = overlayActiveTurn(entries, activeTurn);
    let runtime: ConversationSnapshot["runtime"] = { state: "cold" };
    if (runner) {
      const status = runner.getStatus();
      runtime = {
        state: status === "starting" ? "spawning" : status,
        runtimeId: runner.runtimeId,
      };
    }
    return {
      revision: runner?.getSequence() ?? 0,
      conversation: {
        id: conversation.conversationId,
        sdkSessionId: conversation.sdkSessionId ?? undefined,
        workspacePath: conversation.workspacePath,
      },
      runtime,
      config,
      currentTurn: activeTurn
        ? { turnId: activeTurn.turnId, status: activeTurn.status }
        : undefined,
      messages,
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
    return this.serializeConfigMutation(conversationId, async () => {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) throw new Error("unknown conversation");
      const settings = await readClaudePersonalSettings();
      const selection = resolveModelSelection(model, settings);
      const { config } = await this.loadState(conversation);
      if (config.model.family === selection.family && config.model.requestedId === selection.modelId) {
        return config.model;
      }
      const runner = this.findRunner(conversation);
      if (runner) await runner.setModel(selection.modelId);
      const entry = this.store.appendConversationConfigEntry(conversation.conversationId, "model_changed", selection);
      runner?.publishMessage({
        type: "model_changed", id: entry.id, timestamp: entry.createdAt, ...selection,
      });
      return { family: selection.family, requestedId: selection.modelId, source: "conversation" };
    });
  }

  async setEffort(conversationId: string, effort: EffortLevel): Promise<ResolvedConversationConfig["effort"]> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    const runner = this.findRunner(conversation);
    if (runner) await runner.setEffort(effort);
    const entry = this.store.appendConversationConfigEntry(conversation.conversationId, "effort_changed", { effort });
    runner?.publishMessage({
      type: "effort_changed", id: entry.id, timestamp: entry.createdAt, effort,
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
    runner?.publishMessage({
      type: "permission_mode_changed", id: entry.id, timestamp: entry.createdAt, mode,
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
