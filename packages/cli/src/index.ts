#!/usr/bin/env node
import { createInterface, type Interface } from 'node:readline'
import { styleText } from 'node:util'

// ---------------------------------------------------------------- 协议
// 跟 packages/web/src/App.vue 里那份是同一套消息。
// 现在只有两个消费者，先各留一份；等 Step 3 加了审批消息，再抽到 packages/shared。
type AgentEvent =
  | { type: 'prompt'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'ready'; model: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------- 颜色
// util.styleText 是 Node 内置的，会自动尊重 NO_COLOR 和那些不支持颜色的终端，
// 所以不需要 chalk 之类的依赖。
const dim = (s: string) => styleText('dim', s)
const red = (s: string) => styleText('red', s)
const cyan = (s: string) => styleText('cyan', s)

const HELP = `
goagent —— 连到本地 agent daemon 的终端客户端

用法:
  goagent                        交互式对话
  goagent "你的问题"              问一句就退出
  goagent -u ws://主机:端口      指定 daemon 地址（默认 ws://localhost:8080/ws）

交互模式里:
  /exit                          退出
`.trim()

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
let url = process.env.GOAGENT_URL ?? 'ws://localhost:8080/ws'
const words: string[] = []

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--url' || a === '-u') url = argv[++i] ?? url
  else if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  } else words.push(a)
}

/** 有内容就是「问一句就退出」模式 */
const once = words.join(' ').trim()

// ---------------------------------------------------------------- 状态
let rl: Interface | null = null
let opened = false
let exiting = false

/** 当前是否停在一条没换行的流式输出上 —— 插入任何整行内容前要先补个换行 */
let wroteText = false

/** 自己刚发出去的那句。广播回来时靠它认出来，跳过不重复显示 */
let pendingEcho: string | null = null

function newlineIfNeeded() {
  if (wroteText) {
    process.stdout.write('\n')
    wroteText = false
  }
}

// ---------------------------------------------------------------- 渲染
function render(ev: AgentEvent) {
  switch (ev.type) {
    case 'text':
      process.stdout.write(ev.delta)
      wroteText = true
      break

    case 'tool_start':
      newlineIfNeeded()
      process.stdout.write(dim(`  ⚙ ${ev.name} ${JSON.stringify(ev.args)}\n`))
      break

    case 'tool_end':
      if (!ev.ok) process.stdout.write(red(`  ✗ ${ev.name} 失败\n`))
      break

    case 'ready':
      process.stderr.write(dim(`模型 ${ev.model}\n`))
      break

    case 'done':
      newlineIfNeeded()
      if (once) {
        ws.close()
        process.exit(0)
      }
      rl?.prompt()
      break

    case 'error':
      newlineIfNeeded()
      process.stdout.write(red(`错误: ${ev.message}\n`))
      if (once) process.exit(1)
      rl?.prompt()
      break
  }
}

// ---------------------------------------------------------------- 连接
process.stderr.write(dim(`连接 ${url}\n`))
const ws = new WebSocket(url)

ws.onopen = () => {
  opened = true

  if (once) {
    ask(once)
    return
  }

  // 交互模式
  rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.setPrompt(cyan('> '))
  rl.prompt()

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return rl?.prompt()
    if (text === '/exit' || text === '/quit') return quit()

    ask(text)
    // 这里故意不立刻再 prompt：等 agent 的 done 事件回来再给输入行，
    // 否则输入行会和流式输出糊在一起。中途想插话也还能打，daemon 会排队。
  })

  rl.on('close', quit)
}

ws.onmessage = (e) => {
  let ev: AgentEvent
  try {
    ev = JSON.parse(e.data)
  } catch {
    return
  }

  // 服务端会把 prompt 原样广播给所有人。自己发的那句终端里已经显示过，跳过；
  // 别人（网页/手机）发的要显示出来 —— 这就是「多端同步」在终端里的样子。
  if (ev.type === 'prompt') {
    if (ev.text === pendingEcho) {
      pendingEcho = null
      return
    }
    newlineIfNeeded()
    process.stdout.write(cyan(`\n[其他客户端] ${ev.text}\n`))
    return
  }

  render(ev)
}

// 连接失败时 Node 只给 onerror + onclose(1006)，拿不到具体原因，统一在 onclose 里报
ws.onclose = () => {
  if (exiting) return
  newlineIfNeeded()
  if (!opened) {
    process.stderr.write(red(`连不上 ${url}\n`))
    process.stderr.write(dim('daemon 起来了吗？另开一个终端跑 pnpm server\n'))
    process.exit(1)
  }
  process.stderr.write(dim('\n与 daemon 的连接已断开\n'))
  process.exit(0)
}

// ---------------------------------------------------------------- 动作
function ask(text: string) {
  pendingEcho = text
  ws.send(JSON.stringify({ type: 'prompt', text }))
}

function quit() {
  exiting = true
  rl?.close()
  ws.close()
  process.exit(0)
}
