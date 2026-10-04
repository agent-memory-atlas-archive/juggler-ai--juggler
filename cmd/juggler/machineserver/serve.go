//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"
	"juggler/internal/userpaths"
)

// RunCommand runs `juggler serve` to completion and returns the process exit
// code. One machine server per machine, enforced by the flock under
// ~/.juggler/; a second invocation reports the running one and exits.
func RunCommand(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", 0, "Port for the machine server (0 = OS-assigned; the bound address is recorded in ~/.juggler/server.json)")
	verbose := fs.Bool("verbose", false, "Verbose logging (debug level)")
	fs.BoolVar(verbose, "v", false, "Verbose logging (debug level) (shorthand)")
	testChildren := fs.Bool("test", false, "Test harness only: spawn session children as test servers driven through this server's proxy")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	level := jlog.LevelInfo
	if *verbose {
		level = jlog.LevelDebug
	}
	jlog.Init(jlog.Options{
		ConsoleLevel: level,
		Colors:       true,
		Component:    "serve",
		MaxSizeMB:    10,
		MaxBackups:   5,
		LogFilePath:  filepath.Join(logpaths.LogDir(), "serve.log"),
	})
	defer jlog.Close()

	token := mintToken()
	lock := NewMachineLock(userpaths.ConfigDir())
	acquired, existing, err := lock.TryAcquire(core.Version, token)
	if err != nil {
		jlog.Error("serve: %v", err)
		return 1
	}
	if !acquired {
		if existing != nil {
			fmt.Fprintf(os.Stderr, "A machine server is already running: pid %d at %s (version %s).\n",
				existing.PID, existing.Addr, existing.Version)
		} else {
			fmt.Fprintln(os.Stderr, "A machine server is already running (holder unknown).")
		}
		return 1
	}
	defer func() {
		if err := lock.Release(); err != nil {
			jlog.Error("serve: failed to release machine lock: %v", err)
		}
	}()

	bin, err := childBinPath()
	if err != nil {
		jlog.Error("serve: %v", err)
		return 1
	}

	s := &Server{
		reg:          newRegistry(),
		lock:         lock,
		childBin:     bin,
		startedAt:    time.Now(),
		shutdownReq:  make(chan struct{}, 1),
		token:        token,
		testChildren: *testChildren,
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		jlog.Error("serve: listen: %v", err)
		return 1
	}
	s.addr = ln.Addr().String()
	if err := lock.UpdateAddr(s.addr); err != nil {
		jlog.Error("serve: failed to record server address: %v", err)
	}
	s.httpSrv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}

	// Same startup handshake as a session child, so anything that can read a
	// spawned juggler's address can read the machine server's too.
	fmt.Printf("JUGGLER_ADDR=%s\n", s.addr)
	jlog.Info("🚂 Machine server %s listening on http://%s/ (pid %d)", core.Version, s.addr, os.Getpid())

	errCh := make(chan error, 1)
	go func() { errCh <- s.httpSrv.Serve(ln) }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case got := <-sig:
		jlog.Info("serve: received %v — shutting down", got)
	case <-s.shutdownReq:
		jlog.Info("serve: shutdown requested via control API")
	case err := <-errCh:
		jlog.Error("serve: http server failed: %v", err)
		s.stopAllChildren()
		return 1
	}

	// Shutdown ordering per the supervisor contract: stop accepting, drain the
	// children, release the machine lock last (the deferred Release above).
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.httpSrv.Shutdown(ctx); err != nil {
		jlog.Error("serve: http shutdown: %v", err)
	}
	s.stopAllChildren()
	jlog.Info("serve: all sessions stopped — bye")
	return 0
}
