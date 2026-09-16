#!/usr/bin/env node
// goagent-host —— 跑在你自己电脑上的那个 agent。
//
// 它**主动连出去**到中继（出站连接不受 NAT 阻挡），手机从外面连中继，
// 两边挂到同一个配对码下面，指令和结果就从中间流过。
// 买公网服务器的全部意义就在于：电脑不需要有自己的公网地址。
import { randomUUID } from 'node:crypto'
import { styleText } from 'node:util'
import { createAgent } from './agent.mjs'
import { configPath, load, newCode, save } from './config.mjs'

const RELAY = process.env.GOAGENT_RELAY ?? 'ws://localhost:8080'

const dim = (s) => styleText('dim', s)
const red = (s) => styleText('red', s)
const cyan = (s) => styleText('cyan', s)
const green = (s) => styleText('green', s)
const yellow = (s) => styleText('yellow', s)

const log = (...a) => console.error(dim('[host]'), ...a)

// ---------------------------------------------------------------- 状态
let cfg = await load()
// 授权目录跟身份存在同一份配置里 —— 都是「这台机器的事」，
// 拆成两个文件只会让备份和迁移漏掉一个。
if (!Array.isArray(cfg.grants)) cfg = await save({ ...cfg, grants: [] })

let ws = null
let retry = 0
let reconnectTimer = null
let stopped = false

// 有没有人在看手机。中继会告诉我们（relay:watchers）—— 见 askPhone。
let phoneOnline = false

// 正在打一行流式文本。deltas 是一个字一个字来的，每个都换行会散成一片。
let typing = false

// 连上多久才算「真的稳」。稳了才把重连退避清零 —— 见 onopen。
const STABLE_AFTER = 10_000
let stableTimer = null

// ---------------------------------------------------------------- 授权
// 同一个对象递给两个地方用：工具层拿 list() 判越界，add() 记下用户新批的目录，
// ask() 去手机上要一个回答。授权状态只有这一份，没有第二个真相来源。
const grants = {
  list: () => cfg.grants,
  add: async (p) => {
    cfg = await save({ ...cfg, grants: [...cfg.grants, p] })
    log(`${green('已授权')} ${p}`)
  },
  ask: askPhone,
}

const agent = createAgent({ onEvent: onAgentEvent, onLog: log, grants })

// ---------------------------------------------------------------- 收发
function send(ev) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev))
}

// ---------------------------------------------------------------- 问手机
// agent 想碰一个没授权的目录，就得停下来问人。这个 Map 是「正在等的那些问题」：
// 键是 requestId，值是把它解决掉的那个函数。
const pendingAsks = new Map()

// 没人回答就一直挂着，把 prompt 队列堵死。给个上限，到点算拒绝。
const ASK_TIMEOUT = 2 * 60_000

function askPhone(path, reason, signal) {
  // 没人在看手机，等就是白等。直接拒掉，让 agent 去跟用户说清楚。
  if (!phoneOnline) {
    log(dim('没人在看手机，这次申请直接算拒绝'))
    return Promise.resolve(false)
  }
  // 已经按过停止了。等着的话这个 tool 永远不返回，队列就卡在这儿。
  if (signal?.aborted) return Promise.resolve(false)

  const requestId = randomUUID()
  return new Promise((resolve) => {
    // 三条路都要走这里：用户点了、超时了、用户按了停止。
    // 清 Map 和移除监听放在一处，漏一个就是内存泄漏或者误触发。
    const settle = (ok) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pendingAsks.delete(requestId)
      resolve(ok)
    }
    const onAbort = () => settle(false)
    const timer = setTimeout(() => {
      process.stderr.write(dim('  （等太久了，算拒绝）\n'))
      settle(false)
    }, ASK_TIMEOUT)

    signal?.addEventListener('abort', onAbort, { once: true })
    pendingAsks.set(requestId, settle)

    process.stderr.write(`  ${yellow('⏸')} 申请访问 ${path}\n`)
    process.stderr.write(`${dim(`    理由：${reason}`)}\n`)
    process.stderr.write(`${dim('    等你在手机上点确认…')}\n`)
    send({ type: 'ask_access', path, reason, requestId })
  })
}

