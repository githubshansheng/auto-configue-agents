//go:build !darwin && !windows

package platform

import (
	"fmt"
	"os/exec"
)

// OpenWindow 非 Windows/macOS 平台直接打开默认浏览器。
func OpenWindow(port int, token string) {
	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", port, token)
	_ = exec.Command("xdg-open", url).Start()
}
