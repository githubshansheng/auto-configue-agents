package oneclick

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"triconfig/internal/configurators/codexconfig"
)

// relay 假中转站：「最快者胜出」用相对延迟做结构性断言（30ms vs 250ms），不钉绝对毫秒。
func relay(t *testing.T, delays map[string]time.Duration) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-ok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad key"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{
				{"id": "a-fast"}, {"id": "z-slow"}, {"id": "text-embedding-x"},
			},
		})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if d, ok := delays[req.Model]; ok {
			time.Sleep(d)
		}
		_, _ = w.Write([]byte("data: {\"delta\":\"hi\"}\n\ndata: [DONE]\n\n"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func run(t *testing.T, req Request) []Event {
	t.Helper()
	var events []Event
	Run(context.Background(), t.TempDir(), req, func(e Event) { events = append(events, e) })
	return events
}

func last(events []Event, typ string) (Event, bool) {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type == typ {
			return events[i], true
		}
	}
	return Event{}, false
}

func TestPipelineSuccessAllTargets(t *testing.T) {
	srv := relay(t, map[string]time.Duration{"a-fast": 30 * time.Millisecond, "z-slow": 250 * time.Millisecond})
	home := t.TempDir()
	t.Setenv("HOME", home)

	old := codexconfig.PersistEnv
	codexconfig.PersistEnv = func(string) (string, error) { return "测试桩：已设置", nil }
	t.Cleanup(func() { codexconfig.PersistEnv = old })

	var events []Event
	Run(context.Background(), home, Request{
		BaseURL: srv.URL + "/v1", // 故意带 /v1，验证纠偏
		APIKey:  "sk-ok",
		Targets: []string{"codexcli", "codexdesktop", "workbuddy"},
	}, func(e Event) { events = append(events, e) })

	done, ok := last(events, "done")
	if !ok || !done.OK {
		t.Fatalf("管线应成功: done=%+v events=%+v", done, events)
	}
	if len(done.Results) != 3 {
		t.Fatalf("应 3 个目标结果，got %d", len(done.Results))
	}
	for _, r := range done.Results {
		if !r.OK {
			t.Errorf("目标 %s 校验失败: %s", r.Target, r.Message)
		}
	}

	// Codex 共享配置断言
	toml, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		t.Fatalf("config.toml: %v", err)
	}
	for _, want := range []string{
		`model = "a-fast"`, `base_url = "` + srv.URL + `/v1"`,
		`env_key = "TRICONFIG_API_KEY"`, "requires_openai_auth = false",
	} {
		if !strings.Contains(string(toml), want) {
			t.Errorf("config.toml 缺少 %s\n%s", want, toml)
		}
	}
	auth, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil || !strings.Contains(string(auth), "sk-ok") {
		t.Fatalf("auth.json 未写入密钥: %v %s", err, auth)
	}

	// WorkBuddy models.json 断言：2 个对话模型（embedding 被剔除）
	mb, err := os.ReadFile(filepath.Join(home, ".workbuddy", "models.json"))
	if err != nil {
		t.Fatalf("models.json: %v", err)
	}
	var arr []map[string]any
	if err := json.Unmarshal(mb, &arr); err != nil {
		t.Fatalf("models.json 非法: %v\n%s", err, mb)
	}
	if len(arr) != 2 {
		t.Fatalf("应 2 条，got %d: %s", len(arr), mb)
	}

	// 阶段链完整性：8 阶段都有终态
	seen := map[string]bool{}
	for _, e := range events {
		if e.Type == "stage" && e.Status != "running" {
			seen[e.Name] = true
		}
	}
	for _, s := range []string{"validate", "fetch", "filter", "speedtest", "plan", "backup", "write", "verify"} {
		if !seen[s] {
			t.Errorf("缺少阶段终态: %s", s)
		}
	}
}

func TestPipelineBadKeyFailsClean(t *testing.T) {
	srv := relay(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)

	events := run(t, Request{BaseURL: srv.URL, APIKey: "sk-bad", Targets: []string{"codexcli", "workbuddy"}})
	done, ok := last(events, "done")
	if !ok || done.OK {
		t.Fatalf("坏 Key 应整体失败: %+v", done)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "config.toml")); !os.IsNotExist(err) {
		t.Error("失败路径不应写入 config.toml")
	}
	if _, err := os.Stat(filepath.Join(home, ".workbuddy", "models.json")); !os.IsNotExist(err) {
		t.Error("失败路径不应写入 models.json")
	}
	if !strings.Contains(done.Message, "401") && !strings.Contains(done.Message, "Key") {
		t.Errorf("应含人话错误提示: %s", done.Message)
	}
}

func TestPipelineEmptyKeyFailsFast(t *testing.T) {
	events := run(t, Request{BaseURL: "https://x.example", APIKey: ""})
	done, _ := last(events, "done")
	if done.OK {
		t.Fatal("空 Key 应失败")
	}
	// validate 阶段就该失败，不应出现 fetch
	for _, e := range events {
		if e.Type == "stage" && e.Name == "fetch" && e.Status == "ok" {
			t.Error("空 Key 不应进入拉取阶段")
		}
	}
}
