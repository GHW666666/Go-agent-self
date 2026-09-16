#!/usr/bin/env node
// 中继的开销测量：转发一条消息要多久、它自己吃多少内存和 CPU。
//
//   node scripts/bench.mjs
//   node scripts/bench.mjs --n 5000 --pid 29140
//
// 不接模型、不需要 key、不烧 token —— 和 smoke-m1.mjs 一样随时能重跑。
//
// ★ 这里量的不是压测。全程「发一条、等一条」，一个并发都没有，也故意不加。
//   压测回答「能扛多少」，这个回答「干一次活要多少」——个人项目要的是后者。
//
// ponytail: 只有单条往返。真要吞吐量就得开并发造负载，那是压测，另说。

import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const N = Number(opt('--n', 2000))      // 每种情况测多少条
const WARM = 200                         // 预热，把 JIT 和首包抖动挡掉
const RELAY = opt('--relay', 'ws://localhost:8080')

// ---------------------------------------------------------------- 工具

const BYTES = new TextEncoder()

function relayPid() {
  const explicit = opt('--pid', null)
  if (explicit) return Number(explicit)

  // 从监听表里找 :8080 的主人
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    if (line.includes(':8080') && line.includes('LISTENING')) {
      const pid = Number(line.trim().split(/\s+/).pop())
      if (pid) return pid
    }
  }
  throw new Error(`没找到监听 ${RELAY} 的进程，中继起来了吗？`)
}

// 进程的累计 CPU 秒数 + 常驻内存。两个都是瞬时读数，差分会用。
// ponytail: 走 PowerShell。要上 VPS 的话这里换成读 /proc/<pid>/statm 就完了。
function sample(pid) {
  const out = execFileSync('powershell', [
    '-NoProfile', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.CPU)"`,
  ], { encoding: 'utf8' })

  const [rss, cpu] = out.trim().split(/\s+/).map(Number)
  if (!Number.isFinite(rss)) throw new Error(`读不到进程 ${pid} 的信息：${out.trim()}`)
  return { rss, cpu: Number.isFinite(cpu) ? cpu : 0 }
}

// ---------------------------------------------------------------- ws

// 一个只会收消息的对端。中继自己发的 relay:* 控制消息（presence 等）
// 自动跳过 —— 这里量的是业务消息的转发开销。
class Peer {
  constructor(url) {
    this.queue = []
    this.waiter = null
    this.ws = new WebSocket(url)

    this.ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"relay:')) return
      if (this.waiter) { const w = this.waiter; this.waiter = null; w() }
      else this.queue.push(1)
    })
  }

  open() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', () => rej(new Error('连不上中继')), { once: true })
    })
  }

  next() {
    if (this.queue.length) { this.queue.shift(); return Promise.resolve() }
    return new Promise((r) => { this.waiter = r })
  }

  send(s) { this.ws.send(s) }
  close() { this.ws.close() }
}

// 发一条、等一条，记下这条走完全程用了多少微秒。
async function measure(from, to, payload, n, warm) {
  for (let i = 0; i < warm; i++) { from.send(payload); await to.next() }

  const us = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint()
    from.send(payload)
    await to.next()
    us[i] = Number(process.hrtime.bigint() - t0) / 1000
  }

  us.sort()
  return { med: us[n >> 1], p99: us[Math.min(n - 1, Math.floor(n * 0.99))], max: us[n - 1] }
}

const fmtUs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(0)} µs`)
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`

// ---------------------------------------------------------------- 跑

const pid = relayPid()
const code = 'BENCH9' // 字母表里没有 0 1 I L O，造数据也得守

const host = new Peer(`${RELAY}/ws?role=host&code=${code}&token=bench`)
const phone = new Peer(`${RELAY}/ws?role=phone&code=${code}`)

console.log(`中继 PID ${pid}   地址 ${RELAY}   每种情况 ${N} 条（预热 ${WARM}）\n`)

await host.open()
await phone.open()

