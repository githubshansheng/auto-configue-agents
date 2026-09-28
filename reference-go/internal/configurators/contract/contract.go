// Package configurators 定义目标插件契约。
// 每个目标（Codex CLI / Codex Desktop / WorkBuddy）实现五段式生命周期：
// Detect → Plan → Backup → Configure → Verify，外加 Rollback。
package contract

import "triconfig/internal/modelsapi"

// Config 一次一键配置的统一输入。
type Config struct {
	BaseURL      string            // 已归一化的中转地址（不含 /v1）
	APIKey       string            // 用户手动录入的 API Key
	DefaultModel string            // 测速选优出的默认模型
	Models       []modelsapi.Model // 测速后的模型清单
}

// DetectResult 目标探测结果。
type DetectResult struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Installed   bool     `json:"installed"`
	Configured  bool     `json:"configured"`
	Detail      string   `json:"detail"`
	Paths       []string `json:"paths"`
}

// Change 一条写入计划（一个文件）。
type Change struct {
	File    string   `json:"file"`
	Summary string   `json:"summary"`
	Diff    []string `json:"diff"`
}

// Receipt 备份凭证，Rollback 依据。
type Receipt struct {
	Dir   string   `json:"dir"`
	Files []string `json:"files"`
}

// VerifyResult 写后校验结果。
type VerifyResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Target 目标插件接口。新增目标 = 实现一个包 + 注册一行。
type Target interface {
	ID() string
	DisplayName() string
	Detect() DetectResult
	Plan(cfg Config) ([]Change, error)
	Backup() (Receipt, error)
	Configure(cfg Config) ([]Change, error)
	Verify(cfg Config) VerifyResult
	Rollback(r Receipt) error
}
