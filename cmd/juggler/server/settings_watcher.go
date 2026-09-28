//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/httpx"
	"juggler/internal/jlog"

	"github.com/fsnotify/fsnotify"
)

// settingsReloadDebounce is how long the watcher waits for the config directory
// to go quiet before reloading. One save is a temp-file write, a chmod and a
// rename, so the burst is collapsed into a single reload.
const settingsReloadDebounce = 300 * time.Millisecond

// settingsRevision names a settings document by its contents: the same settings
// always hash the same way (they are normalised on both read and write), and a
// change to any section produces a different hash.
//
// It exists to answer one question — "did that write actually change anything?" —
// for a whole document, without comparing it field by field. Nothing outside this
// process sees it: clients are sent the document, which is the only thing they
// have any use for.
func settingsRevision(gs core.GlobalSettings) string {
	data, err := json.Marshal(gs)
	if err != nil {
		// Only an unmarshalable value gets here, which this struct cannot hold.
		// An empty revision compares unequal to every real one, so the caller
		// broadcasts rather than swallowing a change it cannot name.
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

// broadcastSettingsChanged hands every connected client the whole new document.
// The settings ride the event rather than a "go and refetch" nudge, so N windows
// converge on one broadcast instead of answering it with N GETs.
//
// There is no origin to exclude: the window that made the change needs the stored
// document too, since the save normalises what it posted.
func (s *Server) broadcastSettingsChanged(gs core.GlobalSettings) {
	s.broadcastToAll(map[string]any{
		"type":     "settings-changed",
		"settings": gs,
	})
}

// adoptExternalSettings re-reads the document and, when it differs from the one
// this process holds, takes it on and tells everything that was computed from the
// old one. Reports whether anything changed.
//
// Separate from the watcher that calls it because the watcher only decides WHEN:
// what adoption means is the part worth testing, and a filesystem event is a poor
// way to ask for it.
func (s *Server) adoptExternalSettings() bool {
	if s.settings == nil {
		return false
	}
	prev, next, changed := s.settings.reloadFromDisk()
	if !changed {
		return false
	}
	s.broadcastSettingsChanged(next)
	// Hidden models and per-model limits are not just stored settings: they are
	// folded into the provider list this server publishes — which carries the
	// hidden flag and the window every model menu shows — and into what the
	// default and cheap-model resolvers are allowed to pick. That list is computed
	// once and cached, so adopting the document without recomputing it would leave
	// this server stating the old flags to every client it has and to each new one
	// on connect. The same comparison handlePutSettings makes for its own writes.
	if !sameHiddenModels(prev.Models.Hidden, next.Models.Hidden) ||
		!sameModelLimits(prev.Models.Limits, next.Models.Limits) {
		s.RefreshProviders()
	}
	// The proxy is applied, not merely stored: it decides where this process's own
	// outbound requests go, and the atomic resolver means clients already built
	// pick it up on their next request. Storing it without applying it is the one
	// outcome worse than not syncing at all — every window this server feeds would
	// show a proxy the server itself is not using.
	if prev.Network.Proxy != next.Network.Proxy {
		httpx.SetConfig(httpx.Config{Mode: next.Network.Proxy.Mode, URL: next.Network.Proxy.URL})
	}
	// An update mode flipped on elsewhere is deliberately NOT kicked into an
	// immediate check here, though handlePutSettings kicks its own. A check reaches
	// the network and counts this install, and one machine runs a server per open
	// project: mirroring the kick would multiply both by the number of projects
	// open, for a toggle flipped once. The mode is read live from the store, so the
	// next scheduled poll already honours it.
	return true
}

// configEventAction is what a filesystem event in the config directory calls for.
type configEventAction struct {
	settings    bool // the settings document changed: adopt and publish it
	credentials bool // the credentials file changed: republish the provider list
}

// classifyConfigEvent decides what one filesystem event in the config directory
// calls for. Pure (no IO) so the decision is testable on its own.
//
// The directory holds more than the two documents — the lock files guarding them,
// and the temp files each save creates and renames away — so the great majority of
// events are of no interest.
func classifyConfigEvent(name string, op fsnotify.Op) configEventAction {
	if op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename) == 0 {
		return configEventAction{}
	}
	switch filepath.Base(name) {
	case filepath.Base(core.GlobalSettingsPath()):
		return configEventAction{settings: true}
	case filepath.Base(core.CredentialsPath()):
		return configEventAction{credentials: true}
	default:
		return configEventAction{}
	}
}

// startConfigWatcher watches the config directory for changes this process did not
// make to the two documents every project's server shares: the global settings and
// the credentials.
//
// A machine runs one server per open project, so the write a window must hear
// about is routinely one made by another project's server — or by a hand-edit of
// the file. This server's own writes need no help from here: handlePutSettings
// publishes what it changed, and by the time the resulting events arrive the
// in-memory document already matches the file, so the comparison finds nothing and
// nothing is announced twice. A credentials write is the same story through
// RefreshProviders.
//
// The directory is watched rather than the files: a save lands by renaming a temp
// file over the document, so a watch on a file itself would be left holding a
// replaced inode after the first write. One watcher covers both documents because
// they live in the same directory.
func (s *Server) startConfigWatcher() {
	if s.settings == nil {
		return
	}
	dir := filepath.Dir(core.GlobalSettingsPath())
	// The documents need not exist yet — the directory is what is watched, and
	// creating it is what makes the first save visible.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		jlog.Error("[ConfigWatcher] Couldn't create %s: %v", dir, err)
		return
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		jlog.Error("[ConfigWatcher] Couldn't create watcher: %v", err)
		return
	}
	if err := watcher.Add(dir); err != nil {
		jlog.Error("[ConfigWatcher] Couldn't watch %s: %v", dir, err)
		_ = watcher.Close()
		return
	}

	go func() {
		defer watcher.Close()
		// A fresh timer per event rather than Reset, so a tick that had already
		// fired and was never drained cannot deliver a stale reload. Which
		// documents moved is accumulated across the burst, so one save of each is
		// one reload of each.
		var (
			debounce <-chan time.Time
			timer    *time.Timer
			pending  configEventAction
		)
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				action := classifyConfigEvent(event.Name, event.Op)
				if !action.settings && !action.credentials {
					continue
				}
				pending.settings = pending.settings || action.settings
				pending.credentials = pending.credentials || action.credentials
				if timer != nil {
					timer.Stop()
				}
				timer = time.NewTimer(settingsReloadDebounce)
				debounce = timer.C

			case <-debounce:
				debounce, timer = nil, nil
				if pending.settings && s.adoptExternalSettings() {
					jlog.Info("[ConfigWatcher] Settings changed on disk")
				}
				if pending.credentials {
					// Keys, provider enable flags and the local-daemon hosts all live
					// here, and every one of them changes what the provider list says
					// is available. The credentials themselves are read from disk on
					// each use, so the computed list is the only thing holding a stale
					// answer.
					jlog.Info("[ConfigWatcher] Credentials changed on disk")
					s.RefreshProviders()
				}
				pending = configEventAction{}

			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				jlog.Error("[ConfigWatcher] Error: %v", err)

			case <-s.shutdownChan:
				return
			}
		}
	}()
}
