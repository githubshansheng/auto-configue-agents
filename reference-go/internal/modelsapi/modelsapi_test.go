package modelsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNormalizeBase(t *testing.T) {
	cases := map[string]string{
		"  https://api.example.com ":                  "https://api.example.com",
		"https://api.example.com/":                    "https://api.example.com",
		"https://api.example.com/v1":                  "https://api.example.com",
		"https://api.example.com/v1/":                 "https://api.example.com",
		"https://api.example.com/v1/chat/completions": "https://api.example.com",
		"http://127.0.0.1:9000/v1":                    "http://127.0.0.1:9000",
	}
	for in, want := range cases {
		if got := NormalizeBase(in); got != want {
			t.Errorf("NormalizeBase(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestFilterNonChat(t *testing.T) {
	kept, skipped := FilterNonChat([]string{
		"glm-5.3-flash", "text-embedding-3", "gpt-image-2", "tts-1",
		"codex-auto-review", "gpt-5.4-mini", "deepseek-v4-pro",
	})
	wantKept := map[string]bool{"glm-5.3-flash": true, "deepseek-v4-pro": true}
	if len(kept) != len(wantKept) {
		t.Fatalf("kept=%v", kept)
	}
	for _, k := range kept {
		if !wantKept[k] {
			t.Errorf("不应保留 %s", k)
		}
	}
	if len(skipped) != 5 {
		t.Errorf("skipped=%v，应剔除 5 个", skipped)
	}
}

// mockRelay 返回一个 OpenAI 兼容假中转站：/v1/models + /v1/chat/completions。
// 各模型延迟由 delays 控制；「最快者胜出」用相对延迟做结构性断言，不钉绝对毫秒。
func mockRelay(t *testing.T, delays map[string]time.Duration, modelsStatus int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad key"}`))
			return
		}
		if modelsStatus != http.StatusOK {
			w.WriteHeader(modelsStatus)
			return
		}
		ids := []string{"a-fast", "z-slow", "text-embedding-x"}
		type item struct {
			ID string `json:"id"`
		}
		var data []item
		for _, id := range ids {
			data = append(data, item{ID: id})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if d, ok := delays[req.Model]; ok {
			time.Sleep(d)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"delta\":\"hi\"}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchAndSpeedTestPickFastest(t *testing.T) {
	srv := mockRelay(t, map[string]time.Duration{
		"a-fast": 30 * time.Millisecond,
		"z-slow": 250 * time.Millisecond,
	}, http.StatusOK)

	ctx := context.Background()
	hc := &http.Client{}
	ids, err := FetchModels(ctx, hc, srv.URL, "sk-test")
	if err != nil {
		t.Fatalf("FetchModels: %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("模型数=%d, want 3: %v", len(ids), ids)
	}
	kept, _ := FilterNonChat(ids)
	if len(kept) != 2 {
		t.Fatalf("过滤后=%v, want 2 个", kept)
	}
	ms := SpeedTest(ctx, hc, srv.URL, "sk-test", kept, 2, 5*time.Second)
	best, ok := PickFastest(ms)
	if !ok || best.ID != "a-fast" {
		t.Fatalf("最快者应为 a-fast，got %+v (all=%v)", best, ms)
	}
	for _, m := range ms {
		if m.OK && m.TTFTMS < 1 {
			t.Errorf("TTFT 未夹紧: %+v", m)
		}
	}
}

func TestFetchModelsBadKey(t *testing.T) {
	srv := mockRelay(t, nil, http.StatusOK)
	_, err := FetchModels(context.Background(), &http.Client{}, srv.URL, "sk-wrong")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("应返回 401 人话错误，got %v", err)
	}
}

func TestFetchModelsNotFound(t *testing.T) {
	// 端点路径错误 → 404 人话提示
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	_, err := FetchModels(context.Background(), &http.Client{}, srv.URL, "sk-test")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("应返回 404 提示，got %v", err)
	}
}
