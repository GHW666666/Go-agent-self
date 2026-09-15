package main

import "sync"

// Hub 持有所有活跃连接，并负责把消息广播给它们。
//
// 并发约定：mu 保护 clients。
// broadcast 持读锁、remove 持写锁，两者天然互斥 —— 所以广播过程中
// 不会有人正在 close 某个 channel，也就不会出现「向已关闭 channel 发送」的 panic。
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*Client]struct{})}
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

// remove 是幂等的：重复调用不会重复 close(c.send)。
// readPump 和 broadcast 都可能触发它，所以这个判断是必须的。
func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send) // writePump 靠这个信号退出
	}
	h.mu.Unlock()
}

// dropSession 踢掉某个会话里的所有连接。会话结束时必须调 ——
// 否则连接会挂在一条已经死掉的会话上，之后每发一条消息都只收到
// 「会话已结束」，而客户端无从知道该重连，就这么卡住了。
//
// 断线本身就是最好的信号：客户端会走它本来就有的重连逻辑，用同一个
// ?session= 重新加入，GetOrCreate 发现它不在了就新建一个 ——
// 会话和连接重新对齐，不用为此加任何新协议。
func (h *Hub) dropSession(session string) {
	h.mu.RLock()
	var gone []*Client
	for c := range h.clients {
		if c.session == session {
			gone = append(gone, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range gone {
		h.remove(c)
	}
}

// broadcast 把同一条消息发给**指定会话里**的所有客户端。
//
// 发送缓冲写满的（对端卡住或消费不过来）直接踢掉：
// 不能让一个慢客户端把整个广播卡住。
//
// c.session 在 add 之前就设好、之后不再改，所以这里读它是安全的。
func (h *Hub) broadcast(session string, msg []byte) {
	h.mu.RLock()
	var slow []*Client
	for c := range h.clients {
		if c.session != session {
			continue
		}
		select {
		case c.send <- msg:
		default:
			slow = append(slow, c)
		}
	}
	h.mu.RUnlock()

	// 出了读锁再删，否则 remove 要写锁会和上面的 RLock 互相等待
	for _, c := range slow {
		h.remove(c)
	}
}
