// 与 Go daemon 的 WebSocket 连接。
// 刻意不依赖 Vue —— 以后 CLI 端可以原样复用这个文件。

export type Status = 'connecting' | 'open' | 'closed'

export interface Handlers {
  message: (text: string) => void
  status?: (s: Status) => void
}

const RECONNECT_DELAY = 1000

export function connectWS({ message, status }: Handlers) {
  // 断线期间发的消息先攒着，连上再补发
  const pending: string[] = []
  let ws: WebSocket

  function connect() {
    status?.('connecting')

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${scheme}://${location.host}/ws`)

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
