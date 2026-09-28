//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// nilInitializer is enough for registry tests: they never call the client.
func nilInitializer(Config) (Provider, error) { return nil, nil }

func TestUnregisterProviderRemovesIt(t *testing.T) {
	const name = "registry-unregister-provider"
	RegisterProvider(ProviderInfo{Name: name}, nilInitializer)
	if _, ok := GetProviderInfo(name); !ok {
		t.Fatal("provider missing right after registering it")
	}

	UnregisterProvider(name)
	if _, ok := GetProviderInfo(name); ok {
		t.Fatal("GetProviderInfo still finds an unregistered provider")
	}
	for _, info := range ListProviderInfos() {
		if info.Name == name {
			t.Fatal("ListProviderInfos still lists an unregistered provider")
		}
	}
	if _, err := InitializeProvider(name, Config{Model: "m"}); err == nil {
		t.Fatal("InitializeProvider built a client for an unregistered provider")
	}
	// Removing one that was never there is a no-op, not a panic.
	UnregisterProvider("registry-never-registered-provider")
}

// TestCheckAutoDetectSeesLaterRegistration pins the rule that detection is
// memoised per provider rather than as one whole-registry snapshot. A provider
// registered after something else has already asked — which is every custom
// provider the user adds while the server runs — must still be probed, not read
// as absent-therefore-false forever.
func TestCheckAutoDetectSeesLaterRegistration(t *testing.T) {
	const earlyName = "registry-autodetect-early"
	const lateName = "registry-autodetect-late"
	RegisterProvider(ProviderInfo{Name: earlyName, AutoDetect: func() bool { return true }}, nilInitializer)
	t.Cleanup(func() { UnregisterProvider(earlyName) })

	// Ask once, which is what fixes a whole-registry snapshot in place.
	if !CheckAutoDetect(earlyName) {
		t.Fatal("CheckAutoDetect on the early provider = false, want true")
	}

	RegisterProvider(ProviderInfo{Name: lateName, AutoDetect: func() bool { return true }}, nilInitializer)
	t.Cleanup(func() { UnregisterProvider(lateName) })
	if !CheckAutoDetect(lateName) {
		t.Fatal("CheckAutoDetect on a provider registered after the first ask = false, want true")
	}
}

// TestCheckAutoDetectMemoisesPerProvider covers the other half: the probe can be
// expensive and the refresh path asks on every pass, so a repeated ask must not
// re-run it — while re-registering the name must, since the definition changed.
func TestCheckAutoDetectMemoisesPerProvider(t *testing.T) {
	const name = "registry-autodetect-memo"
	var probes atomic.Int64
	register := func(result bool) {
		RegisterProvider(ProviderInfo{Name: name, AutoDetect: func() bool {
			probes.Add(1)
			return result
		}}, nilInitializer)
	}
	register(true)
	t.Cleanup(func() { UnregisterProvider(name) })

	for ask := range 2 {
		if !CheckAutoDetect(name) {
			t.Fatalf("CheckAutoDetect on ask %d = false, want true", ask+1)
		}
	}
	if got := probes.Load(); got != 1 {
		t.Fatalf("probe ran %d times across two asks, want 1", got)
	}

	// Re-registering the same name replaces the definition — an edited custom
	// provider — so the stale answer must not survive it.
	register(false)
	if CheckAutoDetect(name) {
		t.Fatal("CheckAutoDetect answered from the definition that was replaced")
	}
	if got := probes.Load(); got != 2 {
		t.Fatalf("probe ran %d times, want 2 (once per definition)", got)
	}
}

// TestInvalidateAutoDetectReprobesEnvironment pins the case the memo cannot see
// on its own: the definition is unchanged and the machine underneath it is not.
// A probe that answered "no CLI here" at startup must be retaken after the user
// goes and installs one, or first-run setup tells them their install failed.
func TestInvalidateAutoDetectReprobesEnvironment(t *testing.T) {
	const name = "registry-autodetect-environment"
	// Stands in for a CLI that is absent when the server starts and present once
	// the user has installed it.
	var installed atomic.Bool
	RegisterProvider(ProviderInfo{Name: name, AutoDetect: installed.Load}, nilInitializer)
	t.Cleanup(func() { UnregisterProvider(name) })

	if CheckAutoDetect(name) {
		t.Fatal("CheckAutoDetect = true before the CLI was installed, want false")
	}

	installed.Store(true)
	if CheckAutoDetect(name) {
		t.Fatal("CheckAutoDetect re-probed without being invalidated, so the memo is not doing its job")
	}

	InvalidateAutoDetect()
	if !CheckAutoDetect(name) {
		t.Fatal("CheckAutoDetect = false after InvalidateAutoDetect, so a CLI installed mid-session stays invisible")
	}
}

// TestRegistryConcurrentAccess drives every accessor from many goroutines while
// providers are registered and removed underneath them. It is a race-detector
// test: it asserts nothing beyond "no torn read, no panic", and only says
// anything under -race (or when the runtime's own concurrent-map check fires).
func TestRegistryConcurrentAccess(t *testing.T) {
	const workers = 8
	const iterations = 200

	var wg sync.WaitGroup
	// Writers churn their own names, so they never fight over one key and the
	// readers below always have something arriving and leaving.
	for w := range workers {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := range iterations {
				name := fmt.Sprintf("registry-churn-%d-%d", w, i)
				RegisterProvider(ProviderInfo{
					Name:       name,
					AutoDetect: func() bool { return true },
				}, nilInitializer)
				UnregisterProvider(name)
			}
		}(w)
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range iterations {
				ListProviderInfos()
				ListAvailableProviders()
				GetProviderInfo("anthropic")
				CheckAutoDetect("anthropic")
				_, _ = InitializeProvider("registry-absent", Config{Model: "m"})
			}
		}()
	}
	wg.Wait()
}
