//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

// UnusableOutputError reports a turn the provider abandoned because the model's
// output could not be acted on, when sending the identical request again is
// expected to produce a usable one.
//
// It is neither a transport failure nor a refusal: the request reached the model
// and was answered, but the answer went somewhere nothing could follow — tool
// calls to names the session does not serve, say — and the model did not find
// its own way back. Another sample of the same request usually does, so a
// caller retries it as it would a dropped connection. Whatever the abandoned
// attempt already streamed stays where it landed; only the turn's result is
// discarded.
type UnusableOutputError struct {
	// Message says what was wrong with the output, for the log and for the user
	// if every retry fails the same way.
	Message string

	// Cause is the underlying error, if any, preserved so callers can still
	// match on it.
	Cause error
}

func (e *UnusableOutputError) Error() string { return e.Message }
func (e *UnusableOutputError) Unwrap() error { return e.Cause }
