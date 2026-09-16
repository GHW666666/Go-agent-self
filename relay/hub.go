package main

import (
	"log"
	"sync"
	"time"
)

// Pairing 是一次配对：一台电脑（host）+ 任意多个控制器（手机、浏览器、终端）。
//
// 和 v1 的 session 最本质的区别是**两端不对等**：
//   - host 是服务提供方，只有一个，且必须先到
//   - controller 是消费方，可以有很多个，随时来随时走
//
// v1 那种「所有客户端平等、靠 ?session= 共享」的模型套不住这个形状，
// 所以 v2 重写了这一层。
//
// 所有字段都由 Hub.mu 保护。
type Pairing struct {
	code  string
	token string // 只有电脑端知道。见 attachHost

	host        *Client
	controllers map[*Client]struct{}
	lastSeen    time.Time
}

// Hub 持有所有配对。
//
// ★ 并发不变量，整套代码都靠它成立：
//   发送一律在读锁内完成，remove 持写锁关 channel，两者天然互斥。
//   所以不可能出现「往已关闭的 channel 发送」的 panic。
//   代价是发送必须是非阻塞的 —— 否则一个慢客户端能把整个 Hub 卡住。
type Hub struct {
	mu       sync.RWMutex
	pairings map[string]*Pairing
}

func NewHub() *Hub {
	return &Hub{pairings: make(map[string]*Pairing)}
}

// ---------------------------------------------------------------- 接入

// pairError 带一个机器可读的 code —— 客户端靠它决定怎么办，
// 而不是去匹配一句中文。
type pairError struct {
	code string
	msg  string
}

func (e *pairError) Error() string { return e.msg }

var (
	errCodeTaken = &pairError{code: "code_taken", msg: "这个配对码已被另一台电脑占用"}
	errNoPairing = &pairError{code: "no_pairing", msg: "配对码不存在，检查一下电脑屏幕上显示的那串"}
)

// attachHost 注册一台电脑，created 表示这是不是一个全新的配对。
//
// 两种情况走到这里：
//   - 第一次配对：码是新的，建表
//   - 同一台电脑重连（网络抖动、进程重启）：码和 token 都对得上，把旧连接顶掉
//
// token 是这里的关键。配对码是要人从屏幕上念到手机里敲的，它不算秘密；
// 光凭码谁都能冒充电脑。所以认的是「码 + token」，token 只在电脑本地存着。
//
// 带对 token 的重连直接顶掉旧连接 —— 网络一抖时，旧连接多半已经死了但还没被
// readPump 回收，不顶掉的话这台电脑会一直卡在「码被占用」，而占着它的其实是自己。
func (h *Hub) attachHost(c *Client, code, token string) (p *Pairing, created bool, err error) {
	h.mu.Lock()

	p, ok := h.pairings[code]
	if !ok {
		p = &Pairing{code: code, token: token, controllers: make(map[*Client]struct{})}
		h.pairings[code] = p
		created = true
	} else if p.token != token {
		h.mu.Unlock()
		return nil, false, errCodeTaken
	}

	old := p.host
	p.host = c
	p.lastSeen = time.Now()
	c.pairing = p
	n := len(p.controllers) // 出锁之后 p 就不受保护了，先数出来
	h.mu.Unlock()

	if old != nil && old != c {
		// 得先出锁：evict 要写锁。告诉它被顶掉了，否则它会当成网络抖动一直重连。
		h.evict(old, "evicted", "另一个进程用同一个配对码连上来了")
	}
	// 电脑可能是后到的（重启、换网络），而手机早就守在那儿了。
	// 不补一条的话它会以为没人在看，agent 申请权限时直接放弃等待。
	h.notifyWatchers(p, n)
	return p, created, nil
}

// attachController 把一台手机挂到一个已存在的配对上。
func (h *Hub) attachController(c *Client, code string) (*Pairing, error) {
	h.mu.Lock()

	p, ok := h.pairings[code]
	if !ok {
		h.mu.Unlock()
		return nil, errNoPairing
	}
	p.controllers[c] = struct{}{}
	p.lastSeen = time.Now()
	c.pairing = p
	n := len(p.controllers)
	h.mu.Unlock()

	h.notifyWatchers(p, n)
	return p, nil
}

// ---------------------------------------------------------------- 摘除

// removeLocked 摘掉一个连接，**幂等**：readPump 结束、慢客户端被踢、
// 电脑被顶掉，三条路径都会调它，重复调不能重复 close。
// 调用方必须已持有写锁。
func (h *Hub) removeLocked(c *Client) {
	if c.closed {
		return
	}
	c.closed = true
	close(c.send) // writePump 靠这个信号退出

	p := c.pairing
	if p == nil {
		return
	}
	c.pairing = nil
	if p.host == c {
		p.host = nil
	} else {
		delete(p.controllers, c)
	}
	p.lastSeen = time.Now() // 有人离开，闲置计时从这一刻重新算
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	h.removeLocked(c)
	h.mu.Unlock()
}

