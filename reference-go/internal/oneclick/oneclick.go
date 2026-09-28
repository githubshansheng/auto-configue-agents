// Package oneclick 实现一键配置八阶段流水线：
// validate → fetch → filter → speedtest → plan → backup → write → verify。
// 任一目标写入失败时，已写目标自动全量回滚。
package oneclick

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"triconfig/internal/configurators"
	"triconfig/internal/configurators/contract"
	"triconfig/internal/modelsapi"
)

// Request 一键配置请求。
type Request struct {
	BaseURL string   `json:"baseUrl"`
	APIKey  string   `json:"apiKey"`
	Targets []string `json:"targets"`
}

// TargetResult 单目标结果。
type TargetResult struct {
	Target  string `json:"target"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Event SSE 事件。
type Event struct {
	Type    string            `json:"type"` // stage|models|diff|done|error
	Name    string            `json:"name,omitempty"`
	Status  string            `json:"status,omitempty"` // running|ok|warn|fail
	Detail  string            `json:"detail,omitempty"`
	Models  []modelsapi.Model `json:"models,omitempty"`
	Changes []contract.Change `json:"changes,omitempty"`
	Results []TargetResult    `json:"results,omitempty"`
	OK      bool              `json:"ok,omitempty"`
	Message string            `json:"message,omitempty"`
}

const (
	evStage  = "stage"
	evModels = "models"
	evDiff   = "diff"
	evDone   = "done"
	evError  = "error"
)

// speedtest 约束：最多测 12 个模型，并发 4，单模型 10s 超时。
const (
	maxProbe    = 12
	probeConc   = 4
	probeTimout = 10 * time.Second
)

// Run 执行流水线。emit 必须线程安全（本实现单 goroutine 顺序调用）。
func Run(ctx context.Context, home string, req Request, emit func(Event)) {
	hc := &http.Client{}
	stage := func(name, status, detail string) {
		emit(Event{Type: evStage, Name: name, Status: status, Detail: detail})
	}
	fail := func(name, msg string) {
		stage(name, "fail", msg)
		emit(Event{Type: evError, Message: msg})
		emit(Event{Type: evDone, OK: false, Message: msg})
	}

	// 1. 校验输入
	stage("validate", "running", "")
	base := modelsapi.NormalizeBase(req.BaseURL)
	if strings.TrimSpace(req.APIKey) == "" {
		fail("validate", "API Key 不能为空")
		return
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		fail("validate", "中转地址需以 http(s):// 开头")
		return
	}
	targets := resolveTargets(home, req.Targets)
	if len(targets) == 0 {
		fail("validate", "未选择任何可写入的目标工具")
		return
	}
	ids := make([]string, 0, len(targets))
	for _, t := range targets {
		ids = append(ids, t.ID())
	}
	stage("validate", "ok", "目标："+strings.Join(ids, "、"))

	// 2. 连接中转站并拉取模型（兼连通性测试）
	stage("fetch", "running", "")
	allIDs, err := modelsapi.FetchModels(ctx, hc, base, req.APIKey)
	if err != nil {
		fail("fetch", err.Error())
		return
	}
	stage("fetch", "ok", fmt.Sprintf("连接成功，共 %d 个模型", len(allIDs)))

	// 3. 过滤非对话模型
	stage("filter", "running", "")
	kept, skipped := modelsapi.FilterNonChat(allIDs)
	if len(kept) == 0 {
		fail("filter", "中转站未返回可对话模型，请确认地址指向 OpenAI 兼容网关")
		return
	}
	stage("filter", "ok", fmt.Sprintf("保留 %d 个，剔除 %d 个非对话模型", len(kept), len(skipped)))

	// 4. 模型测速
	stage("speedtest", "running", "")
	testIDs := kept
	if len(testIDs) > maxProbe {
		testIDs = testIDs[:maxProbe]
	}
	ms := modelsapi.SpeedTest(ctx, hc, base, req.APIKey, testIDs, probeConc, probeTimout)
	emit(Event{Type: evModels, Models: ms})
	defaultModel := modelsapi.Model{}
	if best, ok := modelsapi.PickFastest(ms); ok {
		defaultModel = best
		stage("speedtest", "ok", fmt.Sprintf("默认模型 %s（%dms）", best.ID, best.TTFTMS))
	} else {
		defaultModel = modelsapi.Model{ID: kept[0]}
		stage("speedtest", "warn", "全部测速失败，默认模型取列表首个（写入仍会进行，请检查网络）")
	}
	cfg := contract.Config{
		BaseURL:      base,
		APIKey:       req.APIKey,
		DefaultModel: defaultModel.ID,
		Models:       ms,
	}

	// 5. 生成写入计划（干跑，不落盘）
	stage("plan", "running", "")
	var allChanges []contract.Change
	for _, t := range targets {
		chs, err := t.Plan(cfg)
		if err != nil {
			fail("plan", t.DisplayName()+" 生成计划失败："+err.Error())
			return
		}
		allChanges = append(allChanges, chs...)
	}
	emit(Event{Type: evDiff, Changes: allChanges})
	stage("plan", "ok", fmt.Sprintf("共 %d 个文件待写入", len(allChanges)))

	// 6. 备份
	stage("backup", "running", "")
	receipts := make(map[string]contract.Receipt, len(targets))
	var backupDirs []string
	for _, t := range targets {
		r, err := t.Backup()
		if err != nil {
			fail("backup", t.DisplayName()+" 备份失败："+err.Error())
			return
		}
		receipts[t.ID()] = r
		backupDirs = append(backupDirs, r.Dir)
	}
	stage("backup", "ok", fmt.Sprintf("已备份 %d 个目标（%s）", len(receipts), backupDirs[0]))

	// 7. 写入（任一失败 → 已写目标全量回滚）
	stage("write", "running", "")
	var written []contract.Target
	for _, t := range targets {
		if _, err := t.Configure(cfg); err != nil {
			msg := t.DisplayName() + " 写入失败：" + err.Error()
			for _, w := range written {
				if r, ok := receipts[w.ID()]; ok {
					_ = w.Rollback(r)
				}
			}
			fail("write", msg+"；已写目标已自动回滚")
			return
		}
		written = append(written, t)
	}
	stage("write", "ok", fmt.Sprintf("已写入 %d 个目标", len(written)))

	// 8. 验证
	stage("verify", "running", "")
	results := make([]TargetResult, 0, len(written))
	allOK := true
	for _, t := range targets {
		vr := t.Verify(cfg)
		results = append(results, TargetResult{Target: t.ID(), OK: vr.OK, Message: vr.Message})
		if !vr.OK {
			allOK = false
		}
	}
	if allOK {
		stage("verify", "ok", "全部目标校验通过")
	} else {
		stage("verify", "warn", "部分目标校验未通过，详见结果")
	}
	msg := "配置完成，重启对应工具后生效"
	if !allOK {
		msg = "配置完成但存在校验警告，请查看详情"
	}
	emit(Event{Type: evDone, OK: allOK, Message: msg, Results: results})
}

// resolveTargets 解析目标清单：
// - 显式指定的 ID 一律尊重（未安装也允许写入，配置文件会自动创建——AC-04）；
// - 未指定时默认取全部「已安装」目标。
// 无论哪种路径都先执行 Detect，保证目标实例绑定当前 home。
func resolveTargets(home string, want []string) []contract.Target {
	all := configurators.All()
	var out []contract.Target
	for _, t := range all {
		dr := t.Detect()
		if len(want) > 0 {
			matched := false
			for _, w := range want {
				if w == t.ID() {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		} else if !dr.Installed {
			continue
		}
		out = append(out, t)
	}
	return out
}
