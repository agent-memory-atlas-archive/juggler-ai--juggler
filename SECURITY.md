# Security

Juggler is a local AI coding agent that runs as a web server on your machine.
This document describes its trust model and how to report vulnerabilities.

## Trust model

### Default (localhost-only)

The server always binds to all interfaces, but a LAN gate middleware rejects any
request from a non-loopback IP with 403 **by default, for every launch mode** —
whether the desktop app spawned the server or you ran `juggler` in a terminal.
Out of the box nothing off your machine can reach it. The browser UI is served
to you, the only user on the machine; there is no authentication because there
is no second user. The only trust assumption is the standard one for any local
development tool: anything running as your user on your machine can also connect.

### LAN access (opt-in, no authentication)

LAN exposure is never a silent default. You turn it on explicitly — by pressing
`p`+Enter in a terminal server, or launching with `--public` — after deciding
the network is trusted. Once on, the LAN gate accepts connections from
non-loopback addresses on the same network, and the server prints a banner (with
scannable QR codes) making the exposure obvious.

In LAN mode:

- **Any device on the network can use the agent.** There is still no
  authentication. Treat the URL the server prints as a capability — anyone
  who sees the QR code or types the address can drive the agent.
- The WebSocket upgrader rejects connections whose `Origin` header does not
  match the request `Host`. This stops a different web page the user (or a
  LAN peer) is browsing from opening a socket and silently driving the
  agent. Browser clients that omit `Origin` (or non-browser clients) are
  still allowed; the LAN gate is the primary access control.
- All shell execution, file writes, and other side-effecting tools still go
  through the **UI approval flow**. Tool calls do not run until you click
  approve in a connected browser. If you publish the URL, every connected
  client sees and can approve those prompts.

### WAN access (not in this build)

A build from this repository has no built-in WAN (internet) exposure mechanism
— its reach is localhost and, when you opt in, your LAN. The server does expose
a tunnel-mode registry seam through which a wrapping distribution can register
WAN transports (the official binaries do). Any transport registered through
that seam is subject to the same invariants this codebase enforces for remote
traffic: requests are tagged as remote ingress, admitted only as viewers, and
refused the in-process engine WebSocket role — a remote client can never claim
the engine slot, even though such traffic reaches the router over loopback.
The trust properties of any specific WAN mode are documented by the
distribution that ships it.

## What the agent can do

The agent can read and write files in the project directory and below; spawn
shell subprocesses with the privileges of the user running Juggler; and call
out to whichever LLM providers you have configured credentials for.

### Out-of-project file reads

When you @-mention an absolute path in the browser UI (e.g.
`@/etc/hosts`), the `userInitiated=true` flag is passed to the file-read
operation and the read is permitted even though the path is outside the
project directory. **This is by design** — it lets you point the agent at
config files and other context — but it does mean an LLM acting on your
behalf can be steered toward arbitrary readable files via a crafted
@-mention. Every such read is logged at INFO level for audit. The LLM
itself cannot bypass the project-directory check; only explicit user
@-mentions can.

### Shell execution

Shell commands run with the full privileges of the user running Juggler. The
server contains a tiny "obvious foot-gun" filter (`bestEffortShellSanityCheck`
in `cmd/juggler/ops/shell_command_parse.go`) that rejects a hard-coded list of
patterns like `rm -rf /`. **This is not a security control** — it is trivial
to bypass and exists only to catch accidental destructive copy-pastes. The
real safety net is the UI approval modal: every shell tool call surfaces to
the browser and waits for you to click approve.

### Credentials

Provider API keys live in `~/.juggler/credentials.json` (mode 0600 on
creation). Juggler never logs credential values. Be aware that any tool the
agent runs (a shell command, a file read) can see your environment and home
directory, including these credentials.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

- Email: julianstorer@gmail.com

Include a description, reproduction steps, and an indication of impact. We'll
acknowledge within a few days and coordinate a fix and disclosure timeline
with you.

## Supported versions

Only `main` is supported. There is no LTS or backport policy.
