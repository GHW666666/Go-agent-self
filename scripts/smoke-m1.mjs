// M1 验收：手机和电脑能不能通过中继说上话。
//
//   node scripts/smoke-m1.mjs           只测中继，不需要 API key，不烧 token
//   node scripts/smoke-m1.mjs --live    再把真正的 host 拉起来，问模型一句
//
// 默认这条路径刻意不碰模型：「链通没通」和「模型答没答对」是两件事，
// 混在一起测的话，中继坏了和 key 过期了看起来一模一样。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const LIVE = process.argv.includes('--live')

const PORT = Number(process.env.SMOKE_PORT ?? 8099)
const wsBase = (port) => `ws://127.0.0.1:${port}`

// 限流那一节会把 127.0.0.1 关进小黑屋，之后从同一个 IP 连什么都连不上。
// 所以 --live 那一节要换一个干净的中继，否则真 host 会被自己的测试挡在门外。
let BASE = wsBase(PORT)

// ⚠️ 配对码的字母表里**没有 0 1 I L O**（这串码要人从屏幕上念到手机里敲，
// 容易认错的字符全被排除了）。所以测试用的码也得守这个规矩，否则中继会在
// 校验那一步就以 bad_request 拒掉，根本走不到「码不存在」那条分支。
const CODE = 'TEST99'
const TOKEN = 'smoke-token-0123456789abcdef'
const BAD_CODES = [
  'ZZZZ22', 'ZZZZ23', 'ZZZZ24', 'ZZZZ25', 'ZZZZ26', 'ZZZZ27', 'ZZZZ28',
  'ZZZZ29', 'ZZZZ32', 'ZZZZ33', 'ZZZZ34', 'ZZZZ35', 'ZZZZ36', 'ZZZZ37',
]

// 回收器调快，好让「配对过期」这条在几秒内就能验完
const PAIR_IDLE = '2s'

