package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// 单条消息上限，防止有人推个大包把内存打爆
	maxMessageSize = 1 << 20 // 1 MiB

	// 一条消息 10 秒还写不完，就当连接已经死了
	writeWait = 10 * time.Second

	// 心跳：60 秒收不到任何数据（含 pong）就认定断线
	pongWait   = 60 * time.Second
	pingPeriod = pongWait * 9 / 10

	// 每个连接的发送缓冲。写满意味着客户端消费不过来，见 Hub.broadcast
	sendBuffer = 256
)

// upgrader 负责把 HTTP 请求升级成 WebSocket 连接。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// ponytail: 开发期放开所有来源，方便手机走局域网连过来。上线要收紧成白名单。
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client 是一个 WebSocket 连接。
//
// 两个 goroutine 驱动它，各自只管一个方向：
//   - readPump  只读，收到消息交给 Hub
//   - writePump 只写，从 send 取消息
//
// gorilla/websocket 不允许并发写，所以「写」必须收敛到 writePump 一个地方，
// 其他 goroutine 想发消息只能往 send 里塞。
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// session 是这个连接属于哪个会话。加进 hub 之前就设好、之后不再改，
	// 所以 Hub.broadcast 带着读锁读它是安全的。
	session string
}

func serveWS(sessions *Sessions, hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade 失败时它自己已经写过 HTTP 错误响应了，这里只记日志
		log.Printf("websocket 升级失败: %v", err)
		return
	}

	// ?session=xxx 复用已有会话；不传就开一个新的
	sess, err := sessions.GetOrCreate(r.URL.Query().Get("session"))
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, errorEvent("创建会话失败: "+err.Error()))
		conn.Close()
		return
	}

	c := &Client{hub: hub, conn: conn, send: make(chan []byte, sendBuffer), session: sess.ID}
	hub.add(c) // 必须在起 writePump 之前登记，否则会漏掉这期间广播的消息

	// 记上这一个客户端。只要还有人在看，这个会话就不会被回收器收掉 ——
	// 一定要在 readPump 之前加，否则短暂连接会先减后加，把计数弄成负数。
	sessions.AddClient(sess.ID)

	// 先告诉客户端它落在哪个会话。它得把这个 id 放进 URL 才能分享给别人一起看。
	c.send <- sessionEvent(sess.ID)

	go c.writePump()
	c.readPump(sessions) // 阻塞到连接断开为止
}

// readPump 独占读循环。函数返回即代表连接结束，顺手把现场收拾干净。
func (c *Client) readPump(sessions *Sessions) {
	defer func() {
		c.hub.remove(c)
		c.conn.Close()
		sessions.RemoveClient(c.session)
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))

	// 收到 pong 就把截止时间往后推 —— 心跳保活靠的就是这一句
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("连接异常断开: %v", err)
			}
			return
		}
		sessions.Handle(c.session, msg)
	}
}

// writePump 独占写循环。send 被 close 时正常收尾。
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub 把这个连接摘掉了，礼貌地回一个 close 帧
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}

		case <-ticker.C:
			// 定时 ping。对端不回 pong 的话，readPump 那边的读超时会把连接收掉
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