// ---------------------------------------------------------------- 屏幕
// 同一个事件流，第二个消费者 —— 手机那边看到的，电脑这边也看得见。
//
// 这是这个形态的重点：agent 就跑在你自己电脑上，你当然应该能看见它在干什么、
// 调了什么工具、参数是什么。手机上只有一块小屏幕，排查问题时不够看。
//
// ⚠️ 这一段**不参与任何逻辑**，纯输出。终端卡住、被重定向到文件、根本没人看，
// agent 都照跑不误 —— 所以它绝不能放在 send() 前面，也绝不能 await。
function endTyping() {
  if (typing) {
    process.stderr.write('\n')
    typing = false
  }
}

function onAgentEvent(ev) {
  switch (ev.type) {
    case 'text':
      // 流式吐字续在同一行上，做成终端里的打字机
      if (!typing) {
        process.stderr.write(`${dim('  电脑 ›')} `)
        typing = true
      }
      process.stderr.write(ev.delta)
      break

    case 'tool_start':
      endTyping()
      process.stderr.write(`${yellow('  ⚙')} ${ev.name} ${dim(JSON.stringify(ev.args ?? {}))}\n`)
      break

    case 'tool_end':
      endTyping()
      process.stderr.write(`  ${ev.ok ? green('✓') : red('✗')} ${ev.name}\n`)
      break

    case 'done':
      endTyping()
      break

    case 'error':
      endTyping()
      process.stderr.write(`${red(`  ✗ ${ev.message}`)}\n`)
      break
  }

  send(ev) // 电脑自己看完了，再原样发给手机
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
    banner()
    // ⚠️ 不能在这里直接 retry = 0。「连上就死」的循环（两个进程抢同一个
    // 配对码）会因此永远停在 1 秒 —— 每次 onopen 都把退避清零，退避形同虚设。
    // 连稳一段时间之后才算数。
    clearTimeout(stableTimer)
    stableTimer = setTimeout(() => { retry = 0 }, STABLE_AFTER)
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
  clearTimeout(stableTimer) // 连接断了，稳定性从头算
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
      endTyping()
      process.stderr.write(`${cyan('  手机 ›')} ${msg.text}\n`)
      agent.prompt(msg.text)
      break

    case 'cancel':
      agent.cancel()
      break

    case 'relay:presence':
      // 中继告诉我们电脑自己在不在线。host 这边当然知道自己在线，不用管。
      break

    case 'relay:watchers':
      // 反过来：有几台手机在看。askPhone 靠它决定要不要等。
      phoneOnline = msg.count > 0
      log(dim(phoneOnline ? `手机已接入（${msg.count} 台）` : '手机都走了'))
      // 人走了，那些正等着点确认的申请就没人回答了。
      // 不处理的话它们会一直挂到 2 分钟超时，白白堵着 prompt 队列 ——
      // 而这段时间里 agent 什么都不干。
      // 注意要遍历副本：settle 会从 Map 里删自己。
      if (!phoneOnline && pendingAsks.size) {
        log(dim(`有 ${pendingAsks.size} 个申请没人回答了，一律算拒绝`))
        for (const settle of [...pendingAsks.values()]) settle(false)
      }
      break

    case 'grant': {
      const settle = pendingAsks.get(msg.requestId)
      // 对不上的答复是可能的：上一次连接留下的问题，用户这会儿才点。
      if (settle) settle(msg.ok === true)
      break
    }

    case 'relay:error':
      // 被顶掉：另一个进程拿着同一个配对码连上来了。
      // 这时候重连没有任何意义 —— 只会变成两边每秒互相顶一次，谁也连不上，
      // 而且表面上一切正常（日志里只有一行行「电脑已接入」）。
      // 直接退出，把原因留在屏幕上。
      if (msg.code === 'evicted') {
        log(red(msg.message))
        log(dim('同一个配对码只能有一个 host。停掉另一个进程再启动这个。'))
        log(dim(`两个进程读的是同一份 ${configPath}。`))
        stopped = true
        ws?.close()
        process.exit(1)
      }

      // 剩下的真实情况是配对码被别人占了。换一个码重连。
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
  // 用户得知道 agent 现在能碰什么。零权限起步是这套东西的卖点，
  // 但那也要说出口，否则「它怎么不干活」会变成一个 bug 报告。
  if (cfg.grants.length) {
    console.error(dim(`  已授权的目录：${cfg.grants.join('、')}`))
  } else {
    console.error(dim('  它能碰的目录：**一个都没有**。要访问时会先在手机上问你。'))
  }
  console.error('')
}

process.on('SIGINT', () => {
  stopped = true
  ws?.close()
  process.exit(0)
})

connect()
