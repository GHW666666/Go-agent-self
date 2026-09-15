// W1 冒烟测试：开两个 WebSocket 客户端，A 发一条，两边都该收到。
//
// 用法：
//   终端 1  pnpm server
//   终端 2  pnpm smoke
//
// 这就是 W1 的验收标准。广播逻辑一旦坏掉，这里立刻红。

const URL = process.env.WS_URL ?? 'ws://127.0.0.1:8080/ws'

const received = []

function open(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    ws.onmessage = (e) => received.push(`${name}:${e.data}`)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error(`连不上 ${URL}，daemon 起来了吗？`))
  })
}

const a = await open('A')
const b = await open('B')
// 等连接在 Hub 里登记完再发，否则 A 可能在 B 登记前就把消息广播掉了
await new Promise((r) => setTimeout(r, 300))

a.send('hello')
await new Promise((r) => setTimeout(r, 500))

const expected = ['A:hello', 'B:hello']
const sort = (xs) => JSON.stringify([...xs].sort())
const ok = sort(received) === sort(expected)

console.log('收到:', sort(received))
if (!ok) {
  console.error('期望:', sort(expected))
  console.error('❌ 广播没通')
  process.exit(1)
}

console.log('✅ W1 通过：两个客户端都收到了同一条消息')
process.exit(0)
