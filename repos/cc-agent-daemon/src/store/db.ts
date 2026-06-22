import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type WorkspaceRow = {
  id: string;
  path: string;
  createdAt: string;
};

export type SessionMetaRow = {
  sessionId: string;
  workspacePath: string;
  customName: string | null;
  pinned: number;
  archived: number;
  createdAt: string;
  updatedAt: string;
};

export class MetaStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "meta.db"));
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        custom_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_folder (
        session_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY (session_id, folder_id)
      );
    `);
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db
      .prepare(`SELECT id, path, created_at as createdAt FROM workspaces ORDER BY created_at`)
      .all() as WorkspaceRow[];
  }

  addWorkspace(path: string): WorkspaceRow {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      throw new Error(`workspace path is not a directory: ${path}`);
    }
    const normalizedPath = realpathSync(path);
    const existing = this.db
      .prepare(`SELECT id, path, created_at as createdAt FROM workspaces WHERE path = ?`)
      .get(normalizedPath) as WorkspaceRow | undefined;
    if (existing) return existing;

    const row: WorkspaceRow = {
      id: randomUUID(),
      path: normalizedPath,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`)
      .run(row.id, row.path, row.createdAt);
    return row;
  }

  /** Idempotent: register path for session.create allowlist */
  ensureWorkspace(path: string): WorkspaceRow {
    return this.addWorkspace(path);
  }

  removeWorkspace(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  getWorkspacePaths(): string[] {
    return this.listWorkspaces().map((w) => w.path);
  }

  upsertSessionMeta(
    sessionId: string,
    workspacePath: string,
    patch: { customName?: string; pinned?: boolean; archived?: boolean },
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT session_id FROM session_meta WHERE session_id = ?`)
      .get(sessionId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO session_meta (session_id, workspace_path, custom_name, pinned, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          workspacePath,
          patch.customName ?? null,
          patch.pinned ? 1 : 0,
          patch.archived ? 1 : 0,
          now,
          now,
        );
      return;
    }
    const cur = this.db
      .prepare(`SELECT custom_name as customName, pinned, archived FROM session_meta WHERE session_id = ?`)
      .get(sessionId) as { customName: string | null; pinned: number; archived: number };
    this.db
      .prepare(
        `UPDATE session_meta SET custom_name = ?, pinned = ?, archived = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(
        patch.customName !== undefined ? patch.customName : cur.customName,
        patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
        patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived,
        now,
        sessionId,
      );
  }

  migrateSessionMeta(fromSessionId: string, toSessionId: string, workspacePath: string): void {
    if (fromSessionId === toSessionId) return;
    const now = new Date().toISOString();
    const from = this.db
      .prepare(`SELECT workspace_path as workspacePath, custom_name as customName, pinned, archived, created_at as createdAt FROM session_meta WHERE session_id = ?`)
      .get(fromSessionId) as Omit<SessionMetaRow, "sessionId" | "updatedAt"> | undefined;
    const to = this.db
      .prepare(`SELECT session_id FROM session_meta WHERE session_id = ?`)
      .get(toSessionId);

    if (!to) {
      this.db
        .prepare(
          `INSERT INTO session_meta (session_id, workspace_path, custom_name, pinned, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          toSessionId,
          from?.workspacePath ?? workspacePath,
          from?.customName ?? null,
          from?.pinned ?? 0,
          from?.archived ?? 0,
          from?.createdAt ?? now,
          now,
        );
    } else if (from) {
      this.db
        .prepare(
          `UPDATE session_meta SET
             workspace_path = ?,
             custom_name = COALESCE(custom_name, ?),
             pinned = CASE WHEN pinned = 1 THEN 1 ELSE ? END,
             archived = CASE WHEN archived = 1 THEN 1 ELSE ? END,
             updated_at = ?
           WHERE session_id = ?`,
        )
        .run(from.workspacePath, from.customName, from.pinned, from.archived, now, toSessionId);
    }

    this.db.prepare(`UPDATE OR IGNORE session_folder SET session_id = ? WHERE session_id = ?`).run(toSessionId, fromSessionId);
    this.deleteSessionMeta(fromSessionId);
  }

  getSessionMeta(sessionId: string): SessionMetaRow | undefined {
    return this.db
      .prepare(
        `SELECT session_id as sessionId, workspace_path as workspacePath, custom_name as customName, pinned, archived, created_at as createdAt, updated_at as updatedAt
         FROM session_meta WHERE session_id = ?`,
      )
      .get(sessionId) as SessionMetaRow | undefined;
  }

  deleteSessionMeta(sessionId: string): void {
    this.db.prepare(`DELETE FROM session_meta WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM session_folder WHERE session_id = ?`).run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}