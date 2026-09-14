//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

type capabilityCacheProvider struct {
	opened *[]*capabilityCacheConversation
}

func (p *capabilityCacheProvider) Name() string { return "test_capability_cache" }
func (p *capabilityCacheProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (p *capabilityCacheProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	conv := &capabilityCacheConversation{}
	*p.opened = append(*p.opened, conv)
	return conv, nil
}

type capabilityCacheConversation struct {
	closed      bool
	submits     int
	lastRequest provider.MessageRequest
	cancel      func()
}

func (c *capabilityCacheConversation) Submit(_ context.Context, req provider.MessageRequest, _ provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	c.submits++
	c.lastRequest = req
	return &provider.StreamResult{}, nil
}
func (c *capabilityCacheConversation) Subscribe(provider.TurnSink) {}
func (c *capabilityCacheConversation) CacheTTL() time.Duration     { return 0 }
func (c *capabilityCacheConversation) Cancel(string) {
	if c.cancel != nil {
		c.cancel()
	}
}
func (c *capabilityCacheConversation) Close() error {
	c.closed = true
	return nil
}

func TestConversationCacheCapabilitiesArePartOfIdentity(t *testing.T) {
	const providerName = "test_capability_cache"
	var configs []provider.Config
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	cache := newConversationCache(nil)
	t.Cleanup(cache.Shutdown)
	credential := core.ProviderCredential{APIKey: "test-key"}
	firstCapabilities := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}
	first, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, firstCapabilities, "")
	if err != nil {
		t.Fatalf("first GetOrOpen: %v", err)
	}
	reused, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, firstCapabilities, "")
	if err != nil {
		t.Fatalf("reused GetOrOpen: %v", err)
	}
	if reused != first {
		t.Fatal("unchanged capabilities did not reuse cached conversation")
	}
	if len(configs) != 1 || configs[0].ModelCapabilities != firstCapabilities {
		t.Fatalf("initial configs = %+v, want one config with capabilities %+v", configs, firstCapabilities)
	}

	secondCapabilities := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200}
	second, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, secondCapabilities, "")
	if err != nil {
		t.Fatalf("changed GetOrOpen: %v", err)
	}
	if second == first {
		t.Fatal("changed capabilities reused incompatible cached conversation")
	}
	if len(configs) != 2 || configs[1].ModelCapabilities != secondCapabilities {
		t.Fatalf("changed configs = %+v, want second config with capabilities %+v", configs, secondCapabilities)
	}
	if len(opened) != 2 || !opened[0].closed {
		t.Fatalf("opened conversations = %+v, want old handle closed before replacement", opened)
	}
}

// A conversation's workspace is part of its handle identity. Rebinding one to
// another workspace must retire the old handle: it can hold a live CLI
// subprocess rooted in the tree the conversation has just left, and a turn that
// kept talking to it would be working in the wrong place with no sign of it.
func TestConversationCacheWorkspaceIsPartOfIdentity(t *testing.T) {
	const providerName = "test_workspace_cache"
	var configs []provider.Config
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	cache := newConversationCache(nil)
	t.Cleanup(cache.Shutdown)
	credential := core.ProviderCredential{APIKey: "test-key"}
	capabilities := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}

	first, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, capabilities, "/tmp/worktree-a")
	if err != nil {
		t.Fatalf("first GetOrOpen: %v", err)
	}
	reused, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, capabilities, "/tmp/worktree-a")
	if err != nil {
		t.Fatalf("reused GetOrOpen: %v", err)
	}
	if reused != first {
		t.Fatal("the same workspace did not reuse the cached conversation")
	}
	if len(configs) != 1 || configs[0].WorkspaceRoot != "/tmp/worktree-a" {
		t.Fatalf("configs = %+v, want one config rooted at /tmp/worktree-a", configs)
	}

	second, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", credential, capabilities, "/tmp/worktree-b")
	if err != nil {
		t.Fatalf("rebound GetOrOpen: %v", err)
	}
	if second == first {
		t.Fatal("a rebound conversation reused the handle rooted in its old workspace")
	}
	if len(configs) != 2 || configs[1].WorkspaceRoot != "/tmp/worktree-b" {
		t.Fatalf("configs = %+v, want a second config rooted at /tmp/worktree-b", configs)
	}
	if len(opened) != 2 || !opened[0].closed {
		t.Fatalf("opened conversations = %+v, want the old handle closed before replacement", opened)
	}
}

