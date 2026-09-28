// Codex config.toml 的行级合并写入。
// 规则：顶层键（model/model_provider/review_model）替换或前置插入；
// 旧 [model_providers.triconfig] 块整体移除后重写；用户自定义段落原样保留。
package codexconfig

import (
	"regexp"
	"strconv"
	"strings"
)

const providerName = "triconfig"

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func setTopKey(lines []string, key, value string) []string {
	re := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	for i, l := range lines {
		if re.MatchString(l) {
			out := append([]string{}, lines...)
			out[i] = key + " = " + value
			return out
		}
	}
	insert := 0
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			insert++
		} else {
			break
		}
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:insert]...)
	out = append(out, key+" = "+value)
	out = append(out, lines[insert:]...)
	return out
}

func stripProviderBlock(lines []string, name string) []string {
	header := "[model_providers." + name + "]"
	out := make([]string, 0, len(lines))
	inBlock := false
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t == header {
			inBlock = true
			continue
		}
		if inBlock {
			if strings.HasPrefix(t, "[") {
				inBlock = false
			} else {
				continue
			}
		}
		out = append(out, l)
	}
	return out
}

// BuildTOML 基于旧内容生成新 config.toml。
// base 需已归一化（不含 /v1）；写入语义沿用旧工具实战验证链：
// wire_api=responses + env_key + requires_openai_auth=false。
func BuildTOML(existing, base, model string) string {
	lines := splitLines(existing)
	lines = stripProviderBlock(lines, providerName)
	lines = setTopKey(lines, "model_provider", `"`+providerName+`"`)
	lines = setTopKey(lines, "model", `"`+model+`"`)
	lines = setTopKey(lines, "review_model", `"`+model+`"`)

	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
		b.WriteString("\n")
	}
	b.WriteString("[model_providers." + providerName + "]\n")
	b.WriteString(`name = "` + providerName + `"` + "\n")
	b.WriteString(`base_url = "` + base + `/v1"` + "\n")
	b.WriteString(`wire_api = "responses"` + "\n")
	b.WriteString(`env_key = "TRICONFIG_API_KEY"` + "\n")
	b.WriteString("requires_openai_auth = false\n")
	return b.String()
}

// HasProviderBlock 判断 config.toml 是否已含本工具写入的供应商块。
func HasProviderBlock(existing string) bool {
	return strings.Contains(existing, "[model_providers."+providerName+"]")
}

// LineDiff 生成简易 diff 预览（-旧行 +新行，超限截断）。
func LineDiff(oldText, newText string, cap int) []string {
	oldFreq := freq(splitLines(oldText))
	newFreq := freq(splitLines(newText))
	var out []string
	for _, l := range splitLines(oldText) {
		if oldFreq[l] > newFreq[l] {
			out = append(out, "- "+l)
			delete(oldFreq, l)
		}
	}
	for _, l := range splitLines(newText) {
		if newFreq[l] > oldFreq[l] {
			out = append(out, "+ "+l)
			delete(newFreq, l)
		}
	}
	if len(out) > cap {
		more := len(out) - cap
		out = append(out[:cap:cap], "...（另有 "+strconv.Itoa(more)+" 行变更省略）")
	}
	return out
}

func freq(ls []string) map[string]int {
	m := make(map[string]int, len(ls))
	for _, l := range ls {
		m[l]++
	}
	return m
}