// evict 顶掉一个连接，**并且告诉它为什么**。
//
// 只说「连接断了」是不够的：对面看到 onclose 会当成网络抖动，转头就重连。
// 两个进程拿着同一个配对码时，这就变成每秒一次的互相顶替 —— 谁也连不上，
// 而且日志里只有一行行「电脑已接入」，看不出任何异常。
//
// 必须先塞消息再 close：removeLocked 会关掉 send，关掉之后就再也塞不进去了。
// 塞的时候持写锁 —— 别的路径（detach、踢慢客户端）也会来关这个 channel，
// 只有写锁能保证「塞」和「关」不重叠，同 Hub 上那条不变量。
// 非阻塞，所以拿着写锁也不会被慢客户端拖住。
func (h *Hub) evict(c *Client, code, msg string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if !c.closed {
		select {
		case c.send <- errorMsg(code, msg):
		default: // 缓冲满了，这条通知只能算了 —— 连接本来就要关
		}
	}
	h.removeLocked(c)
}

// detach 是连接结束时的收尾：先摘掉自己，如果自己是电脑，再告诉所有手机一声。
//
// 通知必须放在锁外面 —— notifyPresence 要读锁，而这里是写锁。
// 不能直接在 removeLocked 里做，就是为了避开这个自死锁。
func (h *Hub) detach(c *Client) {
	h.mu.Lock()
	p := c.pairing
	wasHost := p != nil && p.host == c
	wasController := p != nil && !wasHost
	h.removeLocked(c)
	// 数的是摘掉之后剩下的（removeLocked 已经把它删了）。必须在锁内数完 ——
	// 出锁之后再读 p.controllers 就是 data race 了。
	// 注意 p 可能是 nil：detach 要幂等，第二次进来 c.pairing 已经是空的。
	var n int
	if wasController {
		n = len(p.controllers)
	}
	h.mu.Unlock()

	if wasHost {
		h.notifyPresence(p, false)
	}
	if wasController {
		// 手机走了电脑得知道，不然它会一直以为还有人在看。
		h.notifyWatchers(p, n)
	}
}

// ---------------------------------------------------------------- 转发

// toControllers 把电脑发来的消息转给这个配对里所有手机。
//
// 发送在读锁内完成，见 Hub 上的并发不变量。非阻塞，锁不会被慢客户端拖住。
//
// ponytail: 只发给此刻连着的人，不做补发。手机在流式输出中途断线再连回来，
// 会漏掉中间那几段 text。要补的话得在中继留环形缓冲、或者让电脑端按序号重放，
// 两个都是 M2 的事 —— M1 先把链路跑通。
func (h *Hub) toControllers(from *Client, msg []byte) {
	h.mu.RLock()
	var slow []*Client
	if p := from.pairing; p != nil {
		for c := range p.controllers {
			select {
			case c.send <- msg:
			default:
				slow = append(slow, c) // 缓冲写满 = 消费不过来，踢掉
			}
		}
	}
	h.mu.RUnlock()

	for _, c := range slow {
		h.remove(c) // 出锁再删，否则写锁会和上面的读锁互等
	}
}

// toHost 把手机发来的指令转给电脑。
func (h *Hub) toHost(from *Client, msg []byte) {
	h.mu.RLock()
	var slow *Client
	if p := from.pairing; p != nil && p.host != nil {
		select {
		case p.host.send <- msg:
		default:
			slow = p.host
		}
	}
	h.mu.RUnlock()

	if slow != nil {
		h.remove(slow)
	}
}

// notifyPresence 告诉这个配对里的所有手机：电脑上线了还是掉线了。
// 没有这条，手机只能对着空气打字。
func (h *Hub) notifyPresence(p *Pairing, online bool) {
	h.mu.RLock()
	var slow []*Client
	for c := range p.controllers {
		select {
		case c.send <- presenceMsg(online):
		default:
			slow = append(slow, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range slow {
		h.remove(c)
	}
}

// notifyWatchers 告诉电脑现在有几台手机在看。presence 的反方向。
//
// 用途只有一个，但很硬：agent 申请目录权限时要弹确认框，而**确认框在手机上**。
// 电脑不知道有没有人在看，就只能一直等一个不会来的回答，
// 或者干脆不问就放弃 —— 两个都是错的。
func (h *Hub) notifyWatchers(p *Pairing, n int) {
	h.mu.RLock()
	host := p.host
	if host != nil {
		select {
		case host.send <- watchersMsg(n):
		default: // 缓冲满了 —— 和别处一样，宁可丢这条也不能阻塞
		}
	}
	h.mu.RUnlock()
}

// ---------------------------------------------------------------- 回收

// 一台电脑离线多久之后，这个配对就没人要了。
const pairIdle = 10 * time.Minute

func (h *Hub) reapLoop(idle time.Duration) {
	if idle <= 0 {
		log.Print("配对回收已关闭（idle <= 0）")
		return
	}
	// 检查间隔要比 idle 密，否则最坏要等 2×idle 才收得掉一个
	t := time.NewTicker(idle / 4)
	defer t.Stop()
	for range t.C {
		h.reap(idle)
	}
}

// reap 收掉「电脑长期离线、又没人在看」的配对。
//
// 这张表只增不减的话，任何人拿随机码连过来说自己是 host，就能往里灌一条。
// 限流把灌入速度压住了，回收器负责给出上界 —— 两个一起才关得住。
func (h *Hub) reap(idle time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for code, p := range h.pairings {
		// 电脑还在、或者还有手机守着，就不算闲置。手机进进出出是常态，
		// 不该因为谁关了页面就把配对收掉 —— 那样电脑一回来大家都得重配。
		if p.host != nil || len(p.controllers) > 0 || time.Since(p.lastSeen) <= idle {
			continue
		}
		delete(h.pairings, code)
		log.Printf("配对 %s 已回收（电脑离线超过 %s）", code, idle)
	}
}
