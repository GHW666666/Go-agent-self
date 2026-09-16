package main

// 这个文件只干一件事：把 hub.go 里那条并发不变量交给工具去验，
// 而不是靠注释自证。
//
//	go -C relay test -race -count=5 .
//
// 不用接真的 websocket.Conn —— hub 这一层只碰 send / pairing / closed，
// readPump / writePump 压根起不来，测的就是纯抽象层。
//
// 就算 -race 用不了（Windows 上要 gcc），这个文件也还是有效的：
// 不变量一旦破掉，表现是 "send on closed channel" 的 panic，不需要竞态检测器。

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestClient 造一个没有 conn 的连接。writePump 不会跑，
// 所以 send 里的东西得由测试自己收。
func newTestClient(h *Hub, role string) *Client {
	return &Client{hub: h, send: make(chan []byte, sendBuffer), role: role}
}

// isClosed / lookup 读的都是受 hub.mu 保护的字段，
// 不加锁的话测试自己就成了 data race。
func isClosed(h *Hub, c *Client) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return c.closed
}

func lookup(h *Hub, code string) *Pairing {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.pairings[code]
}

// TestSendWhileClosing 是这套代码的核心测试。
//
// 四个 goroutine 从电脑端不停广播，四个不停让手机连上又断开 ——
// 「往 send 里发」和「close(send)」这两件事被逼到真正重叠。
// 不变量成立的话这里什么都不会发生；破掉的话要么 panic，
// 要么 -race 把重叠的那对操作指名道姓地打出来。
func TestSendWhileClosing(t *testing.T) {
	h := NewHub()
	host := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(host, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	const nPhone = 8
	phones := make([]*Client, nPhone)
	for i := range phones {
		phones[i] = newTestClient(h, rolePhone)
		if _, err := h.attachController(phones[i], "TEST99"); err != nil {
			t.Fatalf("attachController: %v", err)
		}
	}

	// 这台一直挂着、但没人收消息。缓冲写满之后 toControllers 会走 default
	// 分支把它踢掉 —— 「慢客户端」那条路径也得压进竞态里。
	slow := newTestClient(h, rolePhone)
	if _, err := h.attachController(slow, "TEST99"); err != nil {
		t.Fatalf("attachController: %v", err)
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup

	for _, c := range phones {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-c.send:
				case <-stop:
					return
				}
			}
		}()
	}

	// 电脑广播
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				h.toControllers(host, []byte(`{"type":"text","delta":"x"}`))
			}
		}()
	}

	// 手机连上就走，中间不隔任何东西 —— 逼 attach 和 detach 重叠
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				c := newTestClient(h, rolePhone)
				if _, err := h.attachController(c, "TEST99"); err == nil {
					h.detach(c)
				}
			}
		}()
	}

	time.Sleep(300 * time.Millisecond)
	close(stop)
	wg.Wait()

	for _, c := range phones {
		h.detach(c)
	}
	h.detach(slow)
	h.detach(host)
}

// TestHostReconnectDuringTraffic 压的是 attachHost 里那条
// 「先出锁、再 remove 旧连接」的路。
//
// 两个广播者共用一个「当前电脑」的指针，另一个 goroutine 不停换新电脑。
// 换的时候旧连接被 close，而广播者可能正好在往它 send ——
// 这正是最该出事的地方。
func TestHostReconnectDuringTraffic(t *testing.T) {
	h := NewHub()
	first := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(first, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	phone := newTestClient(h, rolePhone)
	if _, err := h.attachController(phone, "TEST99"); err != nil {
		t.Fatalf("attachController: %v", err)
	}

	var mu sync.Mutex
	cur := first
	getCur := func() *Client { mu.Lock(); defer mu.Unlock(); return cur }
	setCur := func(c *Client) { mu.Lock(); cur = c; mu.Unlock() }

	stop := make(chan struct{})
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-phone.send:
			case <-stop:
				return
			}
		}
	}()

	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				h.toControllers(getCur(), []byte("x"))
			}
		}()
	}

	// 网络抖动的样子：新连接带对 token 接进来，attachHost 顺手顶掉上一条
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			nc := newTestClient(h, roleHost)
			if _, _, err := h.attachHost(nc, "TEST99", "tok"); err != nil {
				t.Errorf("attachHost: %v", err)
				return
			}
			setCur(nc)
		}
	}()

	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
}

