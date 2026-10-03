//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"juggler/internal/binpath"
	"juggler/internal/jlog"
)

// launchDesktopApp opens the juggler-app desktop window pointed at serverURL.
// The server is windowless; the visible UI lives in this separate process.
// Used by the 'w' key and by a window-mode (icon/Finder) launch. devMode
// forwards --dev so a server in dev mode (--dev, or the implied dev mode of
// --assets-from-disk) gives its windows the web inspector and the full
// right-click menu.
func launchDesktopApp(serverURL string, devMode bool) error {
	appBin, err := appBinPath()
	if err != nil {
		return err
	}
	args := []string{"--url", serverURL}
	if devMode {
		args = append(args, "--dev")
	}
	jlog.Info("🪟 Opening desktop window → %s", serverURL)
	return launchDetached(appBin, args)
}

// appBinPath locates the juggler-app desktop binary:
//   - $JUGGLER_APP_BIN if set,
//   - a sibling "juggler-app" next to this executable (the installed layout),
//   - else "juggler-app" on PATH.
func appBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_APP_BIN"); env != "" {
		return env, nil
	}
	name := "juggler-app"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		if cand, ok := binpath.Sibling(exe, name); ok {
			return cand, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("could not locate the juggler-app binary; set JUGGLER_APP_BIN")
}

// spawnNewWindow launches a brand-new, fully independent juggler process in
// window mode. It backs the test-pool host's "New Window" menu item: each
// window is its own process by design — the server hosts a single project at a
// time (SwitchProject swaps global state), the hidden engine window is
// one-per-process, and the per-project instance lock plus auto-incrementing
// port (findAvailablePort) let N processes coexist. So "open another window" ==
// "start another instance".
//
// project is the folder the new window should open. When empty the new window
// starts in no-project mode and shows the picker overlay. The child is fully
// detached (no Wait, stdio to the null device) so this process can quit
// without taking the new window down with it.
//
// The actual launch is platform-specific (launchDetached): macOS must go
// through `open -n` to defeat LaunchServices single-instance activation;
// Windows and Linux exec the binary directly with detach flags.
func spawnNewWindow(project string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}

	// Always pass --window explicitly. The spawning process may itself have
	// been launched from a terminal (where window mode is opt-in), so we can't
	// rely on the icon-launch default to put the child in window mode.
	args := []string{"--window"}
	if project != "" {
		args = append(args, "--project", project)
	}

	jlog.Info("🪟 Launching new window (project=%q)", project)
	return launchDetached(exe, args)
}
