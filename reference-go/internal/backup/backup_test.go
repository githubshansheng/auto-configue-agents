package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotRestoreRoundtrip(t *testing.T) {
	home := t.TempDir()
	target := "testtarget"
	orig := filepath.Join(home, "some", "file.json")
	if err := os.MkdirAll(filepath.Dir(orig), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orig, []byte(`{"v":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dir, backed, err := Snapshot(home, target, []string{orig})
	if err != nil || len(backed) != 1 {
		t.Fatalf("Snapshot: dir=%s backed=%v err=%v", dir, backed, err)
	}
	// 修改原文件
	if err := os.WriteFile(orig, []byte(`{"v":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	restored, err := Restore(dir)
	if err != nil || len(restored) != 1 {
		t.Fatalf("Restore: %v err=%v", restored, err)
	}
	data, _ := os.ReadFile(orig)
	if string(data) != `{"v":1}` {
		t.Fatalf("回滚后内容=%s", data)
	}
}

func TestRollbackDeletesNewlyCreatedFile(t *testing.T) {
	home := t.TempDir()
	target := "testtarget"
	orig := filepath.Join(home, "a", "new.json")
	// 第一次快照时文件不存在
	if _, _, err := Snapshot(home, target, []string{orig}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(orig), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orig, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	restored, err := RollbackLatest(home, target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orig); !os.IsNotExist(err) {
		t.Errorf("原本不存在的文件应被删除，restored=%v", restored)
	}
}

func TestRotateKeepsFive(t *testing.T) {
	home := t.TempDir()
	target := "testtarget"
	f := filepath.Join(home, "f.txt")
	_ = os.WriteFile(f, []byte("x"), 0o600)
	for i := 0; i < 7; i++ {
		if _, _, err := Snapshot(home, target, []string{f}); err != nil {
			t.Fatal(err)
		}
	}
	dirs, _ := listBackupDirs(home, target)
	if len(dirs) != 5 {
		t.Fatalf("应保留 5 份，got %d", len(dirs))
	}
	if _, err := LatestDir(home, target); err != nil {
		t.Fatal(err)
	}
}
