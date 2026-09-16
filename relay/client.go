package main

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

const (
	roleHost  = "host"  // 电脑：有文件、有 agent、主动连出来
	rolePhone = "phone" // 手机：只有屏幕和输入，连进来

	// 单条消息上限，防止有人推个大包把内存打爆
	maxMessageSize = 1 << 20 // 1 MiB

	// 一条消息 10 秒还写不完，就当连接已经死了
	writeWait = 10 * time.Second

	// 心跳：60 秒收不到任何数据（含 pong）就认定断线
	pongWait   = 60 * time.Second
	pingPeriod = pongWait * 9 / 10

	// 每个连接的发送缓冲。写满意味着对端消费不过来，见 Hub.toControllers
	sendBuffer = 256
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// ponytail: 开发期放开所有来源，方便手机走局域网连过来。上 VPS 要收紧成白名单。
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client 是一个 WebSocket 连接。
//
// 两个 goroutine 驱动它，各自只管一个方向：
//   - readPump  只读，收到消息转给对面
//   - writePump 只写，从 send 取消息
//
// gorilla/websocket 不允许并发写，所以「写」必须收敛到 writePump 一个地方，
// 其他 goroutine 想发消息只能往 send 里塞。
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// role 在登记之前就设好、之后不再改，所以读它不需要加锁
	role string

	// 下面两个由 hub.mu 保护
	pairing *Pairing
	closed  bool
}

func serveWS(hub *Hub, lim *limiter, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	role := q.Get("role")
	if role != roleHost && role != rolePhone {
		http.Error(w, `role 必须是 "host" 或 "phone"`, http.StatusBadRequest)
		return
	}

	ip := clientIP(r)

	// 限流放在 Upgrade **之前**：升级成 WebSocket 之后再拒绝，
	// 等于白白养了一个长连接，反而给了攻击者一个更省事的资源消耗方式。
	if !lim.allow(ip) {
		http.Error(w, "尝试次数过多，请稍后再试", http.StatusTooManyRequests)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade 失败时它自己已经写过 HTTP 错误响应了，这里只记日志
		log.Printf("websocket 升级失败: %v", err)
		return
	}

	c := &Client{hub: hub, conn: conn, send: make(chan []byte, sendBuffer), role: role}

	// 两个 accept 都负责「登记进 hub」，登记一定发生在 writePump 起来之前 ——
	// 否则这期间发给它的消息会丢。
	if role == roleHost {
		if !acceptHost(hub, lim, ip, c, q) {
			return
		}
	} else if !acceptPhone(hub, lim, ip, c, q) {
		return
	}

	go c.writePump()
	c.readPump() // 阻塞到连接断开为止
}

func acceptHost(hub *Hub, lim *limiter, ip string, c *Client, q url.Values) bool {
	code := normalizeCode(q.Get("code"))
	token := q.Get("token")
	if !codeRe.MatchString(code) || token == "" {
		c.reject(errors.New("host 必须带合法的 code 和 token"))
		return false
	}

	p, created, err := hub.attachHost(c, code, token)
	if err != nil {
		// 拿着码但 token 不对 —— 这是在试着冒充一台电脑，一样要记账。
		lim.fail(ip)
		c.reject(err)
		return false
	}

	// 新建一条配对就是往内存里加一条记录，而任何人都能拿随机码连过来说自己是
	// host。所以「新建」也要记账，和手机猜错码一个待遇，否则这张表能被灌爆。
	if created {
		lim.fail(ip)
	} else {
		lim.ok(ip) // 带对 token 的重连，是正常行为，不是攻击
	}

	log.Printf("电脑已接入，配对码 %s", p.code)
	hub.notifyPresence(p, true)
	return true
}

func acceptPhone(hub *Hub, lim *limiter, ip string, c *Client, q url.Values) bool {
	code := normalizeCode(q.Get("code"))

	p, err := hub.attachController(c, code)
	if err != nil {
		lim.fail(ip)
		c.reject(err)
		return false
	}
	lim.ok(ip)

	// 连上就先告诉它电脑在不在，不然手机只能对着空气打字
	online := p.host != nil
	c.send <- presenceMsg(online)

	state := "离线"
	if online {
		state = "在线"
	}
	log.Printf("手机已接入配对 %s（电脑%s）", p.code, state)
	return true
}

// reject 走的是「还没进 readPump 就得赶人走」的路径：发一条错误帧再关。
// 客户端拿到的是有原因的错误，而不是一次莫名其妙的断线。
func (c *Client) reject(err error) {
	code, msg := "bad_request", err.Error()
	var pe *pairError
	if errors.As(err, &pe) {
		code, msg = pe.code, pe.msg
	}

	c.conn.SetWriteDeadline(time.Now().Add(writeWait))
	c.conn.WriteMessage(websocket.TextMessage, errorMsg(code, msg))
	c.conn.Close()
}

// readPump 独占读循环。函数返回即代表连接结束，顺手把现场收拾干净。
func (c *Client) readPump() {
	defer func() {
		c.hub.detach(c)
		c.conn.Close()
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

		// ★ 中继的全部业务逻辑，就这四行。
		// 谁发的决定转给谁，消息体一个字节都不解析。
		if c.role == roleHost {
			c.hub.toControllers(c, msg)
		} else {
			c.hub.toHost(c, msg)
		}
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

// clientIP 取来源 IP，用于限流。
//
// ponytail: 直接读 RemoteAddr。上了 VPS 之后如果前面挂了 Nginx 或 CDN，
// 这里取到的是反代的地址，所有用户会共用一个桶 —— 到时候要改成读
// X-Forwarded-For，并且只信任自己那台反代。
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
