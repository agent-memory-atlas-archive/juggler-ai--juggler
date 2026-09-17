//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"os"
	"runtime"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/tests/helpers"
)

// TestCommandInjectionShell ensures shell operations sanitize input and prevent injection
func TestCommandInjectionShell(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name        string
		command     string
		shouldError bool
		description string
	}{
		{
			name:        "Command with pipe injection",
			command:     "echo hello | rm -rf /",
			shouldError: true,
			description: "Pipe operator should be blocked or sanitized",
		},
		{
			name:        "Command with semicolon injection",
			command:     "echo hello; rm -rf /",
			shouldError: true,
			description: "Semicolon command separator should be blocked",
		},
		{
			name:        "Command with && injection",
			command:     "echo hello && rm -rf /",
			shouldError: true,
			description: "AND operator should be blocked",
		},
		{
			name:        "Command with || injection",
			command:     "echo hello || rm -rf /",
			shouldError: true,
			description: "OR operator should be blocked",
		},
		{
			name:        "Command with backtick injection",
			command:     "echo `rm -rf /`",
			shouldError: true,
			description: "Backtick command substitution should be blocked",
		},
		{
			name:        "Command with $() injection",
			command:     "echo $(rm -rf /)",
			shouldError: true,
			description: "Dollar-paren command substitution should be blocked",
		},
		{
			name:        "Command with newline injection",
			command:     "echo hello\nrm -rf /",
			shouldError: true,
			description: "Newline command separator should be blocked",
		},
		{
			name:        "Command with redirect injection",
			command:     "echo hello > /tmp/juggler-test-should-not-exist-12345",
			shouldError: false, // Redirect works but to a safe location
			description: "Output redirection to /tmp is allowed but should be monitored",
		},
		{
			name:        "Valid simple command",
			command:     "echo hello",
			shouldError: false,
			description: "Simple safe command should succeed",
		},
		{
			name:        "Valid command with arguments",
			command:     "ls -la",
			shouldError: false,
			description: "Command with safe arguments should succeed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"command": tt.command,
			}

			result, err := shellOps.Execute(context.Background(), "execute", params)

			if tt.shouldError {
				if err == nil {
					t.Errorf("%s: expected error but got none. Result: %v", tt.description, result)
					// Check if dangerous command actually executed
					if resultMap, ok := result.(map[string]any); ok {
						if output, ok := resultMap["output"].(string); ok && len(output) > 0 {
							t.Errorf("%s: dangerous command appears to have executed with output: %s", tt.description, output)
						}
					}
				}
			} else {
				if err != nil {
					t.Errorf("%s: expected no error but got: %v", tt.description, err)
				}
			}
		})
	}
}

// TestShellCommandWhitelist tests that dangerous commands either fail or are blocked
func TestShellCommandWhitelist(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	dangerousCommands := []struct {
		command     string
		description string
	}{
		{"rm -rf /", "Recursive delete"},
		{"dd if=/dev/zero of=/dev/sda bs=1M count=1", "Disk write attempt"},
		{":(){ :|:& };:", "Fork bomb"},
		{"chmod 777 /usr/bin/nonexistent", "Permission modification attempt"},
	}

	for _, tc := range dangerousCommands {
		t.Run(tc.description, func(t *testing.T) {
			params := map[string]any{
				"command": tc.command,
			}

			result, err := shellOps.Execute(context.Background(), "execute", params)

			// Command should either be blocked (error) or fail (success=false)
			if err == nil {
				// Command executed - check if it failed
				if resultMap, ok := result.(map[string]any); ok {
					if success, ok := resultMap["success"].(bool); ok && success {
						t.Errorf("Dangerous command '%s' should not succeed. Result: %v", tc.command, result)
					}
					// Command failed (success=false) - that's acceptable
					// The OS or shell prevented the dangerous operation
				}
			}
			// Command was blocked (err != nil) - that's also good
		})
	}
}

