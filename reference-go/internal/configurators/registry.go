// Package configurators 目标注册表：汇聚全部目标插件。
package configurators

import (
	"sync"

	"triconfig/internal/configurators/codexcli"
	"triconfig/internal/configurators/codexdesktop"
	"triconfig/internal/configurators/contract"
	"triconfig/internal/configurators/workbuddy"
)

var (
	once  sync.Once
	all   []contract.Target
	byIDs map[string]contract.Target
)

// All 返回全部已注册目标（顺序即 GUI 展示顺序）。
func All() []contract.Target {
	once.Do(func() {
		all = []contract.Target{codexcli.New(), codexdesktop.New(), workbuddy.New()}
		byIDs = make(map[string]contract.Target, len(all))
		for _, t := range all {
			byIDs[t.ID()] = t
		}
	})
	return all
}

// ByID 按 ID 查找目标。
func ByID(id string) (contract.Target, bool) {
	All()
	t, ok := byIDs[id]
	return t, ok
}
