# Web 登录页 + 启动自动连接门禁

## Context

当前 web 启动时 `DaemonProvider` 总是无条件用 localStorage 里的 token/ws 自动连接，WS/token 输入框内嵌在首页 `HomePage` 头部；没有登录页，没有路由门禁。问题:首次访问没有 token 也会盲目连接;首页在未连接时仍渲染并显示一堆禁用 UI;ws 默认地址在 DEV 走 vite 代理 `/ws`、PROD 走 `location.host/ws`,不直观也不是直连 daemon 的 4733 端口。

目标(用户已确认):
1. **启动门禁** —— 进入会话列表页前先判断本地是否有 token:有 token 就尝试连接,成功进会话列表,失败显示登录页;无 token(第一次)直接显示登录页。
2. **WS 默认地址** = 与 web 同主机但端口换成 4733(`ws://<当前主机>:4733`),登录页可自定义。
3. **登录页** 参考 cliproxyapi 的左右分栏风格(左侧黑色品牌大字,右侧表单卡片),用本项目的 Tailwind 实现。
4. **断开/切换连接** —— 登录成功后首页头部提供「切换连接」按钮:断开并回到登录页(地址/token 预填当前值)。

纯前端改动,daemon 无需改(已支持 `?token=` 查询参数 + `auth` RPC)。

## 关键现状(已确认)

- `web/src/context/DaemonContext.tsx`:`useEffect([token, wsUrl, tick])` 每次都 `new DaemonClient(token)` + `connect()`,成功 `setConnected(true)`、失败 `setError`。暴露 `client/connected/error/token/setToken/wsUrl/setWsUrl/reconnect`。**唯一消费 setToken/setWsUrl/reconnect 的是 `HomePage`**;`ChatPage`/`ChatNotifyContext` 只用 `client`/`connected`。
- `web/src/lib/daemonClient.ts` `connect()`(54-92):URL 解析 = localStorage `cc_daemon_ws_url` override → 否则 DEV `/ws` → 否则 `ws(s)://location.host/ws`;`onopen` 时若有 token 调 `auth` RPC,失败 reject。token/ws 的 localStorage key:`cc_daemon_token`、`cc_daemon_ws_url`。
- `web/src/App.tsx`:`ThemeProvider>DaemonProvider>ChatNotifyProvider>Routes`,路由 `/`→HomePage、`/chat/:workspacePath`、`/chat/:workspacePath/:sessionId`。无登录路由、无门禁。
- `web/src/pages/HomePage.tsx`:头部(60-94)内嵌 WS/token 输入框 + 刷新按钮,绑定 `wsUrl/token/setWsUrl/setToken`;`load()`(33-43)在 `!client||!connected` 时早退。
- web 测试:vitest + `renderToStaticMarkup`(无 testing-library),只对纯函数库写 `*.test.ts`(如 `sessionListCache.test.ts`、`workspaceTrust.test.ts`)。`vite.config.ts` dev 端口 5174、代理 `/ws`→`ws://127.0.0.1:4733`。

## 实施方案(纯前端)

### 1. 新增纯函数库 `web/src/lib/wsUrl.ts`(便于单测)