// TestShellEnvironmentIsolation ensures shell commands don't have access to sensitive env vars
func TestShellEnvironmentIsolation(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Set a sensitive environment variable
	os.Setenv("ANTHROPIC_API_KEY", "sk-test-secret-key-12345")
	defer os.Unsetenv("ANTHROPIC_API_KEY")

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	// Try to access the API key through shell command
	params := map[string]any{
		"command": "echo $ANTHROPIC_API_KEY",
	}

	result, err := shellOps.Execute(context.Background(), "execute", params)

	if err != nil {
		// If command is blocked entirely, that's fine
		return
	}

	// If command succeeded, check that API key was NOT leaked
	if resultMap, ok := result.(map[string]any); ok {
		if output, ok := resultMap["output"].(string); ok {
			if len(output) > 0 && output != "\n" && output != "" {
				t.Errorf("Sensitive environment variable leaked through shell command: %s", output)
			}
		}
	}
}

// TestNewlineNormalization ensures newlines in commands are normalized before execution
func TestNewlineNormalization(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test: Windows echo outputs \\r\\n and cmd.exe && semantics differ")
	}
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name             string
		command          string
		expectNormalized string
		expectOutput     string
	}{
		{
			name:             "newline between commands becomes &&",
			command:          "echo first\necho second",
			expectNormalized: "echo first && echo second",
			expectOutput:     "first\nsecond\n",
		},
		{
			name:             "multiple newlines collapsed",
			command:          "echo a\n\n\necho b",
			expectNormalized: "echo a && echo b",
			expectOutput:     "a\nb\n",
		},
		{
			name:             "no newlines left unchanged",
			command:          "echo hello",
			expectNormalized: "echo hello",
			expectOutput:     "hello\n",
		},
		{
			name:             "trailing newline stripped",
			command:          "echo hello\n",
			expectNormalized: "echo hello",
			expectOutput:     "hello\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := map[string]any{
				"command": tt.command,
			}

			result, err := shellOps.Execute(context.Background(), "execute", params)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			resultMap := result.(map[string]any)

			// The returned command should be the normalized version
			if got := resultMap["command"].(string); got != tt.expectNormalized {
				t.Errorf("command = %q, want %q", got, tt.expectNormalized)
			}

			// Output should reflect both commands running
			if got := resultMap["stdout"].(string); got != tt.expectOutput {
				t.Errorf("stdout = %q, want %q", got, tt.expectOutput)
			}
		})
	}
}

// TestNewlineNormalizationFailFast ensures && semantics: first failure stops execution
func TestNewlineNormalizationFailFast(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test")
	}

	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"command": "false\necho should-not-run",
	}

	result, err := shellOps.Execute(context.Background(), "execute", params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	resultMap := result.(map[string]any)

	// With && normalization, second command should NOT run
	if got := resultMap["stdout"].(string); got != "" {
		t.Errorf("expected no output (first cmd failed), got %q", got)
	}

	if resultMap["success"].(bool) {
		t.Error("expected failure (exit code != 0)")
	}
}

// TestShellTimeout ensures commands cannot run indefinitely
func TestShellTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		// On Windows, shell strings run through `wsl.exe -e sh`, but CI runners
		// have no WSL distro provisioned, so wsl.exe returns immediately instead
		// of running (or blocking) the command — nothing can time out. The
		// timeout itself is OS-agnostic Go (a select on time.After in
		// execute()), so the Unix run covers the mechanism fully.
		t.Skip("Requires a provisioned POSIX shell that can block; WSL has no distro on CI runners")
	}
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	shellOps := ops.NewShellOperations(ops.NewPathScope(projectDir, nil))

	// Command that blocks until the timeout fires. The string runs through a
	// POSIX shell (sh on Unix), so `sleep 1000` blocks indefinitely.
	params := map[string]any{
		"command": "sleep 1000",
		"timeout": float64(100), // 100ms timeout - must be float64 to match type assertion in shell_ops.go
	}

	_, err := shellOps.Execute(context.Background(), "execute", params)

	if err == nil {
		t.Error("Long-running command should timeout but did not")
	}
}