// TestWrongTokenDoesNotEvict —— 配对码不是秘密（要从屏幕上念出来），
// 所以光凭码不能顶掉真电脑。这条要是破了，就是别人一句话把你踢下线。
func TestWrongTokenDoesNotEvict(t *testing.T) {
	h := NewHub()
	real := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(real, "TEST99", "right"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	attacker := newTestClient(h, roleHost)
	_, _, err := h.attachHost(attacker, "TEST99", "wrong")
	if err == nil {
		t.Fatal("token 不对却让它接进来了")
	}

	if p := lookup(h, "TEST99"); p.host != real {
		t.Fatal("真电脑被顶掉了")
	}
	if isClosed(h, real) {
		t.Fatal("真电脑的连接被关了")
	}
}

// TestDetachIdempotent —— 三条路径都会调 removeLocked（readPump 结束、
// 慢客户端被踢、电脑被顶掉），双重 close(send) 直接 panic。
func TestDetachIdempotent(t *testing.T) {
	h := NewHub()
	host := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(host, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}
	phone := newTestClient(h, rolePhone)
	if _, err := h.attachController(phone, "TEST99"); err != nil {
		t.Fatalf("attachController: %v", err)
	}

	h.detach(phone)
	h.detach(phone)
	h.detach(phone)
	h.detach(host)
	h.detach(host)

	// 顺手验一下摘干净了：手机走了，电脑也走了，这张表该是空的
	if p := lookup(h, "TEST99"); p.host != nil || len(p.controllers) != 0 {
		t.Fatalf("没摘干净：host=%v controllers=%d", p.host, len(p.controllers))
	}
}

// TestSlowClientEvicted —— 发送必须非阻塞，缓冲写满就把人踢掉。
// 不做这件事的话，一个不收消息的手机能把整个 Hub 卡死。
func TestSlowClientEvicted(t *testing.T) {
	h := NewHub()
	host := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(host, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	slow := newTestClient(h, rolePhone)
	if _, err := h.attachController(slow, "TEST99"); err != nil {
		t.Fatalf("attachController: %v", err)
	}

	// 刚好塞满缓冲
	for i := 0; i < sendBuffer; i++ {
		h.toControllers(host, []byte("x"))
	}
	if isClosed(h, slow) {
		t.Fatal("缓冲刚满就被踢了，太早")
	}

	h.toControllers(host, []byte("x")) // 这一条走 default 分支
	if !isClosed(h, slow) {
		t.Fatal("缓冲溢出却没被踢掉 —— 慢客户端会把 Hub 拖住")
	}
}

// TestEvictTellsTheOldHost —— 顶掉旧连接时必须告诉它原因。
//
// 不说的话对面会把「被顶掉」当成网络抖动，转头就重连，两个进程开始
// 每秒互相顶替 —— 谁也连不上，而日志里只看得到一行行「电脑已接入」。
func TestEvictTellsTheOldHost(t *testing.T) {
	h := NewHub()
	old := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(old, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	newer := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(newer, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}

	// 读到底：range 到 channel 关闭才结束，所以这一趟同时证明了两件事 ——
	// 通知塞进去了，而且塞完之后才 close（writePump 的收尾顺序）。
	//
	// 不能假设「第一条就是 evicted」：旧连接自己 attach 的时候也收过
	// 一条 watchers，它还在缓冲里排队。
	var got []string
	for msg := range old.send {
		got = append(got, string(msg))
	}
	for _, m := range got {
		if strings.Contains(m, "evicted") {
			return
		}
	}
	t.Fatalf("旧连接没收到 evicted —— 它会当成网络抖动然后重连。只收到：%v", got)
}

// TestWatchersToldToHost —— 电脑必须知道有没有人在看。
//
// 这条不是锦上添花：agent 申请目录权限时，确认框在手机上。电脑不知道有没有人
// 在看，就只能一直等一个不会来的回答，或者干脆不问就放弃 —— 两个都是错的。
func TestWatchersToldToHost(t *testing.T) {
	h := NewHub()
	host := newTestClient(h, roleHost)
	if _, _, err := h.attachHost(host, "TEST99", "tok"); err != nil {
		t.Fatalf("attachHost: %v", err)
	}
	// 电脑是后到的，得先知道自己接进来时有没有人在
	assertWatchers(t, host, 0)

	phone := newTestClient(h, rolePhone)
	if _, err := h.attachController(phone, "TEST99"); err != nil {
		t.Fatalf("attachController: %v", err)
	}
	assertWatchers(t, host, 1)

	h.detach(phone)
	assertWatchers(t, host, 0)
}

// assertWatchers 从电脑的缓冲里取一条，断言它是 watchers 且数字对。
func assertWatchers(t *testing.T, host *Client, want int) {
	t.Helper()
	select {
	case msg := <-host.send:
		var ev struct {
			Type  string `json:"type"`
			Count int    `json:"count"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Type != TypeWatchers {
			t.Fatalf("要 %s，拿到 %s", TypeWatchers, msg)
		}
		if ev.Count != want {
			t.Fatalf("在看的人数该是 %d，拿到 %d", want, ev.Count)
		}
	default:
		t.Fatal("电脑没收到 watchers —— 它不知道有没有人在看")
	}
}

// TestAttachControllerUnknownCode —— 码不存在要给带 code 的错误，
// 手机端靠它决定退回配对界面（不能去匹配中文）。
func TestAttachControllerUnknownCode(t *testing.T) {
	h := NewHub()
	c := newTestClient(h, rolePhone)
	_, err := h.attachController(c, "ZZZZ99")

	pe, ok := err.(*pairError)
	if !ok || pe.code != "no_pairing" {
		t.Fatalf("要 no_pairing，拿到 %v", err)
	}
}
