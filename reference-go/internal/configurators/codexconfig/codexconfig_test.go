package codexconfig

import (
	"regexp"
	"strings"
	"testing"
)

const userTOML = `# 用户注释
custom_flag = true

[profiles.work]
x = 1

[model_providers.triconfig]
name = "triconfig"
base_url = "https://old.example/v1"
wire_api = "responses"
`

func TestBuildTOMLFresh(t *testing.T) {
	out := BuildTOML("", "https://new.example", "a-fast")
	for _, want := range []string{
		`model_provider = "triconfig"`,
		`model = "a-fast"`,
		`review_model = "a-fast"`,
		`base_url = "https://new.example/v1"`,
		`wire_api = "responses"`,
		`env_key = "TRICONFIG_API_KEY"`,
		"requires_openai_auth = false",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("缺少 %s\n输出:\n%s", want, out)
		}
	}
}

func TestBuildTOMLPreservesUserSections(t *testing.T) {
	out := BuildTOML(userTOML, "https://new.example", "a-fast")
	if !strings.Contains(out, "custom_flag = true") {
		t.Error("用户顶层键丢失")
	}
	if !strings.Contains(out, "[profiles.work]") || !strings.Contains(out, "x = 1") {
		t.Error("用户自定义段落丢失")
	}
	if !strings.Contains(out, "# 用户注释") {
		t.Error("用户注释丢失")
	}
	if strings.Contains(out, "old.example") {
		t.Error("旧供应商块未替换")
	}
	if got := strings.Count(out, "[model_providers.triconfig]"); got != 1 {
		t.Errorf("供应商块应恰好 1 个，got %d", got)
	}
	// 顶层键不应重复（按行首精确匹配，避免误算 review_model/model_provider）
	modelRe := regexp.MustCompile(`(?m)^model = `)
	if n := len(modelRe.FindAllString(out, -1)); n != 1 {
		t.Errorf("model 顶层键应恰好 1 个，got %d", n)
	}
}

func TestHasProviderBlock(t *testing.T) {
	if HasProviderBlock(userTOML) != true {
		t.Error("应识别已存在的供应商块")
	}
	if HasProviderBlock("[profiles.x]\ny=2\n") {
		t.Error("不应误判")
	}
}

func TestLineDiff(t *testing.T) {
	oldText := "a = 1\nb = 2\n"
	newText := "a = 1\nc = 3\n"
	d := LineDiff(oldText, newText, 40)
	joined := strings.Join(d, "\n")
	if !strings.Contains(joined, "- b = 2") || !strings.Contains(joined, "+ c = 3") {
		t.Errorf("diff 不完整: %v", d)
	}
}

func TestMergeAuthJSONPreservesOtherFields(t *testing.T) {
	existing := `{"tokens":{"access":"abc"},"OPENAI_API_KEY":"sk-old"}`
	out := mergeAuthJSON(existing, "sk-new")
	if !strings.Contains(out, `"access": "abc"`) && !strings.Contains(out, `"access":"abc"`) {
		t.Errorf("其他字段丢失: %s", out)
	}
	if !strings.Contains(out, "sk-new") {
		t.Errorf("新密钥未写入: %s", out)
	}
	if !strings.Contains(out, "apikey") {
		t.Errorf("auth_mode 未写入: %s", out)
	}
}