// ---------------------------------------------------------------- 断言
let failed = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  ← ${detail}`}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------- 客户端
/** 连上去，收到的消息按顺序排队，next() 一条条取 */
async function connect(query) {
  const url = `${BASE}/ws?${query}`
  const ws = new WebSocket(url)
  const inbox = []
  const waiters = []
  let closed = false

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    // relay:watchers 只有电脑会收到（中继告诉它有几台手机在看），
    // 真实 host 在 switch 里忽略它。这里的假客户端也照做 ——
    // 留着的话它会插队，每条断言都得先跳过它一次。
    // 这条消息本身由 hub_test.go 的 TestWatchersToldToHost 管。
    if (msg.type === 'relay:watchers') return
    const w = waiters.shift()
    if (w) w(msg)
    else inbox.push(msg)
  })
  ws.addEventListener('close', () => (closed = true))

  const opened = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true), { once: true })
    // ⚠️ 连不上时 Node 的 WebSocket 只发 error 不发 close（undici 的行为）。
    // 等 close 的话这里会一直挂着。
    ws.addEventListener('error', () => resolve(false), { once: true })
  })

  return {
    ws,
    opened,
    closed: () => closed,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next: (timeout = 5000) => {
      if (inbox.length) return Promise.resolve(inbox.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`等消息超时（${url}）`)), timeout)
        waiters.push((m) => {
          clearTimeout(t)
          resolve(m)
        })
      })
    },
    close: () => ws.close(),
  }
}

const asHost = (code = CODE, token = TOKEN) =>
  connect(new URLSearchParams({ role: 'host', code, token }))
const asPhone = (code = CODE) => connect(new URLSearchParams({ role: 'phone', code }))

/** 连上去，期望被拒，返回那条 error 帧 */
async function expectReject(query) {
  const c = await connect(query)
  if (!c.opened) return { refused: true }
  const msg = await c.next().catch(() => null)
  c.close()
  return { refused: false, msg }
}

// ---------------------------------------------------------------- 起中继
const bin = join(tmpdir(), `goagent-relay-smoke${process.platform === 'win32' ? '.exe' : ''}`)
console.log('构建中继…')
execFileSync('go', ['build', '-o', bin, '.'], { cwd: join(root, 'relay'), stdio: 'inherit' })

const relays = []
function startRelay(port) {
  const proc = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-pair-idle', PAIR_IDLE], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => process.stderr.write(`  [relay] ${d}`))
  relays.push(proc)
  return proc
}

const dir = mkdtempSync(join(tmpdir(), 'goagent-smoke-'))
process.on('exit', () => {
  for (const r of relays) r.kill()
  rmSync(dir, { recursive: true, force: true })
})

startRelay(PORT)

await sleep(400) // 等它 listen

// ---------------------------------------------------------------- 开测
try {
  console.log('\n中继')

  {
    const { msg } = await expectReject(
      new URLSearchParams({ role: 'phone', code: 'ZZZZZZ' }),
    )
    check('码不对时明确告诉手机错在哪', msg?.type === 'relay:error' && msg.code === 'no_pairing', JSON.stringify(msg))
  }

  const host = await asHost()
  check('电脑连上中继', host.opened && !host.closed())

  {
    const { msg } = await expectReject(
      new URLSearchParams({ role: 'host', code: CODE, token: 'wrong-token' }),
    )
    check('token 不对就不能冒充电脑', msg?.code === 'code_taken', JSON.stringify(msg))
    check('而且原来那条电脑连接没被顶掉', !host.closed())
  }

  const phone = await asPhone()
  check('手机连上并被告知电脑在线', (await phone.next())?.online === true)

  {
    const phone2 = await asPhone()
    check('第二台手机也能进同一个配对', (await phone2.next())?.online === true)

    host.send({ type: 'text', delta: '大家好' })
    const both = await Promise.all([phone.next(), phone2.next()])
    check('电脑发的消息两台手机都收到', both.every((m) => m.type === 'text' && m.delta === '大家好'))

    phone2.close()
  }

  console.log('\n转发')

  {
    phone.send({ type: 'prompt', text: '把桌面的文件发我' })
    const got = await host.next()
    check('手机发的指令到得了电脑', got?.type === 'prompt' && got.text === '把桌面的文件发我', JSON.stringify(got))
  }

  {
    // 中继不该解析消息体 —— 丢一个它完全不认识的类型进去，照样要转发
    host.send({ type: '未来才有的消息', '随便什么字段': [1, 2, 3] })
    const got = await phone.next()
    check('中继不看消息体，原样转发', got?.type === '未来才有的消息', JSON.stringify(got))
  }

  console.log('\n断线与重连')

  {
    const host2 = await asHost() // 同一个码 + 同一个 token = 同一台电脑重连
    check('同码同 token 重连被认作同一台电脑', host2.opened)
    check('旧连接被顶掉', await waitFor(() => host.closed()))
    check('手机被告知电脑在线了一次', (await phone.next())?.online === true)

    host2.send({ type: 'text', delta: '是我，新连接' })
    const got = await phone.next()
    check('新连接的电脑能正常发消息', got?.delta === '是我，新连接', JSON.stringify(got))

    host2.close()
    const gone = await phone.next(3000).catch(() => null)
    check('电脑掉线时手机会收到通知', gone?.online === false, JSON.stringify(gone))
  }

  console.log('\n回收')

  {
    // 电脑离线、也没人看着 —— 这个配对就该被收掉，否则内存只增不减。
    //
    // 这一节必须排在限流前面：限流会把我们这个 IP 关进小黑屋，
    // 之后连什么都连不上了，回收就验不了。
    phone.close()
    await sleep(3000) // idle 是 2s，回收器每 500ms 扫一次

    const c = await asPhone()
    const msg = await c.next().catch(() => null)
    check('没人要的配对会被回收', msg?.code === 'no_pairing', JSON.stringify(msg))
    c.close()
  }

  console.log('\n限流')

  {
    const seen = []
    let refusedAt = -1
    for (const bad of BAD_CODES) {
      const r = await expectReject(new URLSearchParams({ role: 'phone', code: bad }))
      seen.push(r)
      if (r.refused) {
        refusedAt = seen.length - 1
        break
      }
    }
    check('猜错码猜多了会被中继挡在门外', refusedAt !== -1, `试了 ${seen.length} 次都没被拒`)
    check('被拒之前确实先好好回答了错在哪', seen.some((r) => r.msg?.code === 'no_pairing'))
  }

  // ---------------------------------------------------------------- 真家伙
  if (LIVE) {
    console.log('\n真电脑 + 真模型')

    // 换一个干净的中继：上面那节已经把本机 IP 打到限流里了
    BASE = wsBase(PORT + 1)
    startRelay(PORT + 1)
    await sleep(400) // 等它 listen

    const cfgFile = join(dir, 'config.json')
    const hostProc = spawn(
      process.execPath,
      ['--env-file-if-exists=../.env', 'src/index.mjs'],
      {
        cwd: join(root, 'host'),
        env: { ...process.env, GOAGENT_RELAY: BASE, GOAGENT_CONFIG: cfgFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    hostProc.stderr.on('data', (d) => process.stderr.write(`  [host] ${d}`))

    const code = await waitFor(() => {
      try {
        const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
        return cfg.code || false
      } catch {
        return false // 还没写出来
      }
    }, 15000)

    check('host 启动并写出了自己的配对码', typeof code === 'string')

    const p = await asPhone(code)
    check('手机连上了这台真电脑', (await p.next(8000))?.online === true)

    p.send({ type: 'prompt', text: '只回四个字：链路已通' })
    const text = await collectText(p, 60000)
    check('手机上收到了模型流式吐出来的字', text.length > 0, `收到 ${text.length} 字`)
    console.log(`     模型说：${text.trim().slice(0, 60)}`)

    p.close()
    hostProc.kill()
  } else {
    console.log('\n（加 --live 可以把真的 host 拉起来，问模型一句）')
  }
} catch (err) {
  failed++
  console.log(`\n✗ 异常终止：${err?.stack ?? err}`)
}

console.log(failed ? `\n✗ ${failed} 项没过\n` : '\n✓ M1 全部通过\n')
process.exit(failed ? 1 : 0)

// ---------------------------------------------------------------- 工具
/** 反复试，直到 fn 返回真值。超时返回 null。 */
async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(50)
  }
}

/** 一直收，收到 done 或 error 为止，把中间的 text 拼起来 */
async function collectText(client, timeout) {
  let out = ''
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const msg = await client.next(deadline - Date.now()).catch(() => null)
    if (!msg) break
    if (msg.type === 'text') out += msg.delta
    else if (msg.type === 'done' || msg.type === 'error') break
  }
  return out
}
