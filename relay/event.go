package main

import "encoding/json"

// 中继自己会发出的两种消息。
//
// 除了这两种，中继一个字节都不解析 —— 电脑和手机之间传什么它一概不看，
// 只按「谁发的」决定转给谁。这条纪律是从 v1 带过来的：一旦中继开始理解
// 业务消息，加一个新功能就要改 Go，而这个项目里最不该频繁改的就是它。
//
// 用 relay: 前缀把它们和业务消息隔开，业务侧不可能撞名。
const (
	TypePresence = "relay:presence" // 电脑上线/掉线了（只发给手机）
	TypeWatchers = "relay:watchers" // 有几台手机在看（只发给电脑）
	TypeError    = "relay:error"    // 配对码不对、被限流之类，中继发起的
)

type presenceEvent struct {
	Type   string `json:"type"`
	Online bool   `json:"online"`
}

// watchersEvent 是 presence 的反方向。两个方向都需要，但用途不同：
// 手机要知道电脑在不在（不然只能对着空气打字）；电脑要知道**有没有人在看**——
// agent 申请目录权限时得靠它决定等不等，没人在看手机，等就是白等。
type watchersEvent struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type errorEvent struct {
	Type string `json:"type"`
	// Code 是给代码判断的，message 是给人看的。
	// 分两个字段是因为客户端要靠它决定**怎么办**：「配对码不存在」得让手机
	// 退回输入界面，而前端去匹配一句中文是做不到这件事的。
	Code    string `json:"code"`
	Message string `json:"message"`
}

func presenceMsg(online bool) []byte {
	b, _ := json.Marshal(presenceEvent{Type: TypePresence, Online: online})
	return b
}

func watchersMsg(n int) []byte {
	b, _ := json.Marshal(watchersEvent{Type: TypeWatchers, Count: n})
	return b
}

func errorMsg(code, msg string) []byte {
	b, _ := json.Marshal(errorEvent{Type: TypeError, Code: code, Message: msg})
	return b
}
