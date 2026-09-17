//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"fmt"
	"regexp"
	"strings"
)

// normalizeCommandNewlines replaces bare newlines used as command separators
// with " && " for consistent display/logging and fail-fast semantics.
// Empty lines are dropped; commands without newlines pass through unchanged.
//
// Only newlines that act as top-level command separators are rewritten. A
// newline that lives inside a quote ('...', "...", `...`), a here-document
// body, or after a backslash line-continuation is DATA, not a separator, and is
// preserved verbatim — so a single multi-line command (a multi-line git commit
// message, a `python3 -c '...'` script, a heredoc) survives intact instead of
// being shredded into broken " && " fragments.
//
// " && " joining is only valid between standalone simple commands. When any
// segment is a comment, a shell control-flow construct (for/while/if/case,
// their do/then/in/else/fi/done/esac keywords, function bodies, { } grouping),
// or ends in a continuation operator, inserting " && " would produce broken
// shell — e.g. `for f in a b c; && do`. In that case the command is left
// verbatim: sh -c runs the multi-line form correctly, so we forgo the cosmetic
// single-line join rather than corrupt the command.
func normalizeCommandNewlines(command string) string {
	if !strings.Contains(command, "\n") {
		return command
	}

	var nonEmpty []string
	for _, seg := range splitTopLevelCommands(command) {
		if trimmed := strings.TrimSpace(seg); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	if !canJoinWithAnd(nonEmpty) {
		return command
	}
	return strings.Join(nonEmpty, " && ")
}

// compoundKeywords are reserved words that open, continue, or close a shell
// compound command. A segment whose first word is one of these (or a bare block
// delimiter) is part of a multi-line construct, not a standalone command, so the
// segment list must not be " && "-joined.
var compoundKeywords = map[string]bool{
	"for": true, "while": true, "until": true, "do": true, "done": true,
	"if": true, "then": true, "elif": true, "else": true, "fi": true,
	"case": true, "esac": true, "select": true, "function": true,
	"{": true, "}": true, "(": true, ")": true,
}

// trailingContinuations are tokens that, as the last word of a line, mean the
// command continues on the following line. Splicing " && " onto such a line
// (`... in && a) echo`, `... && | tail`) is invalid shell.
var trailingContinuations = map[string]bool{
	"do": true, "then": true, "else": true, "in": true,
	"{": true, "(": true, "|": true, "||": true, "&&": true, "&": true,
}

// canJoinWithAnd reports whether the segments (already trimmed, non-empty) are
// all standalone simple commands and can therefore be safely joined with " && ".
// A single segment is always joinable (nothing is spliced). It returns false the
// moment any segment looks like a comment or part of a compound command, so the
// caller falls back to running the command verbatim.
func canJoinWithAnd(segments []string) bool {
	if len(segments) < 2 {
		return true
	}
	for _, s := range segments {
		if hasUnquotedComment(s) {
			return false
		}
		// A segment opening with a continuation operator is only valid as the
		// tail of the previous physical line; the newline separator already broke
		// that, so `echo a && | grep x` / `... && && echo b` are syntax errors.
		switch s[0] {
		case '|', '&', ';':
			return false
		}
		// A bare trailing `;` is a command separator: splicing " && " after it
		// (`echo a; && echo b`) is a syntax error. An escaped `\;` (a find -exec
		// terminator) is a literal argument, not a separator, so it joins fine.
		if s[len(s)-1] == ';' && !strings.HasSuffix(s, "\\;") {
			return false
		}
		fields := strings.Fields(s)
		if len(fields) == 0 {
			continue
		}
		if compoundKeywords[strings.TrimSuffix(fields[0], ";")] {
			return false
		}
		if trailingContinuations[fields[len(fields)-1]] {
			return false
		}
		switch s[len(s)-1] {
		case '|', '&', '{', '(':
			return false
		}
	}
	return true
}

// hasUnquotedComment reports whether s contains a `#` that begins a shell
// comment — one at the start of a word (start of string or after whitespace)
// and outside any quote. Splicing " && " after such a segment would land the
// operator inside the comment, silently discarding every later command. `#`
// inside quotes or mid-word (a fragment identifier, `$#`) is not a comment.
func hasUnquotedComment(s string) bool {
	var quote byte // 0, '\'', '"', or '`'
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if quote == '\'' {
				if c == '\'' {
					quote = 0
				}
			} else if c == '\\' && i+1 < len(s) {
				i++
			} else if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"', '`':
			quote = c
		case '\\':
			i++
		case '#':
			if i == 0 || s[i-1] == ' ' || s[i-1] == '\t' || s[i-1] == '\n' {
				return true
			}
		}
	}
	return false
}

