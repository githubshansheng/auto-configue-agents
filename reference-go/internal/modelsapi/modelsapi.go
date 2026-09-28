// Package modelsapi 提供中转站模型列表拉取、白名单过滤与并发测速。
package modelsapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Model 一次测速后的模型条目。TTFTMS 为首字延迟毫秒（夹紧 >=1；0 表示未测到）。
type Model struct {
	ID     string `json:"id"`
	TTFTMS int64  `json:"ttftMs"`
	OK     bool   `json:"ok"`
}

// NormalizeBase 归一化中转地址：去空白、去尾部斜杠、去多余的 /v1 与 /chat/completions。
func NormalizeBase(base string) string {
	b := strings.TrimSpace(base)
	b = strings.TrimSuffix(b, "/")
	b = strings.TrimSuffix(b, "/chat/completions")
	b = strings.TrimSuffix(b, "/v1")
	b = strings.TrimSuffix(b, "/")
	return b
}

// 白名单规则与旧 workbuddy 脚本同源：非对话模型不参与配置。
var whitelistRe = regexp.MustCompile(`(?i)embedding|image|whisper|tts|dall-e|moderation|rerank|^codex-auto-review$|^gpt-5\.4-mini$`)

// WhitelistMatch 判断单个模型 ID 是否命中白名单（非对话模型）。
func WhitelistMatch(id string) bool { return whitelistRe.MatchString(id) }

// FilterNonChat 按白名单剔除非对话模型。
func FilterNonChat(ids []string) (kept, skipped []string) {
	for _, id := range ids {
		if whitelistRe.MatchString(id) {
			skipped = append(skipped, id)
		} else {
			kept = append(kept, id)
		}
	}
	return
}

func friendlyHTTPError(status int, body []byte) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("API Key 无效或无权限（HTTP %d），请检查密钥", status)
	case http.StatusNotFound:
		return fmt.Errorf("接口路径不存在（HTTP 404），请确认中转地址是否正确")
	case http.StatusTooManyRequests:
		return fmt.Errorf("中转站限流（HTTP 429），请稍后重试")
	}
	if status >= 500 {
		return fmt.Errorf("中转站服务异常（HTTP %d）", status)
	}
	tail := strings.TrimSpace(string(body))
	if len(tail) > 120 {
		tail = tail[:120]
	}
	return fmt.Errorf("请求失败（HTTP %d）%s", status, tail)
}

// FetchModels 拉取 /v1/models，兼容 {"data":[...]} 与裸数组两种返回。
func FetchModels(ctx context.Context, hc *http.Client, base, key string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, NormalizeBase(base)+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接中转站（%v），请检查地址与网络", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, friendlyHTTPError(resp.StatusCode, body)
	}
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, fmt.Errorf("模型列表返回的不是合法 JSON")
	}
	var items []any
	switch v := probe.(type) {
	case []any:
		items = v
	case map[string]any:
		if arr, ok := v["data"].([]any); ok {
			items = arr
		}
	}
	seen := map[string]bool{}
	var ids []string
	for _, it := range items {
		var id string
		switch m := it.(type) {
		case map[string]any:
			if s, ok := m["id"].(string); ok {
				id = s
			}
		case string:
			id = m
		}
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// SpeedTest 并发静默测速：向 chat/completions 发起流式请求，取首字延迟。
// 结果按模型 ID 排序保证稳定；单模型失败不影响其他（OK=false）。
func SpeedTest(ctx context.Context, hc *http.Client, base, key string, ids []string, concurrency int, per time.Duration) []Model {
	if concurrency < 1 {
		concurrency = 1
	}
	if per <= 0 {
		per = 10 * time.Second
	}
	sem := make(chan struct{}, concurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup
	out := make([]Model, 0, len(ids))
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ttft, err := probeTTFT(ctx, hc, base, key, id, per)
			mu.Lock()
			defer mu.Unlock()
			m := Model{ID: id}
			if err == nil {
				m.OK = true
				m.TTFTMS = ttft
			}
			out = append(out, m)
		}(id)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// probeTTFT 返回首字延迟毫秒。夹紧下限 1ms：本机回环可能测出 0，0 保留给「未测到」。
func probeTTFT(ctx context.Context, hc *http.Client, base, key, id string, per time.Duration) (int64, error) {
	pctx, cancel := context.WithTimeout(ctx, per)
	defer cancel()
	payload := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":true}`, id)
	req, err := http.NewRequestWithContext(pctx, http.MethodPost, NormalizeBase(base)+"/v1/chat/completions", strings.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	start := time.Now()
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return 0, friendlyHTTPError(resp.StatusCode, body)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "data:") {
			ms := time.Since(start).Milliseconds()
			if ms < 1 {
				ms = 1
			}
			return ms, nil
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("未收到任何流式响应")
}

// PickFastest 选出测速最快且成功的模型；并列时取字典序更小者（结果稳定）。
func PickFastest(ms []Model) (Model, bool) {
	var best Model
	found := false
	for _, m := range ms {
		if !m.OK || m.TTFTMS <= 0 {
			continue
		}
		if !found || m.TTFTMS < best.TTFTMS || (m.TTFTMS == best.TTFTMS && m.ID < best.ID) {
			best = m
			found = true
		}
	}
	return best, found
}
