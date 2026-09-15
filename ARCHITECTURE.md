# 架构

## 跑起来的时候，有哪几个进程

```
┌─────────────────────────────────────────────────────────────┐
│ 你的电脑                                                     │
│                                                             │
│   ┌─────────┐    ┌─────────┐    ┌──────────┐                │
│   │ 浏览器   │    │ 浏览器   │    │  终端     │  ← 客户端 N 个 │
│   │ 窗口 A   │    │ 窗口 B   │    │ goagent  │                │
│   └────┬────┘    └────┬────┘    └────┬─────┘                │
│        └──────────────┴──────────────┘                      │
│                       │ WebSocket                           │
│                       ▼                                     │
│        ┌───────────────────────────┐                        │
│        │  goagent.exe              │  ← 进程 1：中枢         │
│        │  server/*.go              │                        │
│        └─────────────┬─────────────┘                        │
│                      │ stdin / stdout，一行一条 JSON        │
│                      ▼                                      │
│        ┌───────────────────────────┐                        │
│        │  node src/host.mjs        │  ← 每个会话一个          │
│        │  packages/agent/          │    （闲置会被回收）      │
│        └─────────────┬─────────────┘                        │
└──────────────────────┼──────────────────────────────────────┘
                       │ HTTPS
                       ▼
              DeepSeek API（在云上）
```

会话和连接是**多对多**：一个会话可以被多个窗口同时看（共用 `?session=<id>`），
一个窗口也可以随时换会话。只有落在同一个会话里的连接才互相看得见。

**一个常驻 Go daemon + 每个会话一个 Node 子进程**：
Go 管连接、会话和广播，Node 跑 agent 内核。

## 目录 = 什么

| 目录 | 是什么 | 语言 | 跟谁说话 | 行数 |
|---|---|---|---|---|
| `server/` | 中枢 daemon | Go | 上游 WS 客户端，下游 node 子进程 | ~660 |
| `packages/agent/` | agent 内核，包着 pi SDK | Node (`.mjs`) | 上游 Go（stdio），下游 DeepSeek | ~170 |
| `packages/web/` | 网页（以后用 Capacitor 打包成 App） | TS + Vue | 只说 WebSocket | ~320 |
| `packages/cli/` | 终端客户端 | TS | 只说 WebSocket | ~210 |
| `scripts/` | 冒烟测试（假装自己是个客户端） | Node | 只说 WebSocket | ~180 |

**关键：web 和 cli 互相不认识，也都不认识 agent。它们只认识 Go daemon。**

## 一次提问的完整旅程

在浏览器里打「你好」回车，到屏幕上出现回复，中间发生了这些：

```
1. 浏览器          ws.send('{"type":"prompt","text":"你好"}')
                                                          │
2. server/client.go  readPump 收到，交给 sessions.Handle(session,msg)
                                                          ▼
3. server/session.go Handle() 做两件事：
                       a. hub.broadcast(session) ──▶ 同会话的客户端立刻看到「有人问了你好」
                       b. agent.Send() ──▶ 写进**这个会话专属**那个 node 的 stdin
                                                          │
4. agent/host.mjs    readline 逐行读，JSON.parse 后排队
                                                          ▼
5. pi SDK            agent.prompt("你好") ──HTTPS──▶ DeepSeek
                                                          │
6. pi SDK            每收到一小段文字，触发 message_update 事件
                                                          ▼
7. agent/host.mjs    emit({type:'text',delta:'你'})，写 stdout
                                                          │
8. server/agent.go   readLoop 逐行读 (bufio.Scanner)
                                                          ▼
9. server/hub.go     broadcast(session) → 丢进**该会话**每个连接的 send channel
                                                          │
10. server/client.go writePump 从 channel 取出，WriteMessage
                                                          ▼
11. web/ws.ts        ws.onmessage → 回调
                                                          │
12. web/App.vue      appendToAssistant('你') → last.text += delta
                                                          ▼
13. Vue              只有那一个文本节点被 patch，屏幕更新
```

这条链上**没有任何一处攒批**——所以它是流式的。

## 为什么这么分

**agent 内核为什么不是 Go 写的？**
pi SDK 只有 TS 版。重写一个 agent 循环是浪费——那是 pi 已经写好的东西。

**那 Go 管什么？**
连接管理、消息广播、进程生命周期、取消传播、审批路由、审计。
这些是基础设施，Go 的强项：并发模型简单（goroutine + channel），
子进程管理是标准库一等公民，编译成单个二进制好分发。

**为什么用 stdio 而不是端口？**
子进程一死管道就断，生命周期天然绑定，不需要额外的心跳去发现「agent 挂了」。
跟 LSP 是同一个路子。

**为什么 web/cli 只认识 Go，不认识 agent？**
因为它们本来就不该知道 agent 长什么样。Go 是唯一的协议边界，
换掉 agent 内核（比如换成别的 SDK）客户端一行都不用改。

## 协议

两条边界上是两套不同的协议。

**客户端 ↔ Go（WebSocket，JSON 文本帧）**

```
连接               ws://host/ws?session=<id>    不带 session 就开一个新的
服务端 → 客户端    {"type":"session","id":"a1b2c3"}   ← 连上后第一帧
客户端 → 服务端    {"type":"prompt","text":"你好"}
                  {"type":"cancel"}
服务端 → 客户端    {"type":"text","delta":"你"}
                  {"type":"tool_start","name":"list_dir","args":{"path":"."}}
                  {"type":"tool_end","name":"list_dir","ok":true}
                  {"type":"done"}
                  {"type":"error","message":"..."}
                  {"type":"ready","model":"deepseek-v4-flash"}
```

**会话**决定广播范围：一条消息只发给**同一会话**里的连接。
不传 `?session=` 就是各自一个新会话，两个窗口互相看不见——想同步得共用 id。

注意 `prompt` 是**双向**的：服务端会把收到的 prompt 原样广播回去，
这样每个窗口都看得到是谁发的。CLI 里靠 `pendingEcho` 认出自已发的那条跳过。

`cancel` 也走同一条路，但 Go 不解析它，直接透传给 node —— **必须透传**，
因为要打断的那个 prompt 正在 node 的队列头部跑，在 Go 这边拦下来没有任何意义。

**Go ↔ agent（stdio，一行一条 JSON）**

同一套消息形状。Go 把客户端的行原样转发给 node 的 stdin，
把 node stdout 的每一行原样广播出去——**Go 不解析协议内容**。
只有将来需要按类型路由（审批）时才会破例。
