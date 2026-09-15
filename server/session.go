package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// Sessions 管着所有会话。一个会话 = 一个独立的 agent 子进程 + 一条可取消的生命周期。
//
// 并发约定：mu 保护 table 这张表。
type Sessions struct {
	mu       sync.RWMutex
	table    map[string]*Session
	agentDir string
	hub      *Hub

	// ctx 是所有会话的祖先。cancel 一次，全部会话连同回收 goroutine 一起停。
	// context.CancelFunc 可重复调用，所以 CloseAll 多调几次也不会炸。
	ctx    context.Context
	cancel context.CancelFunc
}

// NewSessions 建会话表并启动回收器。idle 是「没人连多久算废弃」，<= 0 表示不回收。
func NewSessions(agentDir string, hub *Hub, idle time.Duration) *Sessions {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Sessions{
		table:    make(map[string]*Session),
		agentDir: agentDir,
		hub:      hub,
		ctx:      ctx,
		cancel:   cancel,
	}
	go s.reapLoop(idle)
	return s
}

// Session 是一个会话。
type Session struct {
	ID     string
	agent  *Agent
	parent *Sessions

	// ctx 是这个会话的根 context。cancel 一调，挂在它下面的东西一起停 ——
	// 这是唯一能保证「会话结束时不漏东西」的方式。
	ctx    context.Context
	cancel context.CancelFunc

	// clients 是当前连着这个会话的客户端数。> 0 的会话绝不会被回收。
	clients int
	// lastSeen 是最后一个客户端断开的时间（还有客户端连着时它无意义）。
	// 回收器从这里开始算闲置时长。
	lastSeen time.Time
}

// Get 按 id 取会话。ok=false 表示这个会话已经不在了（agent 崩了之类）。
func (s *Sessions) Get(id string) (*Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.table[id]
	return sess, ok
}

// GetOrCreate 取会话：id 为空就新建；id 存在就复用；id 指定了但不存在，
// 就用这个 id 新建 —— 这样分享出去的链接永远连得上。
func (s *Sessions) GetOrCreate(id string) (*Session, error) {
	if id != "" {
		if sess, ok := s.Get(id); ok {
			return sess, nil
		}
	}
	return s.create(id)
}

// create 建会话。整个过程占着全局写锁，因为 agent 必须在登记进表之前就绪 ——
// 否则进程秒退时 onExit 找不到这条记录，会留下一个指向死进程的会话。
//
// ponytail: 建会话期间占着全局写锁（起进程约几十毫秒）。会话量级上来之后，
// 改成先占位登记、再异步补齐 agent，并在 Session 里加 ready 信号。
func (s *Sessions) create(id string) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if id == "" {
		id = newSessionID()
	}
	if _, exists := s.table[id]; exists {
		return nil, fmt.Errorf("会话 %s 正在创建中", id)
	}

	// 挂在 Sessions 的 ctx 下面，CloseAll 一 cancel 就能一锅端
	ctx, cancel := context.WithCancel(s.ctx)

	agent, err := StartAgent(
		s.agentDir,
		// agent 的每一行输出，广播给这个会话里的所有客户端
		func(line []byte) { s.hub.broadcast(id, line) },
		// 子进程死了 —— 会话跟着结束，不能留一个指向死进程的记录
		func() { s.drop(id, "agent 子进程已退出") },
	)
	if err != nil {
		cancel()
		return nil, err
	}

	sess := &Session{
		ID: id, agent: agent, parent: s,
		ctx: ctx, cancel: cancel,
		lastSeen: time.Now(),
	}
	s.table[id] = sess

	log.Printf("会话 %s 已创建", id)
	return sess, nil
}

// dropLocked 把会话从表里摘掉并返回它。调用方必须已经持有写锁。
// 返回 nil 表示这个 id 本来就不在表里。
func (s *Sessions) dropLocked(id string) *Session {
	sess, ok := s.table[id]
	if !ok {
		return nil
	}
	delete(s.table, id)
	return sess
}

// teardown 是摘除之后的收尾：停掉会话、收掉子进程、通知还在看着的人。
// 单拎出来是因为「摘表」必须在锁里、「收尾」不能占着锁（要写广播）。
func (s *Sessions) teardown(sess *Session, reason string) {
	sess.cancel() // 让挂在它下面的工作全部停下

	// 必须显式关掉子进程。少了这句，会话从表里消失了，node 却还在后台跑 ——
	// 表上看不见、ps 里看得见的那种泄漏，最难查。
	//
	// 用 goroutine 是因为 Close 会阻塞到进程真正退出，而 teardown 会被回收器
	// 在循环里调用：万一哪个子进程卡住不退，同步等会把回收器整个卡死，
	// 之后所有会话都收不掉了。宁可漏一个 goroutine，不能停摆。
	go sess.agent.Close()

	// 顺序要紧：先把原因广播出去，再断开。c.send 是带缓冲的 channel，
	// 关闭后 writePump 仍然会把缓冲里的消息写完才退出，所以这句跑不掉。
	s.hub.broadcast(sess.ID, errorEvent(reason))
	s.hub.dropSession(sess.ID)

	log.Printf("会话 %s 已移除：%s", sess.ID, reason)
}

