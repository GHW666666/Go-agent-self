// Step 1 验收：发一句 prompt，agent 应该流式吐回文本并以 done 收尾。
//
// 用法：
//   终端 1  pnpm server
//   终端 2  pnpm smoke:agent
//
// ⚠️ 这个会真调模型，花你几分钱。

const URL = process.env.WS_URL ?? 'ws://127.0.0.1:8080/ws'
const TIMEOUT_MS = 60_000

const events = []

const ws = new WebSocket(URL)

const connected = new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error(`连不上 ${URL}，daemon 起来了吗？`))
})

ws.onmessage = (e) => {
  let ev
  try {
    ev = JSON.parse(e.data)
  } catch {
    return
  }
  events.push(ev)
  if (ev.type === 'text') process.stdout.write(ev.delta)
}

await connected

ws.send(JSON.stringify({ type: 'prompt', text: '用一句话说明你是干什么的' }))

const terminal = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ type: 'timeout' }), TIMEOUT_MS)
  const poll = setInterval(() => {
    const end = events.find((e) => e.type === 'done' || e.type === 'error')
    if (end) {
      clearTimeout(timer)
      clearInterval(poll)
      resolve(end)
    }
  }, 100)
})

const answer = events
  .filter((e) => e.type === 'text')
  .map((e) => e.delta)
  .join('')

console.log('\n--- 结果 ---')
console.log('事件类型:', [...new Set(events.map((e) => e.type))].join(', '))

if (terminal.type === 'error') {
  console.error('❌ agent 报错:', terminal.message)
  process.exit(1)
}
if (terminal.type === 'timeout') {
  console.error('❌ 超时，没等到 done')
  process.exit(1)
}
if (!answer.trim()) {
  console.error('❌ 一条文本都没收到')
  process.exit(1)
}

console.log('回复长度:', answer.length, '字')
console.log('✅ Step 1 通过：prompt → agent → 流式文本 → done')
process.exit(0)
