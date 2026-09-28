//go:build darwin

package codexconfig

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// persistEnvDefault macOS 环境变量持久化：
// 1) launchctl setenv —— 当前图形会话即时可见（重启后失效）
// 2) ~/.zshenv 追加 export —— 新开终端持久生效
func persistEnvDefault(key string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	_ = exec.Command("launchctl", "setenv", "TRICONFIG_API_KEY", key).Run()

	zshenv := filepath.Join(home, ".zshenv")
	line := "export TRICONFIG_API_KEY=" + strconv.Quote(key)
	existing, err := os.ReadFile(zshenv)
	if err == nil && containsLine(string(existing), line) {
		return "环境变量已存在于 ~/.zshenv（当前会话已通过 launchctl 设置）", nil
	}
	f, err := os.OpenFile(zshenv, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("写入 ~/.zshenv 失败：%w", err)
	}
	defer f.Close()
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		if _, err := f.WriteString("\n"); err != nil {
			return "", err
		}
	}
	if _, err := f.WriteString("# added by TriConfig\n" + line + "\n"); err != nil {
		return "", err
	}
	return "已写入 ~/.zshenv 并设置当前图形会话（重启终端与桌面版后生效）", nil
}

func containsLine(s, line string) bool {
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == '\n' {
			if s[start:i] == line {
				return true
			}
			start = i + 1
		}
	}
	return false
}

// desktopCandidates macOS 桌面版候选安装路径。
func desktopCandidates(home string) []string {
	return []string{
		"/Applications/Codex.app",
		"/Applications/ChatGPT.app",
		filepath.Join(home, "Applications", "Codex.app"),
		filepath.Join(home, "Applications", "ChatGPT.app"),
	}
}