// heredocSpec is a pending here-document whose body has not been consumed yet.
type heredocSpec struct {
	delim     string
	stripTabs bool // <<- form: leading tabs are stripped when matching the terminator
}

// splitTopLevelCommands splits command on the newlines that act as shell command
// separators, while preserving every newline that lives inside a quote, backtick
// substitution, here-document body, or a backslash line-continuation. Each
// returned element is one top-level command exactly as written (internal
// newlines intact). This is a lexical scan, not a full shell parser — but it is
// conservative: when in doubt it keeps text together, so a misjudged newline
// degrades to the shell's own sequential semantics rather than corrupting the
// command.
func splitTopLevelCommands(command string) []string {
	var (
		segments []string
		buf      strings.Builder
		quote    byte // 0, '\'', '"', or '`'
		heredocs []heredocSpec
	)
	n := len(command)
	for i := 0; i < n; i++ {
		c := command[i]

		// Inside a quote: copy verbatim until the matching close.
		if quote != 0 {
			buf.WriteByte(c)
			if quote == '\'' {
				if c == '\'' {
					quote = 0
				}
			} else { // '"' or '`': a backslash escapes the next byte
				if c == '\\' && i+1 < n {
					buf.WriteByte(command[i+1])
					i++
				} else if c == quote {
					quote = 0
				}
			}
			continue
		}

		switch c {
		case '\'', '"', '`':
			quote = c
			buf.WriteByte(c)
		case '\\':
			// Backslash escapes the next byte, including a newline used as a line
			// continuation — keep both verbatim, in the same command.
			buf.WriteByte(c)
			if i+1 < n {
				buf.WriteByte(command[i+1])
				i++
			}
		case '<':
			if i+1 < n && command[i+1] == '<' {
				if i+2 < n && command[i+2] == '<' {
					// here-string (<<<), a single-line redirect — not a heredoc.
					buf.WriteString("<<<")
					i += 2
					break
				}
				// here-document: << or <<-. Record its delimiter; the body is
				// consumed when we reach the newline that starts it.
				buf.WriteString("<<")
				i += 2
				strip := false
				if i < n && command[i] == '-' {
					strip = true
					buf.WriteByte('-')
					i++
				}
				for i < n && (command[i] == ' ' || command[i] == '\t') {
					buf.WriteByte(command[i])
					i++
				}
				delim, adv := readHeredocDelim(command[i:])
				buf.WriteString(command[i : i+adv])
				i += adv - 1 // -1: the outer loop's i++ steps to the next byte
				if delim != "" {
					heredocs = append(heredocs, heredocSpec{delim: delim, stripTabs: strip})
				}
			} else {
				buf.WriteByte(c)
			}
		case '\n':
			if len(heredocs) > 0 {
				// This newline begins the pending here-doc bodies; consume them
				// (internal newlines and all) rather than splitting here.
				buf.WriteByte(c)
				i = consumeHeredocs(command, i+1, heredocs, &buf) - 1
				heredocs = heredocs[:0]
			} else {
				segments = append(segments, buf.String())
				buf.Reset()
			}
		default:
			buf.WriteByte(c)
		}
	}
	segments = append(segments, buf.String())
	return segments
}

// readHeredocDelim reads a here-document delimiter word from the start of s,
// returning the delimiter (quotes removed) and the number of bytes consumed
// (quotes included). A quoted delimiter (<<'EOF') is matched literally.
func readHeredocDelim(s string) (string, int) {
	if s == "" {
		return "", 0
	}
	if s[0] == '\'' || s[0] == '"' {
		q := s[0]
		for j := 1; j < len(s); j++ {
			if s[j] == q {
				return s[1:j], j + 1
			}
		}
		return s[1:], len(s) // unterminated quote: take the rest
	}
	j := 0
	for j < len(s) && isHeredocDelimByte(s[j]) {
		j++
	}
	return s[:j], j
}