func TestConversationCacheCancelDoesNotBlockOtherConversations(t *testing.T) {
	const providerName = "test_nonblocking_cancel_cache"
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	cache := newConversationCache(nil)
	credential := core.ProviderCredential{APIKey: "test-key"}
	capabilities := provider.ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100}
	if _, err := cache.GetOrOpen(context.Background(), "stuck", providerName, "model", credential, capabilities, ""); err != nil {
		t.Fatalf("open stuck conversation: %v", err)
	}

	cancelStarted := make(chan struct{})
	releaseCancel := make(chan struct{})
	opened[0].cancel = func() {
		close(cancelStarted)
		<-releaseCancel
	}
	cancelDone := make(chan struct{})
	go func() {
		cache.CancelConversation("stuck", "")
		close(cancelDone)
	}()
	<-cancelStarted
	select {
	case <-cancelDone:
	case <-time.After(time.Second):
		t.Fatal("CancelConversation waited for provider cancellation to complete")
	}

	openDone := make(chan error, 1)
	go func() {
		_, err := cache.GetOrOpen(context.Background(), "unrelated", providerName, "model", credential, capabilities, "")
		openDone <- err
	}()
	select {
	case err := <-openDone:
		if err != nil {
			t.Fatalf("open unrelated conversation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("unrelated conversation blocked behind provider cancellation")
	}

	sameDone := make(chan error, 1)
	go func() {
		_, err := cache.GetOrOpen(context.Background(), "stuck", providerName, "other-model", credential, capabilities, "")
		sameDone <- err
	}()
	select {
	case err := <-sameDone:
		t.Fatalf("same conversation raced provider cancellation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(releaseCancel)
	select {
	case err := <-sameDone:
		if err != nil {
			t.Fatalf("switch cancelled conversation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("same-conversation switch did not resume after cancellation")
	}
	cache.Shutdown()
}

func TestConversationCacheAdmissionContractFlowsFromProviderInfo(t *testing.T) {
	const providerName = "test_admission_contract_cache"
	var configs []provider.Config
	provider.RegisterProvider(provider.ProviderInfo{
		Name:               providerName,
		AllowUnknownLimits: true,
	}, func(cfg provider.Config) (provider.Provider, error) {
		configs = append(configs, cfg)
		opened := []*capabilityCacheConversation{}
		return &capabilityCacheProvider{opened: &opened}, nil
	})

	cache := newConversationCache(nil)
	t.Cleanup(cache.Shutdown)
	_, err := cache.GetOrOpen(context.Background(), "conv", providerName, "model", core.ProviderCredential{APIKey: "test-key"}, provider.ModelCapabilities{}, "")
	if err != nil {
		t.Fatalf("GetOrOpen: %v", err)
	}
	if len(configs) != 1 {
		t.Fatalf("configs = %d, want 1", len(configs))
	}
	got := configs[0].BudgetContract
	if !got.AllowUnknownLimits {
		t.Fatalf("budget contract = %+v, want unknown limits allowed", got)
	}
}

func TestConversationCacheAllowUnknownLimitsFlowsToAdmission(t *testing.T) {
	credential := core.ProviderCredential{APIKey: "test-key"}
	newCache := func() *conversationCache {
		cache := newConversationCache(nil)
		t.Cleanup(cache.Shutdown)
		return cache
	}
	register := func(name string, allowUnknown bool) *[]*capabilityCacheConversation {
		opened := &[]*capabilityCacheConversation{}
		provider.RegisterProvider(provider.ProviderInfo{Name: name, AllowUnknownLimits: allowUnknown}, func(provider.Config) (provider.Provider, error) {
			return &capabilityCacheProvider{opened: opened}, nil
		})
		return opened
	}

	// Unknown limits (zero capabilities) against a provider that did not opt
	// out must keep failing closed.
	closedName := "test_unknown_limits_closed_" + t.Name()
	register(closedName, false)
	closedConv, err := newCache().GetOrOpen(context.Background(), "conv", closedName, "model", credential, provider.ModelCapabilities{}, "")
	if err != nil {
		t.Fatalf("closed GetOrOpen: %v", err)
	}
	if _, err := closedConv.Submit(context.Background(), provider.MessageRequest{}, nil); err == nil {
		t.Fatal("closed provider admitted request with unknown limits")
	} else {
		var unknown *provider.UnknownContextLimitError
		if !errors.As(err, &unknown) {
			t.Fatalf("closed Submit error = %T %v, want UnknownContextLimitError", err, err)
		}
	}

	// A provider that declares AllowUnknownLimits (e.g. acp) must dispatch
	// unchecked, or every one of its turns would die at admission.
	openName := "test_unknown_limits_open_" + t.Name()
	opened := register(openName, true)
	openConv, err := newCache().GetOrOpen(context.Background(), "conv", openName, "model", credential, provider.ModelCapabilities{}, "")
	if err != nil {
		t.Fatalf("open GetOrOpen: %v", err)
	}
	if _, err := openConv.Submit(context.Background(), provider.MessageRequest{}, nil); err != nil {
		t.Fatalf("open provider rejected request despite AllowUnknownLimits: %v", err)
	}
	if len(*opened) != 1 || (*opened)[0].submits != 1 {
		t.Fatalf("opened = %+v, want exactly one passthrough submit", *opened)
	}
}
