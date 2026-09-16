# Goagent

**在手机上指挥你电脑里的 agent 干活，结果直接发到手机上。**

人在外面，想起来电脑上有个文件要用、有件事没做，现在只有三条路：远程桌面（太重）、
网盘（不会帮你整理）、或者算了。这是第四条。

手机只是屏幕和输入，真正干活的 agent 跑在你自己电脑上，看得见你的文件。

## 跑起来

三个进程，前两个在电脑上，第三个你手机打开。

```bash
pnpm install

pnpm relay    # 终端 1：中继。手机和电脑靠它牵线
pnpm host     # 终端 2：你的电脑。启动后会打印一串 6 位配对码
pnpm web      # 终端 3：手机端页面
```

手机连同一个 WiFi，打开终端 3 里那个 **Network** 地址（`http://192.168.x.x:5173/`），
把配对码输进去。配一次就记住了，以后打开直接就是对话界面。

> 电脑端**主动连出去**，所以它不需要有公网地址 —— 这就是中继存在的全部理由。
> 先本地跑通，之后把 `relay/` 丢到一台 VPS 上，手机在 4G 下也能用。

## 现在到哪了

- [x] **M1 链路跑通** —— 手机上打字 → 电脑上的 agent 回答 → 手机上看到流式文字
- [ ] **M2 文件 + 白名单** —— `send_file` / `request_access`，手机上授权、下载
- [ ] **M3 上 VPS + Capacitor 打包**

## 验证

```bash
pnpm smoke                      # 只测中继：配对、转发、断线重连、限流、回收
node scripts/smoke-m1.mjs --live  # 再把真的 host 拉起来，问模型一句
```

第一条**不需要 API key、不烧 token** —— 「链路通没通」和「模型答没答对」是两件事，
混在一起测的话，中继坏了和 key 过期了看起来一模一样。

## 目录

```
relay/    Go 中继。只做一件事：按配对码把消息从一端转给另一端
host/     电脑端。pi agent + 工具，一个 Node 进程
web/      手机端。Vue + Vite，以后用 Capacitor 打包成 App
scripts/  验收脚本
```

细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 配置

| 环境变量 | 谁用 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | host | 无。放 `.env`，已在 `.gitignore` 里 |
| `GOAGENT_RELAY` | host | `ws://localhost:8080` |
| `GOAGENT_MODEL` | host | `deepseek-v4-flash` |
| `GOAGENT_CONFIG` | host | `~/.goagent/config.json` |

配对码和 token 存在 `~/.goagent/config.json` —— 它是这台电脑的身份，不跟着仓库走，
重启也不变。