```ts
export function defaultWsBase(loc: { protocol: string; hostname: string } = location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.hostname}:4733`;
}
// 规范化:去尾斜杠、补 /ws、拼 token 查询
export function buildWsUrl(base: string, token: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (!b.includes("/ws")) b = `${b}/ws`;
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${b}${q}`;
}
```

### 2. `web/src/lib/daemonClient.ts` —— 用默认 4733 直连替换 DEV/host 分支

- `connect()` 内的 URL 解析改为:`const base = (localStorage.getItem("cc_daemon_ws_url")?.trim()) || defaultWsBase(); this.ws = new WebSocket(buildWsUrl(base, this.token));`(删除 `import.meta.env.DEV` 的 `/ws` 分支与 `location.host` 分支)。import `defaultWsBase, buildWsUrl`。

### 3. `web/src/context/DaemonContext.tsx` —— 状态机 + 按需自动连接

- 新状态:`type Status = "connecting" | "connected" | "disconnected"`。
- 初值:`localStorage cc_daemon_token` 非空 → `status="connecting"`、`attempt=1`;否则 → `status="disconnected"`、`attempt=0`。(用户确认:**有 token 才尝试连接**)
- 连接 effect 依赖 `[attempt]`:`attempt===0` 时直接 return(第一次/已登出,不连接);否则 `new DaemonClient(token)`→`setClient`→`setStatus("connecting")`→`connect()` 成功 `setStatus("connected")`、失败 `setError(msg); setStatus("disconnected")`;cleanup `c.close()`。
- 新 API(替换旧的 setToken/setWsUrl/reconnect):
  - `connect(base: string, token: string)`:写 localStorage `cc_daemon_ws_url`/`cc_daemon_token` + 同步 state,`setAttempt(a=>a+1)`(触发重连;effect 里 `new DaemonClient(token)` 读到的是已更新的 token state)。
  - `disconnect()`:`client?.close(); setStatus("disconnected")`(不动 attempt/不清 token,以便登录页预填;gate 见非 connected/非 connecting → 显示登录页)。
- 暴露:`client, status, connected: status==="connected", error, token, wsUrl, connect, disconnect`。保留 `connected` 派生字段以兼容 `ChatPage`/`HomePage`。

### 4. 新增登录页 `web/src/pages/LoginPage.tsx`(Tailwind 复刻 cliproxyapi 分栏)

- 布局:`flex min-h-full`;左 `brandPanel`(`hidden md:flex flex-1 bg-black`,竖排大字 `CC / AGENT / DAEMON`,右对齐);右 `formPanel`(居中,`max-w-[420px]`)含卡片(白底/暗色、圆角、阴影)。
- 表单字段:
  - WS 地址 `<input>`,本地 state 初值 = `wsUrl || defaultWsBase()`(支持自定义)。
  - Token `<input type=password>` + 显示/隐藏切换,初值 = `token`。
  - 「连接」按钮:点击 `connect(base, token)`;`status==="connecting"` 时显示 loading、禁用。Enter 提交。
- 错误:`status==="disconnected" && error` 时显示红色 errorBox。
- 右上角放 `ThemeToggle`。

### 5. 门禁组件(在 `App.tsx` 内包住 Routes)

- 新增内联 `Gate`(或单独小组件):读 `useDaemon().status`:
  - `"connecting"` → 全屏 splash(品牌 + spinner,避免闪现登录页)。
  - `"connected"` → 渲染 `children`(Routes)。
  - 否则(`"disconnected"`) → `<LoginPage />`。
- `App.tsx`:`<ChatNotifyProvider><Gate><Routes/></Gate></ChatNotifyProvider>`(ChatNotify 用 client 即可,client 在 connecting/connected 时已存在)。

### 6. `web/src/pages/HomePage.tsx` —— 移除内嵌输入框 + 加「切换连接」按钮

- 删除头部 WS/token 两个 input(69-90),改用 `const { client, connected, error, disconnect } = useDaemon()`(不再取 token/wsUrl/setToken/setWsUrl)。
- 头部右侧放:`刷新` 按钮(保留,`onClick=load(true)`)、`切换连接` 按钮(`onClick=disconnect`)、`ThemeToggle`。
- 头部副标题保留连接状态文案;因有 Gate,HomePage 只会在 connected 时渲染,可简化「未连接」分支文案(120 行附近)。

## 关键文件

- `web/src/lib/wsUrl.ts`(新增,纯函数)
- `web/src/lib/daemonClient.ts`(默认 4733 直连)
- `web/src/context/DaemonContext.tsx`(状态机 + 按需连接 + connect/disconnect)
- `web/src/pages/LoginPage.tsx`(新增登录页)
- `web/src/App.tsx`(Gate 门禁)
- `web/src/pages/HomePage.tsx`(移除输入框 + 切换连接按钮)

## 测试

- `web/src/lib/wsUrl.test.ts`(新增):
  - `defaultWsBase`:http→`ws://host:4733`、https→`wss://host:4733`。
  - `buildWsUrl`:补 `/ws`、已含 `/ws` 不重复、去尾斜杠、有/无 token 的查询拼接、token URL 编码。
- 确认现有 web 测试仍绿(`sessionListCache.test.ts`/`workspaceTrust.test.ts`/`permissionResponses.test.ts` 等不受影响)。
- 登录页/Gate 因依赖 React context+state,沿用本仓「只测纯函数」的约定,不写组件测试。

## 验证

- `npm run test --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon/web`(含新 `wsUrl.test.ts`)
- `npm run build --prefix /Users/cdd/Documents/cc/repos/cc-agent-daemon/web`
- 手测:
  - 清空 localStorage 首次访问 → 直接显示登录页,WS 预填 `ws://<主机>:4733`。
  - 填正确 token 连接 → splash → 进会话列表。
  - 填错 token → 回登录页并显示错误。
  - 有 token 时刷新页面 → 自动连接成功直接进会话列表(无登录页闪现)。
  - 首页点「切换连接」→ 回登录页(预填当前 WS/token)→ 可改地址/ token 重连。

## 不在本次范围

- daemon 后端不改(已支持 token 鉴权)。
- 不引入 SCSS/新依赖(用 Tailwind 复刻 cliproxyapi 风格)。
- 不处理 https 页面连 ws:// 的混合内容、insecureNoAuth(无 token)daemon 等边缘场景。
