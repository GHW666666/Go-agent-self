// 把 pi 的 agent 包成一个 stdio 子进程，供 Go daemon 驱动。
//
//   stdin   ← 一行一条 JSON 命令，例如 {"type":"prompt","text":"你好"}
//   stdout  → 一行一条 JSON 事件，例如 {"type":"text","delta":"你"}
//   stderr  → 日志（不参与协议）
//
// ⚠️ stdout 是协议通道。任何 console.log 都会污染它，日志一律 console.error。
import { createInterface } from 'node:readline'
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { tools } from './tools.mjs'

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function log(...args) {
  console.error('[agent]', ...args)
}

const models = createModels()
models.setProvider(deepseekProvider())

const modelId = process.env.GOAGENT_MODEL ?? 'deepseek-v4-flash'
const model = models.getModel('deepseek', modelId)
if (!model) {
  emit({ type: 'error', message: `找不到模型 deepseek/${modelId}` })
  process.exit(1)
}

const agent = new Agent({
  initialState: {
    systemPrompt:
      '你是 goagent 的执行内核。需要查看文件时就用工具，不要靠猜。回答保持简洁。',
    model,
    tools,
  },
  streamFn: models.streamSimple.bind(models),
})

agent.subscribe((event) => {
  // 流式文本：LLM 每吐一小段就发一次，前端靠它做打字机效果
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    emit({ type: 'text', delta: event.assistantMessageEvent.delta })
  }

  // 工具调用前后各发一条，前端就能显示「正在调用 xxx」
  if (event.type === 'tool_execution_start') {
    emit({ type: 'tool_start', name: event.toolName, args: event.args })
  }
  if (event.type === 'tool_execution_end') {
    emit({ type: 'tool_end', name: event.toolName, ok: !event.isError })
  }
})

// 一次 prompt 的生命周期。agent 不支持并发 prompt，
// 所以用一条 Promise 链把它们排成队，一个跑完再跑下一个。
let queue = Promise.resolve()

async function handle(msg) {
  if (msg.type !== 'prompt') {
    log('未知消息类型:', msg.type)
    return
  }
  try {
    await agent.prompt(msg.text)
    emit({ type: 'done' })
  } catch (err) {
    emit({ type: 'error', message: String(err?.message ?? err) })
  }
}

const lines = createInterface({ input: process.stdin })

lines.on('line', (line) => {
  const text = line.trim()
  if (!text) return

  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    // 客户端发的裸文本会走到这儿。忽略掉，不要让一行垃圾终止整个进程。
    log('收到非 JSON，忽略:', text.slice(0, 80))
    return
  }

  // ⚠️ cancel 必须绕开队列。它要打断的正是队列头部那个正在跑的 prompt，
  // 排到队尾就等于永远不生效 —— 等它执行时前面那个早就跑完了。
  if (msg.type === 'cancel') {
    log('收到取消请求')
    agent.abort()
    return
  }

  queue = queue.then(() => handle(msg))
})

// 父进程关掉 stdin（或死了），我们就跟着退出，不留孤儿进程
lines.on('close', () => {
  log('stdin 已关闭，退出')
  process.exit(0)
})

emit({ type: 'ready', model: modelId })
log(`就绪，模型 deepseek/${modelId}`)
