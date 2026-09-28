// Package codexcli 目标：OpenAI Codex CLI（~/.codex/config.toml + auth.json）。
package codexcli

import (
	"triconfig/internal/backup"
	"triconfig/internal/configurators/codexconfig"
	"triconfig/internal/configurators/contract"
)

type target struct{ home string }

// New 创建 Codex CLI 目标插件。
func New() contract.Target { return &target{} }

func (t *target) ID() string          { return "codexcli" }
func (t *target) DisplayName() string { return "Codex CLI" }

func (t *target) Detect() contract.DetectResult {
	home, _ := codexconfig.UserHome()
	t.home = home
	dr := codexconfig.Detect(home, false)
	dr.ID = t.ID()
	dr.DisplayName = t.DisplayName()
	return dr
}

func (t *target) Plan(cfg contract.Config) ([]contract.Change, error) {
	return codexconfig.Plan(t.home, cfg), nil
}

func (t *target) Backup() (contract.Receipt, error) {
	_, toml, auth := codexconfig.PathsFor(t.home)
	dir, _, err := backup.Snapshot(t.home, t.ID(), []string{toml, auth})
	if err != nil {
		return contract.Receipt{}, err
	}
	return contract.Receipt{Dir: dir, Files: []string{toml, auth}}, nil
}

func (t *target) Configure(cfg contract.Config) ([]contract.Change, error) {
	return codexconfig.Configure(t.home, cfg, codexconfig.PersistEnv)
}

func (t *target) Verify(cfg contract.Config) contract.VerifyResult {
	return codexconfig.Verify(t.home, cfg)
}

func (t *target) Rollback(r contract.Receipt) error { return codexconfig.Rollback(r) }
