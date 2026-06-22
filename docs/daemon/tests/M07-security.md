# M07 security 测试用例

| ID | 类型 | 用例 | 预期 |
|---|---|---|---|
| SC1 | 单元 | validateToken null 模式 | true |
| SC2 | 单元 | token 匹配/不匹配 | true/false |
| SC3 | 单元 | cwd 不在白名单 | throw allowlist |
| SC4 | 单元 | cwd 在白名单子目录 | 通过 |

实现：`src/security/auth.test.ts`、`src/security/workspaceGuard.test.ts`。