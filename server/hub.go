package main

import (
	"log"
	"sync"
)

// Hub 持有所有活跃连接，并负责把消息广播给它们。
//
// 并发约定：mu 保护 clients。
// broadcast 持读锁、remove 持写锁，两者天然互斥 —— 所以广播过程中
// 不会有人正在 close 某个 channel，也就不会出现「向已关闭 channel 发送」的 panic。
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}

	// agent 是跑 pi 的子进程，可能为 nil —— 启动失败时整个 daemon
	// 退化成纯广播，W1 的能力原样还在。
	agent *Agent
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

// broadcast 把同一条消息发给所有客户端，包括发送者自己。
//
// 发送缓冲写满的（对端卡住或消费不过来）直接踢掉：
// 不能让一个慢客户端把整个广播卡住。
func (h *Hub) broadcast(msg []byte) {
	h.mu.RLock()
	var slow []*Client
	for c := range h.clients {
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

// forward 处理一条来自客户端的消息：先广播给所有人（这样每个窗口都看得到
// 是谁发的内容），再交给 agent 去处理。
func (h *Hub) forward(msg []byte) {
	h.broadcast(msg)

	if h.agent == nil {
		return
	}
	if err := h.agent.Send(msg); err != nil {
		log.Printf("转发给 agent 失败: %v", err)
	}
}
