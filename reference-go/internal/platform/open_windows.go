//go:build windows

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// OpenWindow 打开 GUI 窗口。Windows 降级链：
// WebView2 独立窗口（P1）→ Edge App Mode → Chrome App Mode → 默认浏览器。
func OpenWindow(port int, token string) {
	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", port, token)
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "TriConfig", "browser-profile")
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	ld := os.Getenv("LOCALAPPDATA")
	bins := []string{
		filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(ld, "Google", "Chrome", "Application", "chrome.exe"),
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
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
