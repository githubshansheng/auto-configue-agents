//go:build !darwin && !windows

package codexconfig

import (
	"fmt"
	"path/filepath"
)

func persistEnvDefault(key string) (string, error) {
	return "", fmt.Errorf("当前平台暂不支持自动持久化环境变量，请手动设置 TRICONFIG_API_KEY")
}

func desktopCandidates(home string) []string {
	return []string{
		filepath.Join(home, ".local", "opt", "codex-gpt56-patched"),
	}
}
