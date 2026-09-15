// goagent daemon：对外提供静态文件服务 + 一条 WebSocket 广播通道。
package main

import (
	"flag"
	"log"
	"net/http"
	"path"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	webDir := flag.String("web", "../packages/web/dist", "前端静态文件目录")
	agentDir := flag.String("agent", "../packages/agent", "pi agent 子进程所在目录")
	sessionIdle := flag.Duration("session-idle", 15*time.Minute,
		"会话闲置多久后回收（0 表示不回收）")
	flag.Parse()

	hub := NewHub()

	// 每个会话一个 agent 子进程，agent 的输出只广播给该会话的客户端。
	// 连接进来时才建会话（懒加载）—— 没人用就不该起进程。
	sessions := NewSessions(*agentDir, hub, *sessionIdle)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(sessions, hub, w, r)
	})
	mux.Handle("/", spa(*webDir))

	log.Printf("goagent 已启动：http://localhost%s", *addr)

	// 不用 log.Fatal 在这里 —— 它走 os.Exit，会跳过所有 defer，
	// agent 子进程就成了没人收的孤儿。先手动收尾再退。
	err := http.ListenAndServe(*addr, mux)
	sessions.CloseAll()
	log.Fatal(err)
}

// spa 提供静态文件；找不到的路径回退到 index.html，把路由交给前端处理。
func spa(dir string) http.Handler {
	root := http.Dir(dir)
	fs := http.FileServer(root)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// http.Dir.Open 会拒绝 ../ 穿越，借它判断文件是不是真的存在。
		// 注意 r.URL.Path 必须拼上 "/" 前缀，否则 ".." 会跑到 dir 外面去。
		if f, err := root.Open(path.Clean("/" + r.URL.Path)); err == nil {
			f.Close()
		} else {
			// r 是复用的，改了 Path 会影响别的 handler，先 Clone 一份
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fs.ServeHTTP(w, r)
	})
}
