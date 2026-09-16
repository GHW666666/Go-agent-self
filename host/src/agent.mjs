// pi 的接线。跟 v1 的 host.mjs 几乎一样，只有传输层换掉了：
// v1 是 stdin/stdout 子进程，现在是一个 WebSocket 客户端 ——
// agent 这一层完全不知道外面是什么，所以这段没怎么动。
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'

const SYSTEM = `你是跑在这台电脑上的 agent，用户正在用手机远程指挥你。
你眼前的文件系统就是这台电脑的，用户看不到 —— 要看什么就用工具去看，不要靠猜。
你的回答会显示在手机屏幕上，保持简洁。`

export function createAgent({ onEvent, onLog = () => {} }) {
  const models = createModels()
  models.setProvider(deepseekProvider())

  const modelId = process.env.GOAGENT_MODEL ?? 'deepseek-v4-flash'
  const model = models.getModel('deepseek', modelId)
  if (!model) throw new Error(`找不到模型 deepseek/${modelId}`)

  // ponytail: M1 不挂任何工具 —— 这个里程碑只验链路通不通。
  // 文件工具要等白名单（M2）一起上，否则一个自动放行的模型就能翻你整个硬盘。
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, model, tools: [] },
    streamFn: models.streamSimple.bind(models),
  })

  agent.subscribe((event) => {
    // 流式文本：LLM 每吐一小段就发一次，前端靠它做打字机效果
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      onEvent({ type: 'text', delta: event.assistantMessageEvent.delta })
    }

    // 工具调用前后各发一条，前端就能显示「正在调用 xxx」
    if (event.type === 'tool_execution_start') {
      onEvent({ type: 'tool_start', name: event.toolName, args: event.args })
    }
    if (event.type === 'tool_execution_end') {
      onEvent({ type: 'tool_end', name: event.toolName, ok: !event.isError })
    }
  })

  // 一次 prompt 的生命周期。agent 不支持并发 prompt，
  // 所以用一条 Promise 链把它们排成队，一个跑完再跑下一个。
  let queue = Promise.resolve()
  let cancelling = false

  function prompt(text) {
    cancelling = false
    queue = queue.then(async () => {
      try {
        await agent.prompt(text)
        onEvent({ type: 'done' })
      } catch (err) {
        // 用户按了停止。被打断的 prompt 通常以异常收场，但这不是故障，
        // 手机上不该因此弹一个红色的东西出来吓人。
        if (cancelling) onEvent({ type: 'done' })
        else onEvent({ type: 'error', message: String(err?.message ?? err) })
      }
    })
    return queue
  }

  // ⚠️ cancel 必须绕开队列。它要打断的正是队列头部那个正在跑的 prompt，
  // 排到队尾就等于永远不生效 —— 等它执行时前面那个早就跑完了。
  function cancel() {
    cancelling = true
    onLog('收到取消请求')
    agent.abort()
  }

  return { model: modelId, prompt, cancel }
}
