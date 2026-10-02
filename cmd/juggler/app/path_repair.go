//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

// pathRepairReport is what repairPathForGUILaunch has to say for the log, or ""
// when there is nothing to report. The repair runs before logging is set up —
// it must precede every child process — so it leaves its account here and
// initLogging writes it once there is a log to write to. Set once, before any
// goroutine starts, and only read after.
var pathRepairReport string
