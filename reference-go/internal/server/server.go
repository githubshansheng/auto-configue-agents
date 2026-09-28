// Package server 本地回环 HTTP 服务：REST + SSE + 内嵌前端。
// 安全模型：仅绑定 127.0.0.1 + 随机端口 + 启动令牌（/api/* 必须）+ Origin 回环校验。
package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"strings"

	"triconfig/internal/backup"
	"triconfig/internal/configurators"
	"triconfig/internal/configurators/contract"
	"triconfig/internal/oneclick"
)

//go:embed all:webdist
var webFS embed.FS

// Server 本地服务。
type Server struct {
	Token string // 启动令牌
	Home  string // 用户主目录
}

// Handler 组装全部路由与中间件。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/targets", s.handleTargets)
	mux.HandleFunc("/api/oneclick", s.handleOneClick)
	mux.HandleFunc("/api/rollback", s.handleRollback)

	sub, _ := fs.Sub(webFS, "webdist")
	fileServer := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(sub, p); err != nil {
			// SPA 回退：未知路径一律回 index.html
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			loopback := err == nil && (u.Host == "127.0.0.1" || u.Host == "localhost" ||
				strings.HasPrefix(u.Host, "127.0.0.1:") || strings.HasPrefix(u.Host, "localhost:"))
			if !loopback {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			tok := r.Header.Get("X-Triconfig-Token")
			if tok == "" {
				tok = r.URL.Query().Get("t")
			}
			if tok != s.Token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"ok": true, "name": "TriConfig"})
}

func (s *Server) handleTargets(w http.ResponseWriter, _ *http.Request) {
	var list []contract.DetectResult
	for _, t := range configurators.All() {
		list = append(list, t.Detect())
	}
	writeJSON(w, map[string]any{"targets": list})
}

// handleOneClick SSE 流式执行一键配置管线。
func (s *Server) handleOneClick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req oneclick.Request
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil && len(body) > 0 {
		_ = json.Unmarshal(body, &req)
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	evCh := make(chan oneclick.Event, 32)
	done := make(chan struct{})
	go func() {
		defer close(evCh)
		oneclick.Run(r.Context(), s.Home, req, func(e oneclick.Event) {
			evCh <- e
		})
		close(done)
	}()
	for ev := range evCh {
		b, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}
	<-done
}

func (s *Server) handleRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Target string `json:"target"`
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if len(body) > 0 {
		_ = json.Unmarshal(body, &req)
	}
	var results []map[string]any
	okAll := true
	for _, t := range configurators.All() {
		if req.Target != "all" && req.Target != t.ID() {
			continue
		}
		restored, err := backup.RollbackLatest(s.Home, t.ID())
		ok := err == nil
		if !ok {
			okAll = false
		}
		results = append(results, map[string]any{
			"target": t.ID(), "ok": ok,
			"message": firstNonEmpty(errString(err), restoredMsg(restored), "没有可用备份，跳过"),
		})
	}
	writeJSON(w, map[string]any{"ok": okAll, "message": rollbackSummary(okAll), "results": results})
}

func restoredMsg(restored []string) string {
	if len(restored) == 0 {
		return ""
	}
	return "已还原：" + strings.Join(restored, "、")
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func rollbackSummary(ok bool) string {
	if ok {
		return "回滚完成，重启对应工具后生效"
	}
	return "回滚部分失败，请查看详情"
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
