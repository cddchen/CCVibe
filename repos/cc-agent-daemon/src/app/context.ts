import type { DaemonConfig } from "../config.js";
import { MetaStore } from "../store/db.js";
import { PermissionRegistry } from "../permission/registry.js";
import { SessionRegistry } from "../session/registry.js";
import { createClaudeEngine } from "../session/claudeEngine.js";
import { loadOrCreateToken } from "../security/auth.js";

export type AppContext = {
  config: DaemonConfig;
  token: string | null;
  store: MetaStore;
  permissions: PermissionRegistry;
  sessions: SessionRegistry;
};

export function createAppContext(config: DaemonConfig): AppContext {
  const token = config.insecureNoAuth ? null : loadOrCreateToken(config.dataDir, config.token);
  const store = new MetaStore(config.dataDir);
  const permissions = new PermissionRegistry();
  const sessions = new SessionRegistry(() => createClaudeEngine(), permissions);
  return { config, token, store, permissions, sessions };
}