# Phase 6：Overlay Persistence、Receipts 与恢复

> 状态：执行中（2026-08-27）  
> 目标：持久化产品 overlay，SDK transcript 仍是对话正文事实源

## 契约

- SQLite 仅保存 `chatUri -> sdkSessionId`、cwd/roots、模型/effort/permission、title/archive、命令 receipt 与审批审计；不得存 token/action 正文。
- 所有 SQL 入参参数化；migration 版本单调且可重复执行；schema 不依赖 transport connection ID。
- 写路径先提交事务，再广播 action。事务失败不改变内存权威状态、也不 fanout。
- 重启采用新 host epoch + snapshot；不会假装恢复已死亡的 SDK permission Promise。active turn 明确 interrupted。
- storage 的 encode/decode、row validation、migration selection 都为纯函数，`src/domain` 不依赖 SQLite。
- 为避免破坏 Phase 4.5 的同步 API，既有 `createChat()` 保持纯内存、同步且不隐式写库；新增 `createChatPersisted()` / `loadPersistedChats()` / `disposeChatPersisted()` 作为 awaitable 生产路径。创建路径必须先事务提交，再注册内存 backing，不能出现“写库失败而 chat 已对客户端可见”。

## 切片

1. `persistence/schema/store`：SQLite port、纯 row codecs、migrations 与 unit tests。
2. `overlay repository`：ChatBacking/config/receipt/audit repository 与 restart fixture tests。
3. `host integration`：create/load/delete chat 事务边界、after-commit fanout、shutdown flush；不触碰 SDK transcript mapper。

验收命令：`npm run typecheck && npm test && npm run build && npm audit --omit=dev`。

## 完成记录

交付了注入式 SQLite port、三组幂等 migration、纯 row codec，以及 transaction-scoped overlay repository。它只存 chat backing/config、command receipt 和 content-free approval audit；SDK transcript、token stream 与 action body 不进入此存储。

Host 现在提供 `createChatPersisted()`、`loadPersistedChats()` 与 `disposeChatPersisted()`：持久化创建先 commit 再注册内存对象；恢复保留原始 `sdkSessionId` 和 materialized lifecycle，后续首次 send 走 SDK resume；删除在 durable commit 后释放 runtime。旧的 `createChat()` 保持同步的内存 API，以避免静默破坏 Phase 4.5 调用方。

最终验证：

```text
npm run typecheck        PASS
npm test                 PASS — 35 files, 317 tests
npm run build            PASS
npm audit --omit=dev     PASS — 0 vulnerabilities
```
