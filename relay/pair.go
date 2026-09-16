package main

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// 配对码由**电脑端**生成并存在它自己机器上（见 host/src/config.mjs），
// 中继只做校验 —— 这样中继重启、换机器、多实例部署都不影响已经配好的手机。
//
// 字母表去掉了 0/O/1/I/L：这串码要人从电脑屏幕上念到手机里敲，认错的代价
// 比多几位大得多。
var codeRe = regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4,12}$`)

func normalizeCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

// ---------------------------------------------------------------- 限流

const (
	// 6 位码 ≈ 8.8 亿种，但脚本一秒能试几千个。连续错这么多次就关小黑屋。
	failLimit = 10
	lockout   = 15 * time.Minute
)

type failRecord struct {
	count int
	until time.Time // 零值表示还没被锁
}

// limiter 按来源 IP 记配对失败次数。
//
// ⚠️ TODO（上 VPS 之前要做）：它只管「猜错」，不管「拿对了密码猛连」。
// ok() 是把记录整个删掉，所以认证一过就完全免罚 —— 一个知道配对码的客户端
// 可以每秒连一次，没人拦。想清楚这里的错在哪：**认证（你是谁）和配额
// （你能占多少资源）被混成了一件事**。认证通过不该等于免于限流。
//
// 正解是三条，按性价比排：
//  1. 每个 IP 一个令牌桶（golang.org/x/time/rate），成功失败**都扣**，
//     比如 5 次/分钟。认证结果只决定「能不能进」，不决定「扣不扣」。
//  2. 全局并发连接数上限 —— 一万个 IP 各自都合法，照样能把进程压死。
//  3. 全局建连速率上限，挡住瞬间洪水。
//
// ponytail: 存在内存里，重启就清空；多实例部署各算各的。
// 另外 fails 这个 map 自己也是个洞：每个失败过的 IP 留一条，只有那个 IP
// 再回来时才清，没有任何回收器 —— 撒 IP 打过来它只涨不掉。
// 真被人盯着打的时候换 Redis，顺手把上面三条一起做。
type limiter struct {
	mu    sync.Mutex
	fails map[string]*failRecord
}

func newLimiter() *limiter {
	return &limiter{fails: make(map[string]*failRecord)}
}

// allow 判断这个 IP 现在还能不能试。
func (l *limiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	r := l.fails[ip]
	if r == nil || r.until.IsZero() {
		return true
	}
	if time.Now().After(r.until) {
		delete(l.fails, ip) // 禁闭结束，重新给机会
		return true
	}
	return false
}

// fail 记一次失败。够数了就上锁。
func (l *limiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	r := l.fails[ip]
	if r == nil {
		r = &failRecord{}
		l.fails[ip] = r
	}
	r.count++
	if r.count >= failLimit {
		r.count = 0
		r.until = time.Now().Add(lockout)
	}
}

// ok 配对成功，把这个 IP 的失败记录一笔勾销。
func (l *limiter) ok(ip string) {
	l.mu.Lock()
	delete(l.fails, ip)
	l.mu.Unlock()
}
