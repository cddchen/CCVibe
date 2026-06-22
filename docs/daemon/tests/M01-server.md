# M01 server 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| S1 | 单元 | `/health` 返回 `{ok:true}` | 200 + JSON |
| S2 | 集成 | 非 loopback `--listen` 启动失败 | 进程退出并报错 |
| S3 | 集成 | 无 token 且无 `--insecure-no-auth` 启动失败 | 报错 |
| S4 | 集成 | 错误 WS token | close 4401 |
| S5 | 集成 | 优雅 SIGTERM | 端口释放、store.close |

实现：`src/server.ts`（集成用例可后续 `server.integration.test.ts`）。