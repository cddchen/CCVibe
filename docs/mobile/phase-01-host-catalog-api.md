# Phase 1：Host Catalog 与会话创建 API

> 状态：已完成（2026-08-29，Host 44 个测试文件、391 项测试及构建通过）  
> 写入范围：`repos/cc-agent-host/src/{catalog,protocol,claude}/**` 及对应测试

## 目标

让 `agent-root://` 成为首页 canonical state，而不是协议占位符；提供幂等的新建 provisional chat 命令。

## 状态合同

`RootCatalogState` 至少包含：

- Host identity、connection/display status。
- `workspaces[]`：稳定 ID、规范化路径、display name、可用状态。
- `sessions[]`：`ChatUri`、SDK session opaque ref 的非敏感投影、workspace ID、title、updatedAt、status、archived。
- `models[]`：SDK 返回的稳定 model ID、display name、能力标签；`defaultModelId`。

SDK listSessions/model 返回值通过 SDK 自带类型推导并在 `src/claude` 投影，raw 值不能进入 protocol/domain。

## 命令合同

- 新增 `catalog/createChat` 或等价严格 schema action：workspace、model、可选初始 prompt、`clientSeq`、`commandId`。
- create 只建立 provisional backing，返回 `ChatUri`；只有首个 send 才 materialize Query。
- 同一 `clientId + commandId` 重试返回同一 `ChatUri`。
- workspace 不存在、model 不支持、越权和非法路径返回稳定 rejection code。
- catalog action 与 chat action 共用 Host 全局 `serverSeq`，并保持订阅屏障语义。

## 测试优先清单

1. root snapshot 与并发 catalog action 使用同一切点。
2. SDK session/model fixtures 正确投影且不泄露 raw SDK 对象。
3. create retry/concurrency 只创建一个 backing。
4. create 不启动 SDK query；首个 send 才启动。
5. 新会话动作可被多个 root subscriber 看到。
6. 未授权 workspace/create 不执行副作用、不消耗序号。

## 退出条件

- root initialize/subscribe/reconnect 不再返回 missing。
- 两个客户端看到相同 catalog state 和同一新会话。
- Host typecheck/test/build 全绿，API 文档同步更新。