const small = JSON.stringify({ type: 'text', delta: '中继转发这一条消息' })
const big = JSON.stringify({ type: 'text', delta: '中继转发这一条消息'.repeat(400) })

const cases = [
  ['手机 → 电脑', phone, host, small],  // 指令方向
  ['电脑 → 手机', host, phone, small],  // 流式吐字方向 —— 真正高频的那条
  ['电脑 → 手机', host, phone, big],    // 内容大一点
]

const before = sample(pid)
const t0 = Date.now()

console.log('转发延迟（单条，一次一条，无并发）')
const rows = []
for (const [label, from, to, payload] of cases) {
  const r = await measure(from, to, payload, N, WARM)
  rows.push({ label, bytes: BYTES.encode(payload).length, ...r })
  console.log(
    `  ${label}   ${String(BYTES.encode(payload).length).padStart(6)} B   ` +
    `中位 ${fmtUs(r.med).padStart(9)}   p99 ${fmtUs(r.p99).padStart(9)}   最慢 ${fmtUs(r.max).padStart(9)}`,
  )
}

const wall = (Date.now() - t0) / 1000
const after = sample(pid)
const total = N * cases.length
const cpuPerMsg = ((after.cpu - before.cpu) / total) * 1e6

console.log(`\n资源（中继进程自己的，不含电脑端和手机端）`)
console.log(`  内存   ${mb(before.rss)} → ${mb(after.rss)}   （${total} 条消息，+${mb(after.rss - before.rss)}）`)
console.log(`  CPU    ${(after.cpu - before.cpu).toFixed(2)} s / ${wall.toFixed(1)} s 墙钟 = ${(((after.cpu - before.cpu) / wall) * 100).toFixed(1)}%`)
console.log(`  吞吐   顺序发的情况下 ${(total / wall).toFixed(0)} 条/秒`)

console.log(`\n⚠ 上面那个 CPU 百分比别拿去说事 —— 这是把中继压到饱和量出来的。`)
console.log(`  单条转发的 CPU 成本 ${cpuPerMsg.toFixed(1)} µs，乘上真实速率才是它平时的样子：\n`)

// 按真实速率再跑一遍。模型流式吐字撑死几十上百 token/秒，
// 这才是中继平时面对的东西。
const rate = Number(opt('--rate', 100))
const secs = Number(opt('--secs', 8))
console.log(`真实速率下的开销（按 ${rate} 条/秒 匀速跑 ${secs} 秒）`)

const b2 = sample(pid)
const w2 = Date.now()
let sent = 0
let nextAt = performance.now()
const deadline = nextAt + secs * 1000

while (performance.now() < deadline) {
  host.send(small)
  await phone.next()
  sent++
  nextAt += 1000 / rate
  const wait = nextAt - performance.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

const wall2 = (Date.now() - w2) / 1000
const a2 = sample(pid)
const cpuPct = ((a2.cpu - b2.cpu) / wall2) * 100

console.log(`  实际发出   ${sent} 条 / ${wall2.toFixed(1)} s = ${(sent / wall2).toFixed(0)} 条/秒`)
console.log(`  CPU        ${(a2.cpu - b2.cpu).toFixed(3)} s / ${wall2.toFixed(1)} s = ${cpuPct.toFixed(2)}%`)
console.log(`  内存       ${mb(b2.rss)} → ${mb(a2.rss)}`)

// 闲着的时候才看得出真实占用 —— Go 的堆是慢慢还给系统的
await new Promise((r) => setTimeout(r, 3000))
const idle = sample(pid)
console.log(`  静置 3 秒后 ${mb(idle.rss)}`)

console.log(`\n── 结论 ──`)
console.log(`中继转发一条消息中位 ${fmtUs(rows[1].med)}，CPU ${cpuPerMsg.toFixed(0)} µs。`)
console.log(`模型吐一个字要几十毫秒 —— 中继这一跳的占比是万分之几。`)
console.log(`也就是说：这个项目的用户体感速度跟中继用什么写的**没关系**。`)

host.close()
phone.close()
process.exit(0)
