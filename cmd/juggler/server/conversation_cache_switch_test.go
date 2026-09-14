//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

// TestConversationCacheCloseAllReopensUnderNewProject pins the invalidation
// contract SwitchProject depends on: CloseAllConversations closes every cached
// handle (across convIDs) and drops the entries, so the next GetOrOpen
// re-initializes the provider — and, crucially, re-reads the current project
// path. This is what lets a running-server project switch re-root the spawned
// CLI without restarting the process.
func TestConversationCacheCloseAllReopensUnderNewProject(t *testing.T) {
	const providerName = "test_closeall_projectpath"
	var configs []provider.Config
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	// A mutable project path stands in for Server.ProjectPath() across a switch.
	projectPath := "/project/A"
	cache := newConversationCache(func() string { return projectPath })
	t.Cleanup(cache.Shutdown)

	cred := core.ProviderCredential{APIKey: "k"}
	caps := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}

	// Open two distinct conversations under project A.
	firstA, err := cache.GetOrOpen(context.Background(), "conv-1", providerName, "model", cred, caps, "")
	if err != nil {
		t.Fatalf("open conv-1 under A: %v", err)
	}
	if _, err := cache.GetOrOpen(context.Background(), "conv-2", providerName, "model", cred, caps, ""); err != nil {
		t.Fatalf("open conv-2 under A: %v", err)
	}
	if configs[0].ProjectPath != "/project/A" {
		t.Fatalf("conv-1 opened with ProjectPath = %q, want /project/A", configs[0].ProjectPath)
	}
	if len(opened) != 2 {
		t.Fatalf("opened %d conversations, want 2", len(opened))
	}

	// Simulate a project switch: the server's project moves, then the cache is
	// invalidated (exactly what SwitchProject does, in that order).
	projectPath = "/project/B"
	cache.CloseAllConversations()

	for i, conv := range opened {
		if !conv.closed {
			t.Errorf("conversation %d not closed by CloseAllConversations", i)
		}
	}

	// Reopening the same convID must build a fresh handle rooted at project B.
	secondA, err := cache.GetOrOpen(context.Background(), "conv-1", providerName, "model", cred, caps, "")
	if err != nil {
		t.Fatalf("reopen conv-1 under B: %v", err)
	}
	if secondA == firstA {
		t.Fatal("reopen returned the stale closed handle; entries were not dropped")
	}
	if got := configs[len(configs)-1].ProjectPath; got != "/project/B" {
		t.Fatalf("reopened conv-1 ProjectPath = %q, want /project/B (the new project)", got)
	}
}

// TestSwitchProjectInvalidatesConversationCache verifies the wiring end-to-end:
// SwitchProject closes the previous project's cached conversations, and a
// conversation opened afterward is initialized against the new project root.
func TestSwitchProjectInvalidatesConversationCache(t *testing.T) {
	const providerName = "test_switch_invalidates_cache"
	var configs []provider.Config
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	s := &Server{wsFleet: wsFleet{hub: newClientHub()}}
	s.projectState.Store(&projectState{viewers: newViewerGroup()}) // start in no-project mode
	s.switchToken = make(chan struct{}, 1)
	s.switchToken <- struct{}{}
	s.conversationCache = newConversationCache(s.ProjectPath)
	t.Cleanup(s.conversationCache.Shutdown)

	cred := core.ProviderCredential{APIKey: "k"}
	caps := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}

	first, err := s.conversationCache.GetOrOpen(context.Background(), "conv", providerName, "model", cred, caps, "")
	if err != nil {
		t.Fatalf("open before switch: %v", err)
	}

	newProject := t.TempDir()
	// Switching into a real dir starts a live FileWatcher and takes the
	// instance lock (writing newProject/.juggler). Nothing else switches away,
	// so quiesce that state before t.TempDir's RemoveAll runs (registered after
	// TempDir → runs first): switch back to no-project, which schedules the
	// temp state's async teardown, then wait for that teardown to finish.
	// RemoveAll cannot run while any of it is live — it races the watcher and
	// fails with "directory not empty", and on Windows it cannot unlink
	// juggler.lock at all until InstanceLock.Release has closed its handle.
	t.Cleanup(func() {
		previous := s.projectState.Load()
		if err := s.SwitchProject(""); err != nil {
			return
		}
		select {
		case <-previous.teardownDone:
		case <-time.After(30 * time.Second):
			t.Error("the temp project's teardown never finished, so its files are still held open")
		}
	})
	if err := s.SwitchProject(newProject); err != nil {
		t.Fatalf("SwitchProject: %v", err)
	}
	if s.ProjectPath() != newProject {
		t.Fatalf("ProjectPath() = %q after switch, want %q", s.ProjectPath(), newProject)
	}

	if len(opened) != 1 || !opened[0].closed {
		t.Fatalf("SwitchProject did not close the previous conversation: opened=%+v", opened)
	}

	second, err := s.conversationCache.GetOrOpen(context.Background(), "conv", providerName, "model", cred, caps, "")
	if err != nil {
		t.Fatalf("reopen after switch: %v", err)
	}
	if second == first {
		t.Fatal("reopened the stale handle; SwitchProject did not invalidate the cache")
	}
	if got := configs[len(configs)-1].ProjectPath; got != newProject {
		t.Fatalf("conversation opened after switch has ProjectPath = %q, want the new project %q", got, newProject)
	}
}
