# Cloud Agent Host

`@ccvibe/agent-host` 是 Cloud 的服务端 Agent Host。Claude Agent SDK、工作区访问和会话状态都运行在服务端，移动端通过 WebSocket JSON-RPC 连接。

## 启动

入口会按以下顺序执行：创建 Host、刷新 catalog、监听 TCP 端口。`SIGINT` 和 `SIGTERM` 会关闭 WebSocket、停止 Agent runtime 并释放 Host 资源。

```sh
export CCVIBE_ENV=development
export CCVIBE_HOST=127.0.0.1
export CCVIBE_PORT=8787
export CCVIBE_HOST_EPOCH=dev-local
export CCVIBE_BEARER_TOKEN="$(openssl rand -hex 32)"
export CCVIBE_ALLOWED_WORKSPACES_JSON='[{"id":"ccvibe","path":"/absolute/path/to/CCVibe","displayName":"CCVibe"}]'
export CCVIBE_MODEL_CATALOG_JSON='[{"id":"sonnet","displayName":"Claude Sonnet","capabilities":["adaptive-thinking"]}]'
export CCVIBE_DEFAULT_MODEL_ID=sonnet

npm run build
npm start
```

也可以使用 `npm run start:dev` 或 `npm run start:prod`。这两个脚本都会先构建当前包；脚本不会替换已经设置的 `CCVIBE_ENV`。

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `CCVIBE_ENV` | 否 | `development`、`test` 或 `production`，默认 `development` |
| `CCVIBE_HOST` | 否 | 默认 `127.0.0.1`；开发环境绑定公网地址需显式设置 `CCVIBE_ALLOW_PUBLIC_DEV=true` |
| `CCVIBE_PORT` | 否 | `1` 至 `65535`，默认 `8787` |
| `CCVIBE_HOST_EPOCH` | 否 | Host 实例 epoch；未设置时由启动入口生成新的 UUID |
| `CCVIBE_BEARER_TOKEN` | 生产必需 | 只接受 `Authorization: Bearer <token>`；不会放入 URL、响应或日志 |
| `CCVIBE_ALLOW_ANONYMOUS_DEV` | 否 | 仅开发/测试环境有效，必须为 `true` 才允许无 token 启动 |
| `CCVIBE_ALLOW_PUBLIC_DEV` | 否 | 仅开发/测试环境有效，用于明确确认公网绑定风险 |
| `CCVIBE_ALLOWED_WORKSPACES_JSON` | 生产必需 | 工作区数组；只列出的绝对路径可通过 catalog 创建会话 |
| `CCVIBE_MODEL_CATALOG_JSON` | 生产必需 | 模型目录数组；模型 ID 必须是部署允许使用的值 |
| `CCVIBE_DEFAULT_MODEL_ID` | 否 | 必须存在于模型目录；未设置时使用目录第一项 |

工作区 JSON 项支持 `id`、`path`、`displayName` 和可选 `status`（`available`/`unavailable`）。模型 JSON 项支持 `id`、`displayName`、可选 `description` 和能力标签 `effort`、`adaptive-thinking`、`fast-mode`、`auto-mode`。也可用 `CCVIBE_WORKSPACES_JSON` 和 `CCVIBE_MODELS_JSON` 作为前两个 JSON 变量的兼容别名。

配置解析是无 I/O 的纯函数；它不会替代部署权限。运行用户仍必须对允许的工作区拥有正确的文件系统权限，生产环境建议用专用非 root 用户运行。

## 开发与生产

开发默认只监听回环地址。若需要局域网调试，显式设置 `CCVIBE_HOST` 和 `CCVIBE_ALLOW_PUBLIC_DEV=true`，同时仍建议配置 Bearer token。

生产环境必须配置 Bearer token 和至少一个工作区/模型。服务本身提供 HTTP/WebSocket，公网部署应放在 TLS 反向代理之后，由代理提供 `wss://`；移动端连接地址形如 `wss://host.example/ws`，token 通过 WebSocket 的 `Authorization` header 发送，不能拼接 `?token=...`。

示例 systemd 单元：

```ini
[Unit]
Description=Cloud Agent Host
After=network.target

[Service]
Type=simple
User=cloud-agent
WorkingDirectory=/srv/cloud-agent-host
EnvironmentFile=/etc/cloud-agent-host.env
ExecStart=/usr/bin/node /srv/cloud-agent-host/dist/bin/agent-host.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/cloud-agent-host.env` 应由部署系统注入并限制权限（例如 `0600`），不要把真实 token 提交到仓库。反向代理、进程管理器和密钥注入系统各自负责 TLS、重启策略和 secret rotation。

## 包命令

- `npm run typecheck`：TypeScript 严格类型检查。
- `npm test`：Vitest 单元/协议/传输测试。
- `npm run build`：生成 `dist`，并提供 `ccvibe-agent-host` bin。
- `npm start`：运行已构建的生产入口。
