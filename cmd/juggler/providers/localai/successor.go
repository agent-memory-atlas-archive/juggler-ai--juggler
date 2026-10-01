//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package localai

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/lmstudio"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
)

// successor names the LM Studio provider when LocalAI's host is an LM Studio
// server.
//
// LocalAI can talk to LM Studio — both speak the OpenAI-compatible API, so the
// models list and every turn works — but it reads windows from a LocalAI route
// LM Studio lacks, so every model is assumed to have DefaultContextWindow. A
// user who set LocalAI up that way is left with conversations compacting at a
// fraction of the window they loaded, and nothing on screen says the provider
// is the wrong one. Auto-detection cannot correct it: it runs only for a
// provider never switched on or off, and LocalAI's earlier probe accepted any
// server that answered.
func successor(ctx context.Context) *provider.Successor {
	host := server.Host()
	if !lmstudio.IsServer(ctx, host) {
		return nil
	}
	return &provider.Successor{
		Provider: "lmstudio",
		Reason: fmt.Sprintf("This server is LM Studio, not LocalAI. LocalAI can't read LM Studio's context windows, "+
			"so every model here is assumed to have %d tokens. The LM Studio provider reads the window each model is loaded with.",
			DefaultContextWindow),
		Adopt: func() error { return adoptHost(host) },
	}
}

// adoptHost points the LM Studio provider at host, the server LocalAI was using.
// Nothing is written when LM Studio already resolves to that host — by default
// or by its own setting — so a user on LM Studio's default port is left with
// no host override to wonder about.
func adoptHost(host string) error {
	if openaibase.NormaliseHost(host) == lmstudio.Host() {
		return nil
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}
	return store.SetRawKey(lmstudio.HostCredKey, host)
}
