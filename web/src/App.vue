<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { connectWS, type Status } from './ws'

const LABEL: Record<Status, string> = {
  connecting: '连接中…',
  open: '已连接',
  closed: '已断开，重连中…',
}

/** 中继和电脑发来的消息。发出去的和收回来的共用同一套形状。 */
type AgentEvent =
  | { type: 'relay:presence'; online: boolean }
  | { type: 'relay:error'; code: string; message: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'ask_access'; path: string; reason: string; requestId: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** 界面上的一颗气泡 */
interface Bubble {
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

// 地址栏里带 code 就直接连 —— 加到桌面之后每次打开都走这条路，
// 用户不会再看到配对界面。
const code = ref(new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '')
const draftCode = ref('')
const notice = ref('')

const bubbles = ref<Bubble[]>([])
const draft = ref('')
const status = ref<Status>('connecting')
const running = ref(false)
/** 电脑在不在线。null = 中继还没告诉我们 */
const online = ref<boolean | null>(null)
/** 电脑上的 agent 正在申请一个目录的权限。null = 没有待确认的 */
const ask = ref<{ path: string; reason: string; requestId: string } | null>(null)

let send = (_: string) => {}
let close = () => {}

onMounted(() => {
  if (code.value) start()
})

function start() {
  bubbles.value = []
  notice.value = ''
  online.value = null
  ask.value = null

  const conn = connectWS({
    code: () => code.value,
    message: onEvent,
    status: (s) => (status.value = s),
  })
  send = conn.send
  close = conn.close
}

function pair() {
  const c = draftCode.value.trim().toUpperCase()
  if (c.length < 4) {
    notice.value = '配对码是电脑上显示的那 6 位'
    return
  }
  draftCode.value = ''
  code.value = c
  const url = new URL(location.href)
  url.searchParams.set('code', c)
  history.replaceState(null, '', url)
  start()
}

/** 断开并回到配对界面。换电脑、或者码输错了都走这里。 */
function unpair() {
  close()
  code.value = ''
  online.value = null
  const url = new URL(location.href)
  url.searchParams.delete('code')
  history.replaceState(null, '', url)
}

function onEvent(raw: string) {
  let ev: AgentEvent
  try {
    ev = JSON.parse(raw)
  } catch {
    return // 不是协议消息，丢掉
  }

  switch (ev.type) {
    case 'relay:presence':
      // 中继告诉我们电脑上线/掉线了。没有这条，只能对着空气打字。
      online.value = ev.online
      break

    case 'relay:error':
      if (ev.code === 'no_pairing') {
        // 码不对。必须断开 —— 不然它会拿着这个错码一直重连下去。
        unpair()
        notice.value = '没有电脑用这个码。确认电脑上的 goagent-host 正在跑，码没抄错。'
      } else {
        bubbles.value.push({ kind: 'error', text: ev.message })
      }
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

    case 'ask_access':
      // 电脑上的 agent 撞到一堵墙：它想看的目录用户还没授权。
      // 这一下必须由人来点 —— 整套权限模型就落在这个弹窗上。
      ask.value = { path: ev.path, reason: ev.reason, requestId: ev.requestId }
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
  if (!text || running.value || !online.value) return
  send(JSON.stringify({ type: 'prompt', text }))
  bubbles.value.push({ kind: 'user', text })
  draft.value = ''
  running.value = true
}

// 只是把 cancel 发过去，由电脑端透传给 agent。
function stop() {
  send(JSON.stringify({ type: 'cancel' }))
}

/** 用户对「申请访问某个目录」的回答。 */
function answer(ok: boolean) {
  const a = ask.value
  if (!a) return
  send(JSON.stringify({ type: 'grant', requestId: a.requestId, ok }))
  bubbles.value.push({
    kind: ok ? 'tool' : 'error',
    text: ok ? `已允许访问 ${a.path}` : `已拒绝访问 ${a.path}`,
  })
  ask.value = null
}
</script>

<template>
  <main>
    <!-- 还没配对：只要一串码 -->
    <form v-if="!code" class="pair" @submit.prevent="pair">
      <h1>连接你的电脑</h1>
      <p class="hint">
        在电脑上跑 <code>pnpm host</code>，终端会显示一串 6 位配对码。输在这里。
      </p>
      <input
        v-model="draftCode"
        class="code"
        placeholder="ABC123"
        autocapitalize="characters"
        autocomplete="off"
        spellcheck="false"
      />
      <button :disabled="!draftCode.trim()">配对</button>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </form>

    <template v-else>
      <header>
        <i class="dot" :class="status" />
        <span>{{ LABEL[status] }}</span>

        <span class="host" :class="{ offline: online === false }">
          <i class="dot" :class="online === null ? '' : online ? 'open' : 'closed'" />
          {{ online === null ? '电脑状态未知' : online ? '电脑在线' : '电脑离线' }}
        </span>

        <button class="link" type="button" title="换一台电脑" @click="unpair">{{ code }}</button>
      </header>

      <ul class="messages">
        <li v-for="(b, i) in bubbles" :key="i" :class="b.kind">{{ b.text }}</li>
        <li v-if="!bubbles.length" class="empty">
          <template v-if="online === false">
            电脑上的 goagent-host 不在线。把它跑起来，这里会自动连上。
          </template>
          <template v-else>说点什么，让电脑上的 agent 去做。</template>
        </li>
      </ul>

      <!-- 授权确认。放在输入框上面、贴着底部 —— 拇指够得到的地方。
           agent 正停在这儿等一个回答，不给它答复它就一直卡住。 -->
      <div v-if="ask" class="ask">
        <p class="what">电脑上的 agent 想访问一个目录</p>
        <code class="path">{{ ask.path }}</code>
        <p class="why">{{ ask.reason }}</p>
        <div class="row">
          <button type="button" class="ghost" @click="answer(false)">拒绝</button>
          <button type="button" @click="answer(true)">允许</button>
        </div>
      </div>

      <form @submit.prevent="submit">
        <input
          v-model="draft"
          placeholder="让电脑干点什么"
          autocomplete="off"
          :disabled="running || !online || !!ask"
        />
        <button v-if="!running" :disabled="!draft.trim() || !online || !!ask">发送</button>
        <button v-else type="button" class="stop" @click="stop">停止</button>
      </form>
    </template>
  </main>
</template>
