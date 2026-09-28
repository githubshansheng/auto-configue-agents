//go:build darwin

// Package platform 平台窗口策略。macOS 降级链：
// Edge App Mode → Chrome App Mode → 默认浏览器。
package platform

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// OpenWindow 打开 GUI 窗口。
func OpenWindow(port int, token string) {
	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", port, token)
	home, _ := os.UserHomeDir()
	profile := filepath.Join(home, ".triconfig", "browser-profile")
	bins := []string{
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		filepath.Join(home, "Applications", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
		filepath.Join(home, "Applications", "Google Chrome.app/Contents/MacOS/Google Chrome"),
	}
	for _, b := range bins {
		if _, err := os.Stat(b); err != nil {
			continue
		}
		cmd := exec.Command(b, "--app="+url, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check")
		if err := cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return
		}
	}
	_ = exec.Command("open", url).Start()
}
