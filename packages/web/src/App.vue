<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { connectWS, type Status } from './ws'

const LABEL: Record<Status, string> = {
  connecting: '连接中…',
  open: '已连接',
  closed: '已断开，重连中…',
}

/** daemon 广播给客户端的消息。发出去的和收回来的共用同一套形状。 */
type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'prompt'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'ready'; model: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** 界面上的一颗气泡 */
interface Bubble {
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

const bubbles = ref<Bubble[]>([])
const draft = ref('')
const status = ref<Status>('connecting')
const running = ref(false)
const sessionId = ref('')

let send = (_: string) => {}

onMounted(() => {
  send = connectWS({ message: onEvent, status: (s) => (status.value = s) }).send
})

function onEvent(raw: string) {
  let ev: AgentEvent
  try {
    ev = JSON.parse(raw)
  } catch {
    return // 不是协议消息，丢掉
  }

  switch (ev.type) {
    case 'session':
      // 服务端告诉我们落在哪个会话。写回地址栏 —— 刷新不丢，
      // 复制给别人就能进同一个会话，那边的提问和回复我们全看得见。
      sessionId.value = ev.id
      {
        const url = new URL(location.href)
        url.searchParams.set('session', ev.id)
        history.replaceState(null, '', url)
      }
      break

    case 'prompt':
      // 服务端把我们的 prompt 原样广播回来，每个窗口都看得到这一问
      bubbles.value.push({ kind: 'user', text: ev.text })
      running.value = true
      break

    case 'text':
      appendToAssistant(ev.delta)
      break

    case 'tool_start':
      bubbles.value.push({ kind: 'tool', text: `⚙ 调用 ${ev.name}` })
      break

    case 'tool_end':
      bubbles.value.push({ kind: 'tool', text: `${ev.ok ? '✓' : '✗'} ${ev.name} 结束` })
      break

    case 'done':
      running.value = false
      break

    case 'error':
      bubbles.value.push({ kind: 'error', text: ev.message })
      running.value = false
      break
  }
}

// 流式文本是一堆碎片，黏到最后一颗 assistant 气泡上；
// 中间被工具调用隔开就另起一颗。
function appendToAssistant(delta: string) {
  const last = bubbles.value[bubbles.value.length - 1]
  if (last?.kind === 'assistant') last.text += delta
  else bubbles.value.push({ kind: 'assistant', text: delta })
}

function submit() {
  const text = draft.value.trim()
  if (!text || running.value) return
  send(JSON.stringify({ type: 'prompt', text }))
  draft.value = ''
}

// 只是把 cancel 发给服务端，由它透传给 agent。会话里任何一端按停止，
// 所有人都会看到它停下来。
function stop() {
  send(JSON.stringify({ type: 'cancel' }))
}
</script>

<template>
  <main>
    <header>
      <i class="dot" :class="status" />
      {{ LABEL[status] }}
      <span v-if="running" class="busy">思考中…</span>
      <span v-if="sessionId" class="session" title="把地址栏链接发给别人，就能进同一个会话">
        {{ sessionId }}
      </span>
    </header>

    <ul class="messages">
      <li v-for="(b, i) in bubbles" :key="i" :class="b.kind">{{ b.text }}</li>
      <li v-if="!bubbles.length" class="empty">
        说点什么。想多端同步，把地址栏里的 <code>?session=</code> 一起发过去
      </li>
    </ul>

    <form @submit.prevent="submit">
      <input v-model="draft" placeholder="输入后回车" autocomplete="off" :disabled="running" />
      <button v-if="!running" :disabled="!draft.trim()">发送</button>
      <button v-else type="button" class="stop" @click="stop">停止</button>
    </form>
  </main>
</template>
