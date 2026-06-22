# M02 rpc 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| R1 | 单元 | `ping` | `{ok:true}` |
| R2 | 单元 | 未知 method | `-32601` |
| R3 | 单元 | 有 token 未 auth 调 `workspace.list` | `-32001` |
| R4 | 单元 | `auth` 正确 token | `authenticated=true` |
| R5 | 单元 | Zod 非法 params | `-32602` |
| R6 | 单元 | `permissionRespondParams` numeric id | 通过校验 |

实现：`src/rpc/router.test.ts`、`src/rpc/schemas.test.ts`。