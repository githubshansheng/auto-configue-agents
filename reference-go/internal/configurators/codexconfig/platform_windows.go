//go:build windows

package codexconfig

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func runRegAdd(key string) (string, error) {
	cmd := exec.Command("reg", "add", `HKCU\Environment`, "/v", "TRICONFIG_API_KEY", "/t", "REG_SZ", "/d", key, "/f")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// persistEnvDefault Windows 用户级环境变量持久化（HKCU，无需管理员）。
func persistEnvDefault(key string) (string, error) {
	existing := strings.TrimSpace(os.Getenv("TRICONFIG_API_KEY"))
	if existing == key {
		return "用户级环境变量已是最新（新进程生效）", nil
	}
	out, err := runRegAdd(key)
	if err != nil {
		return "", fmt.Errorf("写入用户级环境变量失败：%w", err)
	}
	return "已写入用户级环境变量" + strings.TrimSpace(out) + "（新进程生效）", nil
}

// desktopCandidates Windows 桌面版候选安装路径。
func desktopCandidates(home string) []string {
	ld := os.Getenv("LOCALAPPDATA")
	return []string{
		filepath.Join(ld, "Programs", "Codex"),
		filepath.Join(ld, "Programs", "ChatGPT"),
		filepath.Join(ld, "OpenAI", "Codex"),
		filepath.Join(ld, "OpenAI", "ChatGPT"),
		filepath.Join(home, "Applications", "Codex-GPT56-Patched"),
	}
}
