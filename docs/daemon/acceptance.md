# cc-agent-daemon 验收标准（Phase 1）

## 功能

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 无错
- [ ] `npm run dev -- --insecure-no-auth` 启动，`/health` 200
- [ ] WS `ping` / `auth` / `workspace.add` / `history.listSessions` 可用
- [ ] （需 API key）`session.create` 收到 `session/event`

## 稳定性

- [ ] 断连后 `session.listActive` 仍可列出会话
- [ ] `permission` 超时自动 deny
- [ ] 仅 127.0.0.1 绑定（config 强制）

## 文档

- [x] `docs/daemon/00-design.md`
- [x] `docs/daemon/tests/M01–M08`
- [x] 本验收清单