func isHeredocDelimByte(b byte) bool {
	return b == '_' || b == '-' || b == '.' ||
		(b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// consumeHeredocs appends the bodies of the pending here-documents (starting at
// index i, the first body byte) to buf and returns the index just past the last
// terminator word — leaving the newline that follows it for the caller to treat
// as a normal command separator. Body text, terminator lines and their internal
// newlines are copied verbatim.
func consumeHeredocs(s string, i int, specs []heredocSpec, buf *strings.Builder) int {
	n := len(s)
	for si, spec := range specs {
		// Bodies of stacked heredocs on one line are back-to-back: step over the
		// newline that ended the previous terminator before reading the next.
		if si > 0 && i < n && s[i] == '\n' {
			buf.WriteByte('\n')
			i++
		}
		for i < n {
			lineEnd := i
			for lineEnd < n && s[lineEnd] != '\n' {
				lineEnd++
			}
			line := s[i:lineEnd]
			cmp := line
			if spec.stripTabs {
				cmp = strings.TrimLeft(cmp, "\t")
			}
			if cmp == spec.delim {
				buf.WriteString(line) // terminator line, without its trailing newline
				i = lineEnd
				break
			}
			if lineEnd < n {
				buf.WriteString(s[i : lineEnd+1]) // body line incl. newline
				i = lineEnd + 1
			} else {
				buf.WriteString(line) // final line, no trailing newline
				i = lineEnd
			}
		}
	}
	return i
}

// Foot-gun patterns for bestEffortShellSanityCheck, each paired with the
// reason reported to the caller. Every pattern is deliberately narrow: the
// filter gates every shell execution, so one that also matches an everyday
// command (`rm -rf /tmp/build`, `2> /dev/null`) costs far more than the
// accident it catches.
var shellFootGuns = []struct {
	re     *regexp.Regexp
	reason string
}{
	// An `rm` whose target is the filesystem root — `/` or `/*`, optionally
	// quoted — with any flags before or after it. The trailing boundary is
	// what keeps `/tmp/...` and every other absolute path out.
	{regexp.MustCompile(
		"(?i)(?:^|[\\s;&|(`])(?:sudo\\s+)?rm(?:\\s+-\\S+)*\\s+[\"']?/\\*?[\"']?(?:[\\s;&|)`]|$)"),
		"rm -rf /"},

	// Redirecting or `dd`-ing onto a raw block device. Reading one
	// (`ls -l /dev/sda`) is harmless and stays allowed, as does the far more
	// common `> /dev/null`.
	{regexp.MustCompile(`(?i)(?:>\s*|\bof=)/dev/r?(?:sd|hd|vd|nvme|disk)`),
		"write to a raw disk device"},

	{regexp.MustCompile(`(?i)\bmkfs(?:\.\w+)?\b`), "mkfs"},
	{regexp.MustCompile(`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`), "fork bomb"},
}

// bestEffortShellSanityCheck rejects empty / oversized commands and a tiny
// hand-coded list of obviously-destructive patterns. It is NOT a security
// boundary — a determined caller can trivially bypass it (`rm -rf $(pwd)`
// etc.). The real safety net is the UI approval flow that gates every shell
// execution. Treat this as a typo / accidental-foot-gun filter only.
func bestEffortShellSanityCheck(command string) error {
	// Check for empty command
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("command cannot be empty")
	}

	// Length cap of 10000 supports SWE-bench tests with many test paths.
	const maxCommandLength = 10000
	if len(command) > maxCommandLength {
		return fmt.Errorf("command exceeds maximum length of %d characters", maxCommandLength)
	}

	// Reject a tiny set of obviously-destructive patterns. This is a
	// foot-gun filter, not a security control — bypass is trivial.
	for _, fg := range shellFootGuns {
		if fg.re.MatchString(command) {
			return fmt.Errorf("command contains dangerous pattern: %s", fg.reason)
		}
	}

	return nil
}
