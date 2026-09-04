# Cloud Agent Host

`@cddchen/cloud` 是 Cloud 的服务端 Agent Host。Claude Agent SDK、工作区访问和会话状态都运行在服务端，移动端通过 WebSocket JSON-RPC 连接。

## 启动

入口会按以下顺序执行：创建 Host、刷新 catalog、监听 TCP 端口。`SIGINT` 和 `SIGTERM` 会关闭 WebSocket、停止 Agent runtime 并释放 Host 资源。

发布后可直接使用 npx 启动。`start` 默认会在后台运行，自动选择本机的局域网 IPv4 地址并打印连接信息：

```sh
npx @cddchen/cloud start
```

未传入 `--token` 或 `CCVIBE_BEARER_TOKEN` 时，CLI 会生成一个随机六位数字 token 并打印在终端。客户端必须在 WebSocket 握手时发送 `Authorization: Bearer <token>`。为便于局域网手动配对，该默认 token 较短；仅应在受信任网络中使用。

显式设置 token 仍然可用：

```sh
npx @cddchen/cloud start --token=xxx
```

`--host 0.0.0.0` 无需再设置任何环境变量。`--global` 是它的简写，会绑定所有网络接口；其余可选参数为 `--host`、`--port`、`--env` 和 `--foreground`，既支持 `--port=8787`，也支持 `--port 8787`。CLI 参数优先于同名 `CCVIBE_*` 环境变量。运行 `npx @cddchen/cloud --help` 查看帮助。

后台服务的 PID 和非敏感运行信息保存在 `~/.cddchen/cloud/`，日志位于 `~/.cddchen/cloud/server.log`：

```sh
npx @cddchen/cloud status
npx @cddchen/cloud stop
```

需要在当前终端运行时，加入 `--foreground`：

```sh
npx @cddchen/cloud start --foreground
```

从源码启动：

```sh
npm run build
npm start
```

通过 npm 启动时，额外 CLI 参数必须放在 `--` 之后；否则 npm 不会将它们传给 `cloud`。例如局域网所有网卡监听：

```sh
npm run start -- --token=cddchen --global
```

`--global` 仅控制 Host 的监听地址，不会发布 mDNS/Bonjour 广播；移动端当前也没有自动扫描局域网 Host。请在移动端“新增 Host”中手动填入启动输出的 `ws://<局域网 IPv4>:8787/ws`，并开启“开发模式”，再填写同一 Token。可用以下命令检查和停止后台实例：

```sh
npm run status
npm run stop
```

默认情况下，Host 会调用 Claude Agent SDK 的 `listSessions()`，从已有会话的
绝对 `cwd` 自动发现并去重工作区，再从 SDK Query 初始化结果读取模型目录。
没有任何历史会话时 SDK 无法推断目录，此时需要显式配置工作区才能创建新会话。

也可以使用 `npm run start:dev` 或 `npm run start:prod`。这两个脚本都会先构建当前包；`start:prod` 默认设置 `--env=production --foreground`，适合 systemd 等进程管理器。

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `CCVIBE_ENV` | 否 | `development`、`test` 或 `production`，默认 `development` |
| `CCVIBE_HOST` | 否 | npx CLI 默认自动选择局域网 IPv4；`--global` 或 `--host 0.0.0.0` 绑定全部接口 |
| `CCVIBE_PORT` | 否 | `1` 至 `65535`，默认 `8787` |
| `CCVIBE_HOST_EPOCH` | 否 | Host 实例 epoch；未设置时由启动入口生成新的 UUID |
| `CCVIBE_BEARER_TOKEN` | 否 | CLI 未提供时自动生成并打印六位数字；只接受 `Authorization: Bearer <token>`；不会放入 URL、响应或日志 |
| `CCVIBE_ALLOW_ANONYMOUS_DEV` | 否 | 仅开发/测试环境有效，必须为 `true` 才允许无 token 启动 |
| `CCVIBE_ALLOW_PUBLIC_DEV` | 否 | 仅开发/测试环境有效，用于明确确认公网绑定风险 |
| `CCVIBE_ALLOWED_WORKSPACES_JSON` | 否 | 非空时作为显式工作区覆盖/访问约束；未配置或空数组时从 SDK 会话 `cwd` 自动发现 |
| `CCVIBE_MODEL_CATALOG_JSON` | 否 | 非空时作为显式模型覆盖；未配置或空数组时从 SDK Query 自动发现 |
| `CCVIBE_DEFAULT_MODEL_ID` | 否 | 显式目录中必须存在；SDK 自动目录中存在时优先使用，否则使用目录第一项 |

工作区 JSON 项支持 `id`、`path`、`displayName` 和可选 `status`（`available`/`unavailable`）。模型 JSON 项支持 `id`、`displayName`、可选 `description` 和能力标签 `effort`、`adaptive-thinking`、`fast-mode`、`auto-mode`。也可用 `CCVIBE_WORKSPACES_JSON` 和 `CCVIBE_MODELS_JSON` 作为前两个 JSON 变量的兼容别名。

配置解析是无 I/O 的纯函数；它不会替代部署权限。运行用户仍必须对允许的工作区拥有正确的文件系统权限，生产环境建议用专用非 root 用户运行。

## 开发与生产

CLI 默认监听检测到的局域网地址。使用 `--global` 或 `--host 0.0.0.0` 时会监听所有网络接口，并自动完成开发模式所需的确认；仍建议使用明确的高熵 Bearer token。

生产环境必须配置 Bearer token；工作区和模型默认由 SDK 自动发现，显式 JSON 仍可用于覆盖/约束。服务本身提供 HTTP/WebSocket，公网部署应放在 TLS 反向代理之后，由代理提供 `wss://`；移动端连接地址形如 `wss://host.example/ws`，token 通过 WebSocket 的 `Authorization` header 发送，不能拼接 `?token=...`。

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
ExecStart=/usr/bin/node /srv/cloud-agent-host/dist/bin/cloud.js start --foreground
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
- `npm run build`：生成 `dist`，并提供 `cloud` bin。
- `npm start`：以后台模式运行已构建的服务入口。
- `npm run status`：显示后台 Host 的连接地址和日志路径。
- `npm run stop`：向后台 Host 发送 `SIGTERM`，等待其完成清理后退出。
- `npm run start:prod`：以适合进程管理器的前台生产模式运行。
- `npm pack --dry-run`：检查将发布到 npm 的文件。
