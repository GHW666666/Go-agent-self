package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
)

// maxEventSize 单条事件的读取上限。
// bufio.Scanner 默认只给 64KB，而工具读一个大文件返回的内容很容易超过它。
const maxEventSize = 4 << 20 // 4 MiB

// Agent 是一个跑着 pi SDK 的 node 子进程。
//
// 通信走 stdio，一行一条 JSON —— 跟 LSP 一个路子：
//   - 我们往它的 stdin 写 {"type":"prompt",...}
//   - 它往 stdout 吐 {"type":"text","delta":"..."} 之类的事件
//
// 不开端口、不占资源，而且子进程一死管道就断 —— 生命周期天然绑在一起，
// 不需要额外的心跳去发现「agent 挂了」。
type Agent struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex // 保护 stdin：多个客户端可能同时发 prompt
	onEvent func([]byte)
}

// StartAgent 拉起 agent 子进程，dir 是 packages/agent 的路径。
// onEvent 对每一行 stdout 调用一次，来自 readLoop 那条独立 goroutine，
// 所以它必须自己保证并发安全。
func StartAgent(dir string, onEvent func([]byte)) (*Agent, error) {
	// --env-file-if-exists：没有 .env 也不报错（比如 CI 上靠真实环境变量）
	cmd := exec.Command("node", "--env-file-if-exists=../../.env", "src/host.mjs")
	cmd.Dir = dir
	// node 那边的日志直接透到我们的终端，不掺进协议里
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 node 失败: %w", err)
	}

	a := &Agent{cmd: cmd, stdin: stdin, onEvent: onEvent}
	go a.readLoop(stdout)
	return a, nil
}

// Send 把一条消息写给 agent，末尾补换行，构成「一行一条」的帧。
func (a *Agent) Send(line []byte) error {
	// 别写 append(line, '\n')：line 若有余量会被就地改写，污染调用方的切片
	frame := make([]byte, len(line)+1)
	copy(frame, line)
	frame[len(line)] = '\n'

	a.mu.Lock()
	defer a.mu.Unlock()
	_, err := a.stdin.Write(frame)
	return err
}

// Close 关掉 stdin 让子进程自行退出，再等它真的结束。
// 关 stdin 就够了 —— host.mjs 收到 stdin close 会自己 process.exit。
func (a *Agent) Close() error {
	a.stdin.Close()
	return a.cmd.Wait()
}

// readLoop 逐行读 agent 的输出。这是唯一读取 stdout 的地方。
func (a *Agent) readLoop(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), maxEventSize)

	for scanner.Scan() {
		// ⚠️ scanner.Bytes() 复用同一块底层数组，下一次 Scan 就会覆盖它。
		// 必须复制一份再交出去，否则广播出去的会是被踩烂的数据。
		line := make([]byte, len(scanner.Bytes()))
		copy(line, scanner.Bytes())
		a.onEvent(line)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("读 agent 输出出错: %v", err)
	}
	log.Print("agent 子进程已退出")
}
