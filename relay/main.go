// goagent-relay —— 手机和电脑之间的中转站。
//
// 它解决的问题只有一个：**电脑在家里/公司网络后面，手机在外面，怎么找到对方。**
//
// 答案是不用找到对方：电脑主动连出来（出站连接不受 NAT 阻挡），手机也连进来，
// 两个人都挂在同一个配对码下面，由中继转发。买公网服务器的全部意义就在这儿。
//
// 中继不认识 prompt、text、file 这些业务消息 —— 它只看「这条是谁发的」，
// 然后转给对面。这条纪律的意义是：以后加新功能只改两端，不用碰 Go。
package main

import (
	"flag"
	"log"
	"net/http"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	idle := flag.Duration("pair-idle", pairIdle, "电脑离线多久后回收配对（0 表示不回收）")
	flag.Parse()

	hub := NewHub()
	lim := newLimiter()
	go hub.reapLoop(*idle)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(hub, lim, w, r)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	// ponytail: /upload 和 /f/<token> 是 M2 的事 —— 文件走 HTTP 不走 WebSocket。

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("goagent-relay 监听 %s", *addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
