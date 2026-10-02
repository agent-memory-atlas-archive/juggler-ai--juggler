//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import "fmt"

// SetupError reports a provider that cannot run on this machine as it stands:
// something it depends on — a CLI it drives, say — is not installed, or not
// where Juggler can find it.
//
// It is AuthError's sibling and shares its shape: a terminal failure the user
// can fix, whose remediation only the provider can word. It differs in what the
// user should be offered. An expired sign-in is fixed where the provider lives;
// a missing install is just as often answered by choosing a different model, and
// a first-time user who has never installed it needs to hear that it is optional.
//
// Producing one is a claim that nothing was attempted against the provider, so
// raise it only when the prerequisite is demonstrably absent.
type SetupError struct {
	// Provider is the registry name of the provider that cannot run, e.g.
	// "claudecode".
	Provider string

	// Message is the technical account — what was looked for and where. Kept
	// verbatim beneath the hint because it is the diagnosable part.
	Message string

	// Hint is the remediation, phrased for the person reading the transcript.
	Hint string
}

func (e *SetupError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("%s is not set up on this machine", e.Provider)
}

// Retryable marks this terminal for generic classifiers: asking again changes
// nothing until a human installs or points at the missing piece.
func (e *SetupError) Retryable() bool { return false }
