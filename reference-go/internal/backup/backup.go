// Package backup 提供写前快照、一键回滚与轮转清理（每目标保留最近 5 份）。
package backup

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const keep = 5

// manifestName 记录备份来源路径，用于把 basename 映射回原位置。
const manifestName = "_paths.txt"

func baseDir(home, target string) string {
	return filepath.Join(home, ".triconfig", "backups", target)
}

// Snapshot 把 files 中存在的文件复制到 ~/.triconfig/backups/<target>/<时间戳>/，
// 并写入来源清单；返回备份目录与实际备份的文件原路径列表。
// 同秒多次快照时目录名追加序号，避免互相覆盖。
func Snapshot(home, target string, files []string) (string, []string, error) {
	root := baseDir(home, target)
	ts := time.Now().Format("20060102-150405")
	dir := filepath.Join(root, ts)
	for i := 1; ; i++ {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			break
		}
		dir = filepath.Join(root, fmt.Sprintf("%s-%d", ts, i))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, err
	}
	var backed []string
	var manifest []byte
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			if os.IsNotExist(err) {
				manifest = append(manifest, []byte(f+"\n")...) // 原本不存在：记录位置，回滚时删除
				continue
			}
			return "", nil, fmt.Errorf("读取 %s 失败：%w", f, err)
		}
		dst := filepath.Join(dir, filepath.Base(f))
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			return "", nil, fmt.Errorf("写入备份 %s 失败：%w", dst, err)
		}
		manifest = append(manifest, []byte(f+"\n")...)
		backed = append(backed, f)
	}
	if err := os.WriteFile(filepath.Join(dir, manifestName), manifest, 0o600); err != nil {
		return "", nil, err
	}
	Rotate(home, target)
	return dir, backed, nil
}

// Restore 把备份目录内的文件按来源清单还原；清单中「原本不存在」的文件将被删除。
func Restore(dir string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		return nil, fmt.Errorf("备份缺少来源清单：%w", err)
	}
	var restored []string
	for _, orig := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if orig == "" {
			continue
		}
		bak := filepath.Join(dir, filepath.Base(orig))
		src, err := os.ReadFile(bak)
		switch {
		case err == nil:
			if err := os.WriteFile(orig, src, 0o600); err != nil {
				return restored, fmt.Errorf("还原 %s 失败：%w", orig, err)
			}
			restored = append(restored, orig)
		case os.IsNotExist(err):
			// 原本不存在 → 删除本次写入产生的文件
			if err := os.Remove(orig); err == nil {
				restored = append(restored, orig+"（已删除）")
			}
		default:
			return restored, fmt.Errorf("读取备份 %s 失败：%w", bak, err)
		}
	}
	return restored, nil
}

// LatestDir 返回最近一次备份目录。
func LatestDir(home, target string) (string, error) {
	dirs, err := listBackupDirs(home, target)
	if err != nil {
		return "", err
	}
	if len(dirs) == 0 {
		return "", fmt.Errorf("没有可用的备份")
	}
	return dirs[len(dirs)-1], nil
}

// RollbackLatest 还原指定目标最近一次备份，返回影响的文件列表。
func RollbackLatest(home, target string) ([]string, error) {
	dir, err := LatestDir(home, target)
	if err != nil {
		return nil, err
	}
	return Restore(dir)
}

// Rotate 只保留最近 keep 份备份。
func Rotate(home, target string) {
	dirs, err := listBackupDirs(home, target)
	if err != nil {
		return
	}
	for i := 0; i < len(dirs)-keep; i++ {
		_ = os.RemoveAll(dirs[i])
	}
}

func listBackupDirs(home, target string) ([]string, error) {
	root := baseDir(home, target)
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, filepath.Join(root, e.Name()))
		}
	}
	sort.Strings(dirs)
	return dirs, nil
}
