# Goagent

一个 Agent 中枢：Go daemon 跑在本地，Web / CLI / App 三种客户端连同一个它。

## 结构

```
Goagent/
├── server/          Go daemon —— HTTP 静态服务 + WebSocket 广播
└── packages/
    └── web/         Vue3 + Vite，之后用 Capacitor 打包成 App
```

`packages/shared/`（协议类型 + WS 客户端）和 `packages/cli/` 到 W2 再建。

## 跑起来

两个终端：

```bash
pnpm server          # 终端 1：Go daemon，:8080
pnpm web dev         # 终端 2：Vite 开发服务器，:5173
```

打开 http://localhost:5173，**再开一个窗口打开同一个地址**，任意一边发消息，
两边会同时出现 —— 这就是 W1 的验收标准。

手机想看：连同一个 WiFi，用 `pnpm web dev` 输出里那个 Network 地址。

## 生产构建

```bash
pnpm build           # 前端产物进 packages/web/dist
pnpm server          # daemon 直接把它当静态目录伺服，:8080 一个端口搞定
```

## 当前进度

- [x] W1 骨架：WebSocket 广播，多窗口实时同步
- [ ] W1 验收：两个浏览器窗口同步 ✅ ← 现在在这
- [ ] W2 会话管理 + 子进程编排
- [ ] W3 多客户端广播 + 审批状态机 + 审计日志
- [ ] W4 Go 面试题 + 压测 + Capacitor 打包 + 录 demo
