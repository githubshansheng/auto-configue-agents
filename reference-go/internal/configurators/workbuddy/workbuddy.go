// Package workbuddy 目标：WorkBuddy 桌面端（~/.workbuddy/models.json 批量写入）。
// 条目 schema 与官方引擎读取字段严格对齐（沿用旧配置脚本实战验证的字段名）。
package workbuddy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"triconfig/internal/backup"
	"triconfig/internal/configurators/contract"
	"triconfig/internal/modelsapi"
)

type target struct{ home string }

// New 创建 WorkBuddy 目标插件。
func New() contract.Target { return &target{} }

func (t *target) ID() string          { return "workbuddy" }
func (t *target) DisplayName() string { return "WorkBuddy" }

func (t *target) Detect() contract.DetectResult {
	home, _ := os.UserHomeDir()
	t.home = home
	p := Path(home)
	dr := contract.DetectResult{ID: t.ID(), DisplayName: t.DisplayName(), Paths: []string{p}}
	entries, err := loadEntries(p)
	switch {
	case err != nil:
		dr.Detail = "存在 models.json 但无法解析（" + err.Error() + "），写入前会自动备份"
		dr.Installed = true
	case len(entries) > 0:
		dr.Installed = true
		dr.Configured = true
		dr.Detail = fmt.Sprintf("已检测到 models.json（%d 个模型条目）", len(entries))
	default:
		dr.Detail = "未检测到 models.json，首次写入将自动创建"
	}
	return dr
}

// Path models.json 路径。
func Path(home string) string { return filepath.Join(home, ".workbuddy", "models.json") }

// 官方输出上限映射（与旧脚本同源；未知模型兜底 131072）。
var outputCaps = map[string]int{
	"deepseek-v4-pro": 393216, "deepseek-v4.1-flash": 393216,
	"gemini-3.6-flash": 65536, "gemini-3.7-flash": 65536,
	"glm-5.3": 131072, "glm-5.3-flash": 131072,
	"grok-4.6": 131072, "grok-4.7": 131072, "minimax-m3": 131072,
}

func outCap(mid string) int {
	if v, ok := outputCaps[mid]; ok {
		return v
	}
	l := strings.ToLower(mid)
	switch {
	case strings.Contains(l, "embedding"), strings.Contains(l, "image"):
		return 8192
	case strings.HasPrefix(l, "gpt-"), strings.Contains(l, "codex"):
		return 128000
	case strings.Contains(l, "deepseek"):
		return 393216
	case strings.Contains(l, "gemini"):
		return 65536
	}
	return 131072
}

var allEfforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

func makeEntry(mid string, cfg contract.Config) map[string]any {
	return map[string]any{
		"id":                mid,
		"name":              mid,
		"url":               cfg.BaseURL + "/v1/chat/completions",
		"apiKey":            cfg.APIKey,
		"maxInputTokens":    300000,
		"maxOutputTokens":   outCap(mid),
		"supportsToolCall":  true,
		"supportsImages":    true,
		"supportsReasoning": true,
		"reasoning_effort":  "max",
		"reasoning": map[string]any{
			"supportedEfforts":   allEfforts,
			"defaultEffort":      "max",
			"effort":             "max",
			"canDisableThinking": false,
		},
	}
}

// loadEntries 读取 models.json（兼容裸数组与 {"models":[...]} 两种结构，统一为数组）。
func loadEntries(p string) ([]any, error) {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(string(data))
	if raw == "" {
		return nil, nil
	}
	var probe any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return nil, err
	}
	switch v := probe.(type) {
	case []any:
		return v, nil
	case map[string]any:
		if arr, ok := v["models"].([]any); ok {
			return arr, nil
		}
		return nil, fmt.Errorf("无法识别的结构: %T", probe)
	}
	return nil, fmt.Errorf("无法识别的结构: %T", probe)
}

