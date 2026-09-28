//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"fmt"
)

// ProviderInitializer is a function that creates a provider instance
type ProviderInitializer func(cfg Config) (Provider, error)

// The registry is mutable for the life of the process, not just at package-init
// time: user-defined custom providers are registered and removed while the
// server runs. Every accessor below therefore takes registryMu, and the two
// list accessors build fresh slices so a caller iterating a result can't be
// torn by a concurrent registration.
// The lock is a 1-capacity channel used as a binary semaphore (the codebase
// forbids sync.Mutex): acquire by sending, release by receiving. Reads take it
// too — they are map lookups and short slice builds, so there is nothing for a
// reader/writer split to win here.
var (
	registryLock = make(chan struct{}, 1)
	// initializers maps provider names to their initializer functions.
	initializers = make(map[string]ProviderInitializer)
	// providerInfos maps provider names to their info. Same lifecycle.
	providerInfos = make(map[string]ProviderInfo)
)

// RegisterProvider registers a provider info and its initializer. Registering a
// name that is already registered replaces it, which is how an edited custom
// provider takes effect.
func RegisterProvider(info ProviderInfo, initializer ProviderInitializer) {
	registryLock <- struct{}{}
	initializers[info.Name] = initializer
	providerInfos[info.Name] = info
	<-registryLock
	// A name can be re-registered with a different definition — a custom provider
	// the user edited — so a memoised detection for it now describes something
	// that is gone.
	invalidateAutoDetect(info.Name)
}

// UnregisterProvider removes a provider from the registry; removing one that is
// not registered is a no-op. Clients already built from it are untouched — this
// only stops new lookups finding it — so a turn under way when the user deletes
// a custom provider runs to the end instead of dying mid-stream.
func UnregisterProvider(name string) {
	registryLock <- struct{}{}
	delete(initializers, name)
	delete(providerInfos, name)
	<-registryLock
	invalidateAutoDetect(name)
}

// InitializeProvider initializes a provider by name using config
// Note: Model is required in Config. If you only need to list models,
// you can pass any placeholder model name since ListModelsWithInfo() doesn't use it.
func InitializeProvider(name string, cfg Config) (Provider, error) {
	registryLock <- struct{}{}
	initializer, ok := initializers[name]
	<-registryLock
	if !ok {
		return nil, fmt.Errorf("no initializer registered for provider: %s", name)
	}

	initialized, err := initializer(cfg)
	if err != nil {
		return nil, err
	}
	wrapped := &admissionProvider{
		Provider:     initialized,
		capabilities: cfg.ModelCapabilities,
		contract:     cfg.BudgetContract,
	}
	if usage, ok := initialized.(UsageStatsProvider); ok {
		return &admissionUsageProvider{admissionProvider: wrapped, usage: usage}, nil
	}
	return wrapped, nil
}

// ListAvailableProviders returns a list of registered provider names
func ListAvailableProviders() []string {
	registryLock <- struct{}{}
	defer func() { <-registryLock }()
	var names []string
	for name := range initializers {
		names = append(names, name)
	}
	return names
}

// GetProviderInfo returns the provider info for a given provider name
func GetProviderInfo(name string) (ProviderInfo, bool) {
	registryLock <- struct{}{}
	defer func() { <-registryLock }()
	info, ok := providerInfos[name]
	return info, ok
}

// ListProviderInfos returns all registered provider infos
func ListProviderInfos() []ProviderInfo {
	registryLock <- struct{}{}
	defer func() { <-registryLock }()
	infos := make([]ProviderInfo, 0, len(providerInfos))
	for _, info := range providerInfos {
		infos = append(infos, info)
	}
	return infos
}

// Auto-detection answers are memoised per provider. A probe can cost a PATH
// lookup or a credentials read and the provider refresh asks on every pass, so
// the answer is kept — but keyed by name rather than taken as one snapshot of
// the whole registry, because a provider registered later must still be probed
// instead of reading as absent-therefore-false for the life of the process.
var (
	autoDetectLock    = make(chan struct{}, 1)
	autoDetectResults = make(map[string]bool)
	// autoDetectGen advances on every registration change, so a probe still in
	// flight across one discards its answer rather than memoising a description
	// of a definition that has since been replaced.
	autoDetectGen uint64
)

// invalidateAutoDetect drops any memoised detection for name, so the next ask
// re-probes it against the definition now registered.
func invalidateAutoDetect(name string) {
	autoDetectLock <- struct{}{}
	defer func() { <-autoDetectLock }()
	delete(autoDetectResults, name)
	autoDetectGen++
}

// InvalidateAutoDetect drops every memoised detection, so the next ask re-probes
// the machine rather than answering from what was true at startup. The memo is
// keyed to a definition, not to the environment around it, so nothing about
// registering a provider expires an answer that went stale because the user
// installed a CLI while the server ran — which is the ordinary case during
// first-run setup, where the whole point is to go and install one.
func InvalidateAutoDetect() {
	autoDetectLock <- struct{}{}
	defer func() { <-autoDetectLock }()
	clear(autoDetectResults)
	// Advancing the generation discards the answer of any probe already in flight,
	// which would otherwise memoise a reading taken before the invalidation.
	autoDetectGen++
}

// CheckAutoDetect returns whether a provider is auto-detected as available,
// probing on the first ask for a name and answering from the memo after that.
func CheckAutoDetect(providerName string) bool {
	autoDetectLock <- struct{}{}
	cached, ok := autoDetectResults[providerName]
	gen := autoDetectGen
	<-autoDetectLock
	if ok {
		return cached
	}

	// Probed with no lock held: AutoDetect is provider-supplied and may touch the
	// filesystem or the credentials store, and one that blocks must not be able
	// to wedge every other provider's detection. Two goroutines racing the first
	// ask both probe and reach the same answer, which is the cheaper trade.
	detected := false
	if info, found := GetProviderInfo(providerName); found && info.AutoDetect != nil {
		detected = info.AutoDetect()
	}

	autoDetectLock <- struct{}{}
	defer func() { <-autoDetectLock }()
	if autoDetectGen != gen {
		// Registrations changed while we probed. Answer this caller, but leave the
		// memo alone so the next ask reads the definition that is actually there.
		return detected
	}
	autoDetectResults[providerName] = detected
	return detected
}
