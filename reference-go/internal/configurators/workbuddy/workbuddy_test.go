package workbuddy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"triconfig/internal/configurators/contract"
	"triconfig/internal/modelsapi"
)

func cfg(models ...modelsapi.Model) contract.Config {
	return contract.Config{
		BaseURL:      "https://relay.example",
		APIKey:       "sk-test",
		DefaultModel: "glm-5.3-flash",
		Models:       models,
	}
}

func TestOutCap(t *testing.T) {
	cases := map[string]int{
		"deepseek-v4-pro": 393216, "glm-5.3-flash": 131072,
		"gemini-3.6-flash": 65536, "gpt-5.6-sol": 128000,
		"some-new-model": 131072, "qwen3.7-text-embedding": 8192,
	}
	for id, want := range cases {
		if got := outCap(id); got != want {
			t.Errorf("outCap(%s)=%d, want %d", id, got, want)
		}
	}
}

func TestMergePreservesForeignAndPurgesWhitelist(t *testing.T) {
	existing := []any{
		map[string]any{"id": "foreign-manual", "url": "https://other.example/v1/chat/completions"},
		map[string]any{"id": "text-embedding-x", "url": "https://relay.example/v1/chat/completions"},
		map[string]any{"id": "glm-5.3-flash", "url": "https://relay.example/v1/chat/completions", "apiKey": "sk-old"},
	}
	merged, summary := merge(existing, cfg(modelsapi.Model{ID: "glm-5.3-flash", OK: true}, modelsapi.Model{ID: "deepseek-v4-pro", OK: true}))
	if len(merged) != 3 {
		t.Fatalf("合并后应 3 条（foreign 保留 + 2 新），got %d", len(merged))
	}
	ids := map[string]bool{}
	for _, e := range merged {
		if m, ok := e.(map[string]any); ok {
			ids[m["id"].(string)] = true
		}
	}
	if !ids["foreign-manual"] {
		t.Error("外部手工条目应保留")
	}
	if ids["text-embedding-x"] {
		t.Error("白名单历史条目应清除")
	}
	if !strings.Contains(summary, "更新 1") || !strings.Contains(summary, "新增 2") || !strings.Contains(summary, "清除白名单历史 1") {
		t.Errorf("汇总不对: %s", summary)
	}
}

func TestEntrySchemaMatchesEngine(t *testing.T) {
	e := makeEntry("glm-5.3-flash", cfg())
	if e["maxInputTokens"] != 300000 {
		t.Error("maxInputTokens 应 300000")
	}
	if e["maxOutputTokens"] != 131072 {
		t.Error("glm-5.3-flash 输出上限应 131072")
	}
	if e["url"] != "https://relay.example/v1/chat/completions" {
		t.Errorf("url=%v", e["url"])
	}
	r, ok := e["reasoning"].(map[string]any)
	if !ok || r["defaultEffort"] != "max" || r["canDisableThinking"] != false {
		t.Errorf("reasoning 字段不对: %v", e["reasoning"])
	}
	if se, _ := r["supportedEfforts"].([]string); len(se) != 6 {
		t.Errorf("supportedEfforts 应 6 档: %v", se)
	}
}

func TestApplyVerifyRollbackRoundtrip(t *testing.T) {
	home := t.TempDir()
	tg := &target{home: home}
	c := cfg(modelsapi.Model{ID: "glm-5.3-flash", OK: true, TTFTMS: 42}, modelsapi.Model{ID: "deepseek-v4-pro", OK: true})

	// 首次写入（文件不存在 → 创建，AC-04）
	if _, err := tg.Configure(c); err != nil {
		t.Fatalf("Configure: %v", err)
	}
	vr := tg.Verify(c)
	if !vr.OK {
		t.Fatalf("Verify: %+v", vr)
	}
	// 外部手工条目替换整个文件，模拟「写入前先备份，回滚还原精确字节」
	p := Path(home)
	_ = os.WriteFile(p, []byte(`[{"id":"foreign-manual"}]`), 0o600)

	rec, err := tg.Backup() // 捕获当前状态（仅 foreign 条目）
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if _, err := tg.Configure(c); err != nil {
		t.Fatalf("Configure 2: %v", err)
	}
	// 写入后应是「foreign 保留 + 2 个托管条目」
	rawMid, _ := os.ReadFile(p)
	if !strings.Contains(string(rawMid), "foreign-manual") || !strings.Contains(string(rawMid), "deepseek-v4-pro") {
		t.Fatalf("合并写入应保留外部条目: %s", rawMid)
	}
	if err := tg.Rollback(rec); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	raw2, _ := os.ReadFile(p)
	var arr2 []map[string]any
	if err := json.Unmarshal(raw2, &arr2); err != nil {
		t.Fatalf("回滚后 JSON 非法: %v", err)
	}
	if len(arr2) != 1 || arr2[0]["id"] != "foreign-manual" {
		t.Fatalf("回滚应精确还原写前状态: %s", raw2)
	}
	_ = filepath.Separator
}
