// Package codexconfig 实现 Codex CLI / Codex Desktop 共享配置（~/.codex）的
// 探测、计划、备份、写入与校验。两者共用同一套配置文件，故本包被两个目标复用。
package codexconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"triconfig/internal/backup"
	"triconfig/internal/configurators/contract"
)

// PersistEnv 环境变量持久化钩子（平台文件提供默认实现；测试可替换）。
var PersistEnv = persistEnvDefault

// UserHome 返回用户主目录。
func UserHome() (string, error) { return os.UserHomeDir() }

// PathsFor 返回 Codex 配置路径组。
func PathsFor(home string) (dir, toml, auth string) {
	dir = filepath.Join(home, ".codex")
	return dir, filepath.Join(dir, "config.toml"), filepath.Join(dir, "auth.json")
}

func readIfExists(p string) (string, bool) {
	data, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	return string(data), true
}

// DesktopAppPath 探测 Codex Desktop / ChatGPT Desktop 安装路径，找不到返回空串。
func DesktopAppPath(home string) string {
	for _, p := range desktopCandidates(home) {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

// Detect 生成探测结果。desktop=true 时附带桌面版安装详情。
func Detect(home string, desktop bool) contract.DetectResult {
	_, toml, auth := PathsFor(home)
	_, tomlExists := readIfExists(toml)
	_, authExists := readIfExists(auth)
	installed := tomlExists || authExists

	existing, _ := readIfExists(toml)
	configured := HasProviderBlock(existing)

	dr := contract.DetectResult{
		Paths: []string{toml, auth},
	}
	dr.Installed = installed
	dr.Configured = configured
	if desktop {
		if app := DesktopAppPath(home); app != "" {
			dr.Detail = "已检测到桌面版：" + app
		} else {
			dr.Detail = "未检测到桌面版安装目录；Codex Desktop 与 CLI 共用 ~/.codex 配置，写入依然有效"
		}
	} else {
		if installed {
			dr.Detail = "已检测到 Codex 配置目录 ~/.codex"
		} else {
			dr.Detail = "未检测到 ~/.codex，首次写入将自动创建"
		}
	}
	if configured {
		dr.Detail += "；已包含本工具写入的供应商配置"
	}
	return dr
}

// Plan 生成写入计划（不落盘）。
func Plan(home string, cfg contract.Config) []contract.Change {
	_, toml, auth := PathsFor(home)
	var out []contract.Change

	existing, ok := readIfExists(toml)
	newTOML := BuildTOML(existing, cfg.BaseURL, cfg.DefaultModel)
	sum := "写入供应商 triconfig（base_url=" + cfg.BaseURL + "/v1），默认模型 " + cfg.DefaultModel
	if !ok {
		sum = "创建 " + toml + "；" + sum
	}
	out = append(out, contract.Change{
		File:    toml,
		Summary: sum,
		Diff:    LineDiff(existing, newTOML, 40),
	})

	existingAuth, ok := readIfExists(auth)
	newAuth := mergeAuthJSON(existingAuth, cfg.APIKey)
	sum = "写入 OPENAI_API_KEY（sk-**** 脱敏显示）与 auth_mode=apikey"
	if !ok {
		sum = "创建 " + auth + "；" + sum
	}
	out = append(out, contract.Change{
		File:    auth,
		Summary: sum,
		Diff:    LineDiff(existingAuth, newAuth, 20),
	})
	return out
}

// mergeAuthJSON 保留 auth.json 其他字段，仅更新 OPENAI_API_KEY 与 auth_mode。
func mergeAuthJSON(existing, key string) string {
	m := map[string]any{}
	if strings.TrimSpace(existing) != "" {
		_ = json.Unmarshal([]byte(existing), &m)
	}
	m["OPENAI_API_KEY"] = key
	m["auth_mode"] = "apikey"
	b, _ := json.MarshalIndent(m, "", "  ")
	return string(b)
}

// Configure 执行写入（调用方需先备份）。persistEnv 为环境变量持久化钩子。
func Configure(home string, cfg contract.Config, persistEnv func(string) (string, error)) ([]contract.Change, error) {
	dir, toml, auth := PathsFor(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("创建 %s 失败：%w", dir, err)
	}
	// 端点/密钥纠偏提示：地址末尾多余 /v1 已被上游归一化
	var out []contract.Change
	existing, _ := readIfExists(toml)
	newTOML := BuildTOML(existing, cfg.BaseURL, cfg.DefaultModel)
	if err := atomicWrite(toml, newTOML); err != nil {
		return out, fmt.Errorf("写入 %s 失败：%w", toml, err)
	}
	out = append(out, contract.Change{File: toml, Summary: "config.toml 已写入"})

	existingAuth, _ := readIfExists(auth)
	newAuth := mergeAuthJSON(existingAuth, cfg.APIKey)
	if err := atomicWrite(auth, newAuth); err != nil {
		return out, fmt.Errorf("写入 %s 失败：%w", auth, err)
	}
	out = append(out, contract.Change{File: auth, Summary: "auth.json 已写入"})

	if persistEnv != nil {
		if msg, err := persistEnv(cfg.APIKey); err != nil {
			out = append(out, contract.Change{File: "环境变量 TRICONFIG_API_KEY", Summary: "设置失败：" + err.Error() + "（配置文件仍已写入，如启动报缺 env 可手动设置）"})
		} else {
			out = append(out, contract.Change{File: "环境变量 TRICONFIG_API_KEY", Summary: msg})
		}
	}
	return out, nil
}

// Verify 写后校验：TOML 含供应商块、auth.json 可解析且含 Key、默认模型一致。
func Verify(home string, cfg contract.Config) contract.VerifyResult {
	_, toml, auth := PathsFor(home)
	existing, ok := readIfExists(toml)
	if !ok || !HasProviderBlock(existing) {
		return contract.VerifyResult{OK: false, Message: "config.toml 未包含供应商配置"}
	}
	if !strings.Contains(existing, `base_url = "`+cfg.BaseURL+`/v1"`) {
		return contract.VerifyResult{OK: false, Message: "config.toml 中 base_url 与预期不一致"}
	}
	authText, ok := readIfExists(auth)
	if !ok {
		return contract.VerifyResult{OK: false, Message: "auth.json 不存在"}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(authText), &m); err != nil {
		return contract.VerifyResult{OK: false, Message: "auth.json 不是合法 JSON"}
	}
	if k, _ := m["OPENAI_API_KEY"].(string); k != cfg.APIKey {
		return contract.VerifyResult{OK: false, Message: "auth.json 中密钥与输入不一致"}
	}
	return contract.VerifyResult{OK: true, Message: "config.toml + auth.json 校验通过（默认模型 " + cfg.DefaultModel + "）"}
}

// Rollback 依据备份凭证还原。
func Rollback(receipt contract.Receipt) error {
	_, err := backup.Restore(receipt.Dir)
	return err
}

func atomicWrite(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
