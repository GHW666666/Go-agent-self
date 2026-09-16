#!/usr/bin/env node
// goagent-host —— 跑在你自己电脑上的那个 agent。
//
// 它**主动连出去**到中继（出站连接不受 NAT 阻挡），手机从外面连中继，
// 两边挂到同一个配对码下面，指令和结果就从中间流过。
// 买公网服务器的全部意义就在于：电脑不需要有自己的公网地址。
import { styleText } from 'node:util'
import { createAgent } from './agent.mjs'
import { configPath, load, newCode, save } from './config.mjs'

const RELAY = process.env.GOAGENT_RELAY ?? 'ws://localhost:8080'

const dim = (s) => styleText('dim', s)
const red = (s) => styleText('red', s)
const cyan = (s) => styleText('cyan', s)
const green = (s) => styleText('green', s)

const log = (...a) => console.error(dim('[host]'), ...a)

// ---------------------------------------------------------------- 状态
let cfg = await load()
let ws = null
let retry = 0
let reconnectTimer = null
let stopped = false

const agent = createAgent({ onEvent: send, onLog: log })

// ---------------------------------------------------------------- 收发
function send(ev) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev))
}

function hostURL() {
  const q = new URLSearchParams({ role: 'host', code: cfg.code, token: cfg.token })
  return `${RELAY}/ws?${q}`
}

// ---------------------------------------------------------------- 连接
function connect() {
  if (stopped) return
  log(`连接 ${RELAY} …`)

  ws = new WebSocket(hostURL())

  ws.onopen = () => {
    retry = 0
    banner()
  }

  ws.onmessage = (e) => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      // 中继只转发两端发来的 JSON。收到裸文本说明对面在乱发，丢掉。
      return
    }
    handle(msg)
  }

  // ⚠️ 连接失败时 Node 的 WebSocket 只发 error、**不发 close**（undici 的行为）。
  // 只在 onclose 里重连的话，中继没起来时这个进程会一声不响地什么都不做，
  // 表现得像「启动成功了但没反应」，非常难查。
  ws.onerror = () => {
    log(red('连接出错'))
    scheduleReconnect()
  }

  ws.onclose = () => {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return
  // 退避到最多 10 秒。中继重启、笔记本合盖、换网络都靠它兜住。
  const wait = Math.min(1000 * 2 ** retry++, 10000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, wait)
}

// ---------------------------------------------------------------- 收指令
async function handle(msg) {
  switch (msg.type) {
    case 'prompt':
      log(`手机: ${msg.text}`)
      agent.prompt(msg.text)
      break

    case 'cancel':
      agent.cancel()
      break

    case 'relay:presence':
      // 中继发给我们说「手机来了/走了」。host 这边不关心。
      break

    case 'relay:error':
      // 唯一会走到这儿的真实情况是配对码撞车。换个码重连。
      log(red(msg.message))
      cfg = await save({ ...cfg, code: newCode() })
      log(`已换成新的配对码 ${cyan(cfg.code)}，手机上要重新输一次`)
      reconnectTimer = null
      ws.close()
      break

    default:
      log('未知消息:', msg.type)
  }
}

// ---------------------------------------------------------------- 界面
function banner() {
  console.error('')
  console.error(`  ${green('● 已连上中继')}  ${dim(RELAY)}`)
  console.error('')
  console.error(`  配对码   ${cyan(cfg.code)}`)
  console.error(dim('  手机打开中继地址，输入上面这串。配一次就记住了。'))
  console.error(dim(`  码存在 ${configPath}，重启不变。`))
  console.error('')
}

process.on('SIGINT', () => {
  stopped = true
  ws?.close()
  process.exit(0)
})

connect()
