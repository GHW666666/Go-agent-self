// 和中继的 WebSocket 连接。
// 刻意不依赖 Vue —— 以后 Capacitor 打包、或者别的客户端可以原样复用。

export type Status = 'connecting' | 'open' | 'closed'

export interface Handlers {
  /** 每次（重）连都现取一次配对码，用户中途改了也能跟上 */
  code: () => string
  message: (text: string) => void
  status?: (s: Status) => void
}

const RECONNECT_DELAY = 1000

// 配对码放在地址栏里，URL 是唯一的真相来源：
// 刷新不丢、加到手机桌面就一直记得、重连也自动带上同一个。
function wsURL(code: string) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const q = new URLSearchParams({ role: 'phone', code })
  return `${scheme}://${location.host}/ws?${q}`
}

export function connectWS({ code, message, status }: Handlers) {
  // 断线期间发的消息先攒着，连上再补发
  const pending: string[] = []
  let ws: WebSocket
  let stopped = false

  function connect() {
    if (stopped) return
    status?.('connecting')

    ws = new WebSocket(wsURL(code()))

    ws.onopen = () => {
      status?.('open')
      for (const text of pending.splice(0)) ws.send(text)
    }

    ws.onmessage = (e) => message(e.data)

    // 断线自动重连。中继重启、切 WiFi、手机息屏回来都靠它兜住。
    //
    // 浏览器这边和 Node 不一样：连不上时 onclose **也会**触发，
    // 所以这里只监听 onclose 就够了（Node 那边必须额外处理 onerror，
    // 否则连不上时会一声不响地什么都不做）。
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
    /** 用户主动断开（比如要换一个配对码）。不停止的话它会拿着旧码一直重连。 */
    close() {
      stopped = true
      ws.close()
    },
  }
}
