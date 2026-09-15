# Goagent

一个 Agent 中枢：Go daemon 跑在本地，Web / CLI / App 三种客户端连同一个它。

## 结构

```
浏览器 / CLI / App ──WebSocket──▶ Go daemon ──stdio JSONL──▶ node ──▶ pi SDK ──▶ LLM
                                        │
                                        └── 广播给所有客户端
```

```
Goagent/
├── server/            Go daemon —— HTTP 静态服务 + WebSocket 广播 + 子进程编排
│   ├── main.go        启动、路由、SPA 回退
│   ├── hub.go         连接管理 + 广播
│   ├── client.go      单连接的收发循环 + 心跳
│   └── agent.go       起 node 子进程，stdio 双向 JSONL
├── packages/
│   ├── agent/         pi SDK 宿主（Node）
│   │   └── src/
│   │       ├── host.mjs   stdio 协议 + agent 装配
│   │       └── tools.mjs  工具定义 + 路径越界检查
│   ├── web/           Vue3 + Vite，之后用 Capacitor 打包成 App
│   └── cli/           TS 终端客户端，tsc 编译，bin 分发
└── scripts/           冒烟测试
```

**为什么 agent 跑在 node 里而不是 Go 里？** pi SDK 只有 TS 版。
Go 管的是连接、广播、进程生命周期、取消传播、审批路由、审计 —— 这些是它的强项；
agent 循环本身是 pi 写好的，重写它是浪费。两边各干各擅长的。

`packages/shared/`（协议类型 + WS 客户端）和 `packages/cli/` 到 Step 5 再建。

## 跑起来

先准备密钥：

```bash
cp .env.example .env     # 然后填 DEEPSEEK_API_KEY
```

三个终端：

```bash
pnpm server          # 终端 1：Go daemon，:8080（同时拉起 agent 子进程）
pnpm web dev         # 终端 2：Vite 开发服务器，:5173
pnpm cli             # 终端 3：CLI 客户端
```

打开 http://localhost:5173，**再开一个窗口打开同一个地址**，然后终端里也连上。
在任意一端提问，**三边同时看到同一次对话** —— 包括工具调用和流式输出。
别处发来的消息在 CLI 里会标成 `[其他客户端]`。

手机想看：连同一个 WiFi，用 `pnpm web dev` 输出里那个 Network 地址。

CLI 也能一次问完就走，或者装成全局命令：

```bash
node packages/cli/dist/index.js "帮我看看这个目录里有啥"
cd packages/cli && npm link      # 之后任意目录直接敲 goagent
```

## 生产构建

```bash
pnpm build           # 前端产物进 packages/web/dist
pnpm server          # daemon 直接把它当静态目录伺服，:8080 一个端口搞定
```

## 当前进度

- [x] W1 骨架：WebSocket 广播，多窗口实时同步
- [x] Step 1：Go daemon ⇄ node 子进程（stdio JSONL），pi SDK 接 DeepSeek，
      流式输出 + 工具调用 ← **现在在这**
- [x] Step 5：CLI 客户端 —— 提前做了，因为它不依赖 Step 2/3/4，
      加上之后「三端同时看到」这个卖点才真正成立
- [x] Step 2：会话管理 + context 取消（中途打断正在跑的 agent）← **现在在这**
- [ ] Step 3：审批状态机（挂在 pi 的 `beforeToolCall` 钩子上）
- [ ] Step 4：审计日志（挂在 `afterToolCall` 钩子上）
- [ ] Step 6：压测 + Capacitor 打包 + 录 demo

## 会话

一个会话 = 一个独立的 agent 子进程 + 一条可取消的生命周期。

连接时用 `?session=<id>` 指定会话：带上已存在的 id 就加入它（多个窗口/CLI
共享同一段对话），不带就开一个新的。连上后第一帧是
`{"type":"session","id":"..."}`，客户端要把它放进 URL 才能分享出去。

没人连的会话会在闲置 15 分钟后被回收（连同它的 node 子进程）。
`-session-idle 0` 可以关掉回收，`-session-idle 6s` 方便观察。

## 冒烟测试

```bash
pnpm smoke:agent      # 单客户端全链路 prompt → 流式文本 → done（真调模型，花钱）
pnpm smoke:sessions   # 会话隔离 / 共享 / 取消（只有最后一组调模型）
```