// merge 合并：白名单历史条目清除；同 ID 覆盖；其余保留原顺序。
func merge(existing []any, cfg contract.Config) ([]any, string) {
	managed := map[string]bool{}
	for _, m := range cfg.Models {
		managed[m.ID] = true
	}
	keep := make([]any, 0, len(existing)+len(cfg.Models))
	purged, replaced := 0, 0
	for _, e := range existing {
		m, ok := e.(map[string]any)
		if !ok {
			keep = append(keep, e)
			continue
		}
		id, _ := m["id"].(string)
		switch {
		case modelsapi.WhitelistMatch(id):
			purged++
		case managed[id]:
			replaced++ // 将被新条目覆盖
		default:
			keep = append(keep, e)
		}
	}
	added := 0
	for _, m := range cfg.Models {
		keep = append(keep, makeEntry(m.ID, cfg))
		added++
	}
	summary := fmt.Sprintf("新增 %d、更新 %d、清除白名单历史 %d，合并后共 %d 条", added, replaced, purged, len(keep))
	return keep, summary
}

func (t *target) Plan(cfg contract.Config) ([]contract.Change, error) {
	p := Path(t.home)
	existing, _ := loadEntries(p)
	_, summary := merge(existing, cfg)
	sum := summary
	if _, err := os.Stat(p); os.IsNotExist(err) {
		sum = "创建 " + p + "；" + summary
	}
	return []contract.Change{{
		File:    p,
		Summary: sum,
		Diff:    diffEntries(existing, cfg),
	}}, nil
}

func diffEntries(existing []any, cfg contract.Config) []string {
	var out []string
	oldIDs := map[string]bool{}
	for _, e := range existing {
		if m, ok := e.(map[string]any); ok {
			if id, _ := m["id"].(string); id != "" {
				oldIDs[id] = true
			}
		}
	}
	newIDs := map[string]bool{}
	for _, m := range cfg.Models {
		newIDs[m.ID] = true
		if !oldIDs[m.ID] {
			out = append(out, "+ "+m.ID)
		}
	}
	for _, e := range existing {
		if m, ok := e.(map[string]any); ok {
			id, _ := m["id"].(string)
			if !newIDs[id] && (modelsapi.WhitelistMatch(id) || managedByOldRelay(m, cfg)) {
				out = append(out, "- "+id)
			}
		}
	}
	if len(out) > 40 {
		out = append(out[:40:40], "...（更多省略）")
	}
	return out
}

func managedByOldRelay(m map[string]any, cfg contract.Config) bool {
	u, _ := m["url"].(string)
	return u != "" && strings.HasPrefix(u, cfg.BaseURL)
}

func (t *target) Backup() (contract.Receipt, error) {
	p := Path(t.home)
	dir, _, err := backup.Snapshot(t.home, t.ID(), []string{p})
	if err != nil {
		return contract.Receipt{}, err
	}
	return contract.Receipt{Dir: dir, Files: []string{p}}, nil
}

func (t *target) Configure(cfg contract.Config) ([]contract.Change, error) {
	p := Path(t.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, fmt.Errorf("创建 %s 失败：%w", filepath.Dir(p), err)
	}
	existing, _ := loadEntries(p)
	merged, _ := merge(existing, cfg)
	b, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := atomicWrite(p, string(b)+"\n"); err != nil {
		return nil, fmt.Errorf("写入 %s 失败：%w", p, err)
	}
	return []contract.Change{{File: p, Summary: "models.json 已写入"}}, nil
}

func (t *target) Verify(cfg contract.Config) contract.VerifyResult {
	entries, err := loadEntries(Path(t.home))
	if err != nil {
		return contract.VerifyResult{OK: false, Message: "models.json 不是合法 JSON：" + err.Error()}
	}
	found := false
	count := 0
	for _, e := range entries {
		if m, ok := e.(map[string]any); ok {
			count++
			if id, _ := m["id"].(string); id == cfg.DefaultModel {
				found = true
			}
		}
	}
	if !found {
		return contract.VerifyResult{OK: false, Message: "models.json 中未找到默认模型 " + cfg.DefaultModel}
	}
	return contract.VerifyResult{OK: true, Message: fmt.Sprintf("校验通过（共 %d 条，默认模型 %s）", count, cfg.DefaultModel)}
}

func (t *target) Rollback(r contract.Receipt) error {
	_, err := backup.Restore(r.Dir)
	return err
}

func atomicWrite(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
