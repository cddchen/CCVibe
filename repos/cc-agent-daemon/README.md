# CCLink

自托管的 Claude 会话中枢。CCLink 在**你自己的机器**上跑 Claude（基于 Claude Agent SDK），把会话能力通过一个端口同时暴露成 **Web UI** 和 **WebSocket**，让你从任何设备连上来管理和续聊。

## 功能

- **单端口、一条命令**：daemon 同时托管 Web 界面与 WebSocket，`npx` 一把启动，无需分别起前后端。
- **多端接入**：电脑 / 手机浏览器 / Mac App 都能连同一个服务。
- **本机执行**：用你自己的 Claude 授权、访问你自己的文件，数据不经第三方。
- **会话管理**：添加工作目录、按目录浏览会话、新对话 / 续聊，支持切换模型与思考强度（effort）、工具权限确认。

## 前置要求

- **Node.js ≥ 22.4**（`node -v` 检查；macOS 可 `brew install node`）
- **Claude 授权**，二选一：
  - 环境变量 `ANTHROPIC_API_KEY=sk-ant-...`，或
  - 事先执行 `claude login`（Claude 订阅登录）

  > 没有授权时能连上、但第一次对话会失败。

## 安装与启动

一条命令启动（`<token>` 自定义，用于客户端登录鉴权）：

```bash
npx @cddchen/cclink --listen 0.0.0.0:4733 --token <token>
```

浏览器打开 `http://<本机IP>:4733`，登录页填入同一个 token 即可（Web 与 WebSocket 同源，自动连 `ws://<host>:4733/ws`）。

- **仅本机使用**：把 `0.0.0.0` 换成 `127.0.0.1`。
- **对外 / 局域网暴露**：请用随机 token，勿用固定弱口令：
  ```bash
  npx @cddchen/cclink --listen 0.0.0.0:4733 --token "$(openssl rand -hex 16)"
  ```

## 后台服务（开机自启，macOS）

用 launchd 让 CCLink 常驻：关终端、重启电脑都自动运行，崩溃自动拉起。

**1. 全局安装**（给服务一个稳定路径）

```bash
npm i -g @cddchen/cclink
```

**2. 生成并加载 LaunchAgent**（自动探测 node / cclink 路径；改 `TOKEN` 即可）

```bash
TOKEN="cddchen"
NODE_BIN="$(command -v node)"
CCLINK_BIN="$(command -v cclink)"
PLIST="$HOME/Library/LaunchAgents/com.cclink.daemon.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.cclink"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cclink.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$CCLINK_BIN</string>
    <string>--listen</string><string>0.0.0.0:4733</string>
    <string>--token</string><string>$TOKEN</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.cclink/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.cclink/daemon.err.log</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
echo "已加载: $PLIST (TOKEN=$TOKEN)"
```

**3. 确认运行**

```bash
sleep 2 && curl -s http://127.0.0.1:4733/health && tail -3 ~/.cclink/daemon.log
```

看到 `{"ok":true}` 和 `CCLink listening on http://0.0.0.0:4733` 即成功。

### 服务管理

| 操作 | 命令 |
|---|---|
| 查看状态 | `launchctl list \| grep cclink` |
| 看日志 | `tail -f ~/.cclink/daemon.log` |
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.cclink.daemon.plist` |
| 启动 | `launchctl load ~/Library/LaunchAgents/com.cclink.daemon.plist` |
| 改配置后重启 | 先 `unload` 再 `load` |
| 升级版本 | `npm i -g @cddchen/cclink@latest`，再 `unload` + `load` |
| 卸载 | `launchctl unload …/com.cclink.daemon.plist && rm …/com.cclink.daemon.plist` |

> 提示：plist 里的 token 为明文（文件在你家目录、权限私有）。也可改用环境变量 `CCLINK_TOKEN`：在 `<dict>` 内加 `<key>EnvironmentVariables</key><dict><key>CCLINK_TOKEN</key><string>xxx</string></dict>`，并删掉 `--token` 两行。
