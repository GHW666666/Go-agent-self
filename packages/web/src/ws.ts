// 与 Go daemon 的 WebSocket 连接。
// 刻意不依赖 Vue —— 以后 CLI 端可以原样复用这个文件。

export type Status = 'connecting' | 'open' | 'closed'

export interface Handlers {
  message: (text: string) => void
  status?: (s: Status) => void
}

const RECONNECT_DELAY = 1000

// 会话 id 就放在地址栏里，URL 是唯一的真相来源：
// 刷新不丢、复制链接给别人就能一起看、重连也自动带上同一个。
// 服务端会在连上后回一条 session 事件，客户端拿到再写回地址栏。
function wsURL() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const session = new URLSearchParams(location.search).get('session')
  const query = session ? `?session=${encodeURIComponent(session)}` : ''
  return `${scheme}://${location.host}/ws${query}`
}

export function connectWS({ message, status }: Handlers) {
  // 断线期间发的消息先攒着，连上再补发
  const pending: string[] = []
  let ws: WebSocket

  function connect() {
    status?.('connecting')

    // 每次重连都重新读一次地址栏，这样期间换过会话也能跟上
    ws = new WebSocket(wsURL())

    ws.onopen = () => {
      status?.('open')
      for (const text of pending.splice(0)) ws.send(text)
    }

    ws.onmessage = (e) => message(e.data)

    // 断线自动重连。daemon 重启、切网络、手机息屏回来都靠它兜住。
    ws.onclose = () => {
      status?.('closed')
      setTimeout(connect, RECONNECT_DELAY)
    }
  }

  connect()

  return {
    send(text: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
      else pending.push(text)
    },
  }
}
