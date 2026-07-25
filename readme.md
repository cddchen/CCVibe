# CCVibe

CCVibe 让你可以从浏览器、Android 手机或 Mac 连接到自己电脑上的 Claude，在不同设备之间查看会话、继续对话并处理工具权限。

Claude 仍然运行在你自己的电脑上，并使用你自己的 Claude 账号或 API Key。只需在电脑上启动一次 CCLink 服务，同一局域网内的设备就可以连接使用。

## 功能

- 在 Web、Android 和 macOS 上使用 Claude
- 查看并继续本机已有会话
- 在多个设备之间同步当前对话状态
- 支持模型、思考强度和权限模式切换
- 支持工具调用确认、拒绝和问题回答
- 服务端自动管理会话资源

## 安装前准备

运行 CCLink 服务的电脑需要：

- Node.js 22.4 或更高版本
- 可用的 Claude 账号登录状态或 Anthropic API Key
- 与客户端设备处于同一局域网

如果尚未登录 Claude，请先安装 Claude Code 并执行：

```bash
claude login
```

也可以使用 Anthropic API Key：

```bash
export ANTHROPIC_API_KEY="你的 API Key"
```

## 启动 CCLink 服务

在需要运行 Claude 的电脑上执行：

```bash
npx @cddchen/cclink@latest \
  --listen 0.0.0.0:4733 \
  --token "设置一个登录密码"
```

服务启动后，请保持终端窗口运行。

如果只在当前电脑上使用，可以改为：

```bash
npx @cddchen/cclink@latest \
  --listen 127.0.0.1:4733 \
  --token "设置一个登录密码"
```

建议使用不容易猜到的随机密码：

```bash
openssl rand -hex 16
```

## 使用 Web

在运行服务的电脑上打开：

```text
http://localhost:4733
```

在局域网其他设备上，将 `电脑IP` 替换成运行 CCLink 服务的电脑地址：

```text
http://电脑IP:4733
```

登录时输入启动服务时设置的 Token。

## 安装 Android App

1. 打开 [CCVibe Releases](https://github.com/cddchen/CCVibe/releases/latest)。
2. 下载名称以 `.apk` 结尾的 Android 安装包。
3. 在手机上打开 APK 并完成安装。
4. 如果系统提示禁止安装未知来源应用，请按提示为当前浏览器或文件管理器授权。
5. 打开 App，填写运行 CCLink 服务的电脑 IP、端口 `4733` 和 Token。

Android 手机不能使用 `localhost` 或 `127.0.0.1` 连接电脑，请填写电脑的局域网 IP。

## 安装 macOS App

1. 打开 [CCVibe Releases](https://github.com/cddchen/CCVibe/releases/latest)。
2. 下载名称中包含 `macOS` 的 ZIP 文件。
3. 解压后将 `CCAgent.app` 拖入“应用程序”目录。
4. 打开 App，填写服务地址、端口 `4733` 和 Token。

当前预览版 Mac App 尚未完成 Apple 公证。如果 macOS 阻止首次启动，请在 Finder 中右键点击 App，选择“打开”，然后再次确认。

## 全局安装

如果不希望每次都通过 `npx` 下载，可以全局安装：

```bash
npm install -g @cddchen/cclink@latest
```

之后使用下面的命令启动：

```bash
cclink --listen 0.0.0.0:4733 --token "设置一个登录密码"
```

## 升级

通过 `npx` 启动时，使用 `@latest` 即可获取最新版本：

```bash
npx @cddchen/cclink@latest --listen 0.0.0.0:4733 --token "你的密码"
```

全局安装用户可以执行：

```bash
npm install -g @cddchen/cclink@latest
```

Android 和 macOS 客户端可以从 [Releases](https://github.com/cddchen/CCVibe/releases) 下载最新版本覆盖安装。

## 使用提示

- 不要将 Token 分享给不信任的人。
- 局域网设备无法连接时，请确认设备处于同一网络，并检查电脑防火墙是否允许端口 `4733`。
- 关闭 CCLink 服务后，Web、Android 和 macOS 客户端将无法继续连接 Claude。
