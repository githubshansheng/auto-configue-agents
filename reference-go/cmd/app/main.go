// TriConfig —— 三合一 AI 工具配置器（Codex CLI / Codex Desktop / WorkBuddy）。
// 双击即用：启动本地回环服务并打开 GUI 窗口；带 --no-browser 时仅启动服务。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"triconfig/internal/platform"
	"triconfig/internal/server"
)

const version = "0.1.0"

type session struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func main() {
	port := flag.Int("port", 0, "指定端口（默认随机）")
	noBrowser := flag.Bool("no-browser", false, "不自动打开窗口")
	showVer := flag.Bool("version", false, "打印版本")
	flag.Parse()
	if *showVer {
		fmt.Println("TriConfig " + version)
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		fatal(err)
	}
	base := filepath.Join(home, ".triconfig")
	if err := os.MkdirAll(base, 0o700); err != nil {
		fatal(err)
	}
	sessionPath := filepath.Join(base, "session.json")

	// 单实例：已有存活实例则唤起其窗口后退出
	if s, err := readSession(sessionPath); err == nil && alive(s.Port) {
		platform.OpenWindow(s.Port, s.Token)
		fmt.Println("TriConfig 已在运行，已唤起窗口")
		return
	}

	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		fatal(err)
	}
	portNum := ln.Addr().(*net.TCPAddr).Port
	token := randToken()
	if err := writeSession(sessionPath, session{Port: portNum, Token: token}); err != nil {
		fatal(err)
	}

	srv := &server.Server{Token: token, Home: home}
	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = httpSrv.Serve(ln)
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", portNum, token)
	fmt.Println("TriConfig 已启动：", url)
	if !*noBrowser {
		platform.OpenWindow(portNum, token)
	}

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	_ = os.Remove(sessionPath)
	_ = httpSrv.Close()
}

func readSession(p string) (session, error) {
	var s session
	data, err := os.ReadFile(p)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

func writeSession(p string, s session) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

func alive(port int) bool {
	if port <= 0 {
		return false
	}
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func randToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		fatal(err)
	}
	return hex.EncodeToString(b)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "TriConfig 启动失败：", err)
	os.Exit(1)
}
