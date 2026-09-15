// Step 2 验收：会话隔离、会话共享、取消。
//
// 用法：
//   终端 1  pnpm server
//   终端 2  pnpm smoke:sessions
//
// 只有最后一组会真调模型（取消没法凭空测）。

const BASE = process.env.WS_URL ?? 'ws://127.0.0.1:8080/ws'

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(session) {
  const url = session ? `${BASE}?session=${session}` : BASE
  const ws = new WebSocket(url)
  const events = []

  const id = await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error(`连不上 ${url}，daemon 起来了吗？`))
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      events.push(ev)
      if (ev.type === 'session') resolve(ev.id) // 第一帧永远是会话 id
    }
  })

  return {
    id,
    events,
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    count: (type) => events.filter((e) => e.type === type).length,
  }
}

// ── 1. 会话隔离 ────────────────────────────────────────────────
// 用 ping 这种 agent 不认识的类型来测广播，不烧 token。
console.log('\n— 会话隔离 —')
const a = await connect()
const b = await connect()

check('不带 session 的两个连接拿到不同的 id', a.id !== b.id, `${a.id} vs ${b.id}`)

a.send({ type: 'ping', n: 1 })
await wait(400)

check('A 收到自己的回声', a.count('ping') === 1)
check('B 收不到 A 的消息', b.count('ping') === 0)

// ── 2. 会话共享 ────────────────────────────────────────────────
console.log('\n— 会话共享 —')
const c = await connect(a.id)

check('带上已有 id 能加入同一个会话', c.id === a.id)

c.send({ type: 'ping', n: 2 })
await wait(400)

check('同会话的 A 收到了 C 的消息', a.count('ping') === 2)
check('C 自己收到了回声', c.count('ping') === 1)
check('别的会话的 B 依然收不到', b.count('ping') === 0)

// ── 3. 取消 ────────────────────────────────────────────────────
console.log('\n— 取消（这一步会真调模型）—')
const started = Date.now()
a.send({ type: 'prompt', text: '写一篇 800 字的散文，慢慢写' })
await wait(1500)

const beforeCancel = a.count('text')
check('取消前已经在流式输出', beforeCancel > 0, `${beforeCancel} 个 delta`)

a.send({ type: 'cancel' })

const cancelled = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000)
  const p = setInterval(() => {
    if (a.count('done') > 0 || a.count('error') > 0) {
      clearTimeout(t)
      clearInterval(p)
      resolve(true)
    }
  }, 100)
})

const elapsed = Date.now() - started
check('取消后 agent 及时收尾', cancelled, `用时 ${(elapsed / 1000).toFixed(1)}s`)
check('确实被打断了（没写满 800 字）', a.count('text') < 300, `${a.count('text')} 个 delta`)

// ── 收尾 ───────────────────────────────────────────────────────
for (const x of [a, b, c]) x.close()

console.log()
if (failures.length) {
  console.error(`❌ 失败 ${failures.length} 项：${failures.join('、')}`)
  process.exit(1)
}
console.log('✅ Step 2 通过：会话隔离 / 共享 / 取消 全部正常')
process.exit(0)