// drop 摘掉一个会话。agent 自己死了、或者进程退出时，都走这里。
// 幂等：重复调用只生效一次。
func (s *Sessions) drop(id string, reason string) {
	s.mu.Lock()
	sess := s.dropLocked(id)
	s.mu.Unlock()

	if sess != nil {
		s.teardown(sess, reason)
	}
}

// AddClient 记一笔「有人连上来了」。有客户端连着的会话不会被回收。
func (s *Sessions) AddClient(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.table[id]; ok {
		sess.clients++
	}
}

// RemoveClient 记一笔「有人走了」。归零时打上时间戳，回收器从这里开始算闲置。
func (s *Sessions) RemoveClient(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.table[id]; ok {
		sess.clients--
		if sess.clients <= 0 {
			sess.clients = 0
			sess.lastSeen = time.Now()
		}
	}
}

// reapLoop 定期清掉长时间没人连的会话。
//
// 少了它，每开一次页面、每刷新一次，都会永久留下一个 node 子进程 ——
// 因为会话是连着才建的，断开却没人回收。一晚上下来就是几十个进程几百兆内存。
func (s *Sessions) reapLoop(idle time.Duration) {
	if idle <= 0 {
		log.Print("会话回收已关闭（idle <= 0）")
		return
	}
	// 检查得比 idle 密，否则最坏情况要等 2*idle 才收得掉
	t := time.NewTicker(idle / 4)
	defer t.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			s.reap(idle)
		}
	}
}

// reap 收掉所有「没人连着且闲置超过 idle」的会话。
func (s *Sessions) reap(idle time.Duration) {
	s.mu.Lock()
	var gone []*Session
	// 边 range 边 delete 是 Go 明确允许的
	for id, sess := range s.table {
		if sess.clients > 0 || time.Since(sess.lastSeen) <= idle {
			continue
		}
		if sess := s.dropLocked(id); sess != nil {
			gone = append(gone, sess)
		}
	}
	s.mu.Unlock()

	// 检查和摘除在同一把锁里做完，中间不会有客户端刚连上就被误杀
	for _, sess := range gone {
		s.teardown(sess, "会话闲置过久，已回收")
	}
}

// Handle 处理一条来自客户端的消息：先回声给同会话的所有端
// （这样每个窗口都看得到是谁在问、是谁点了停止），再交给 agent。
//
// Go 刻意不解析消息内容 —— 连「取消」也只是顺着同一条路走到 node，
// 由那边调 agent.abort()。协议只有一份，将来加消息类型不用动 Go。
func (s *Sessions) Handle(id string, msg []byte) {
	sess, ok := s.Get(id)
	if !ok {
		// 会话已经不在了（agent 崩了之类）。不偷偷重开一个 ——
		// 那会让用户以为对话还在，其实历史已经没了。
		s.hub.broadcast(id, errorEvent("会话已结束，请重新连接"))
		return
	}
	sess.Handle(msg)
}

func (sess *Session) Handle(msg []byte) {
	sess.parent.hub.broadcast(sess.ID, msg)

	if err := sess.agent.Send(msg); err != nil {
		log.Printf("会话 %s 转发失败: %v", sess.ID, err)
	}
}

// CloseAll 收掉所有会话和它们的子进程。进程退出前必须调用 ——
// 否则 node 会变成没人管的孤儿进程。
func (s *Sessions) CloseAll() {
	// 先停回收 goroutine，并顺带 cancel 掉所有会话的 ctx（它们都挂在 s.ctx 下面）
	s.cancel()

	s.mu.Lock()
	all := make([]*Session, 0, len(s.table))
	for _, sess := range s.table {
		all = append(all, sess)
	}
	s.table = make(map[string]*Session)
	s.mu.Unlock()

	for _, sess := range all {
		sess.cancel()
		sess.agent.Close()
	}
	if len(all) > 0 {
		log.Printf("已收掉 %d 个会话", len(all))
	}
}

func newSessionID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "default"
	}
	return hex.EncodeToString(b[:])
}

func errorEvent(message string) []byte {
	msg, _ := json.Marshal(map[string]string{"type": "error", "message": message})
	return msg
}

// sessionEvent 告诉客户端它落在哪个会话里。
// 客户端拿到之后要放进 URL / 显示出来，才能分享给别人一起看。
func sessionEvent(id string) []byte {
	msg, _ := json.Marshal(map[string]string{"type": "session", "id": id})
	return msg
}
