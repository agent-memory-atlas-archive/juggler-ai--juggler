//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Output truncation limits. A shell command can emit hundreds of megabytes
// (`yes`, a broken loop, `cat` of a huge file). Forwarding all of it floods the
// engine WebView with tens of thousands of WebSocket messages, wedges it for
// minutes, and starves every other command's delivery on the shared outbound
// channel — the "server lock-up" failure mode. The tool result keeps only the
// first outputHeadLimit bytes plus the last outputTailLimit bytes, so the
// important parts (initial context, final errors/summary) both survive within a
// small in-context budget. Head+tail mirrors the JS smartTruncate policy.
//
// When output grows past spillThreshold the retained head+tail can no longer
// reconstruct it, so the COMPLETE output is additionally written to a spill file
// under the project's .juggler/ directory (see spillFile) and the middle marker
// names that file. The model reads the dropped part back on demand with the
// `read` tool or bash grep/sed; the retained head+tail keep the result small.
const (
	outputHeadLimit = 32 * 1024
	outputTailLimit = 64 * 1024
)

const (
	spillFileLimit = 64 << 20                          // 64 MiB on-disk cap per spill file
	spillThreshold = outputHeadLimit + outputTailLimit // bytes past which a middle is genuinely dropped
)

// truncationMarker is the inline notice stitched between the retained head and
// tail when output was dropped. When relPath is non-empty it points the reader
// at the complete spill file; fileTruncated notes the spill file itself hit its
// cap so the very end of a huge stream is not on disk either.
func truncationMarker(omitted, total int64, relPath string, fileTruncated bool) string {
	if relPath == "" {
		return fmt.Sprintf("\n\n… [output truncated: %d bytes omitted] …\n\n", omitted)
	}
	msg := fmt.Sprintf("\n\n… [output truncated: %d of %d bytes omitted. "+
		"FULL output saved to %s — read a range with the `read` tool (offset/limit) "+
		"or grep/sed it via bash.", omitted, total, relPath)
	if fileTruncated {
		notSaved := total - spillFileLimit
		if notSaved < 0 {
			notSaved = 0
		}
		msg += fmt.Sprintf(" [full output truncated to first %d MiB; %d more bytes were produced but not saved]",
			spillFileLimit>>20, notSaved)
	}
	msg += "] …\n\n"
	return msg
}

// spillFile lazily writes the COMPLETE output of one command to disk, but only
// once the output crosses spillThreshold (i.e. once head+tail can no longer
// reconstruct it). Below the threshold nothing touches disk. A spill I/O error
// is swallowed (failed=true) and never propagates — the command still succeeds
// and degrades to the plain head+tail marker.
type spillFile struct {
	dir, id  string
	pending  []byte // buffered prefix held until spillThreshold is crossed
	total    int64  // total bytes teed in (the complete output length)
	f        *os.File
	w        *bufio.Writer
	written  int64
	overflow bool // hit spillFileLimit
	failed   bool // I/O error → spill disabled for the rest of this command
}

// newSpillFile returns a spill target that does no I/O until the output crosses
// spillThreshold. The <id>.log file is created under dir on that crossing.
func newSpillFile(dir, id string) *spillFile {
	return &spillFile{dir: dir, id: id}
}

// write tees every byte in stream order. It buffers in memory until
// spillThreshold is crossed, then opens the file and flushes; once open it
// writes directly, enforcing spillFileLimit. Any I/O error disables the spill
// for the rest of the command.
func (s *spillFile) write(p []byte) {
	if s == nil || s.failed {
		return
	}
	s.total += int64(len(p))
	if s.f == nil {
		s.pending = append(s.pending, p...)
		if s.total <= spillThreshold {
			return
		}
		// Crossing the threshold: a middle is now genuinely dropped, so
		// materialize the file and flush the buffered prefix.
		if err := os.MkdirAll(s.dir, 0o755); err != nil {
			s.fail()
			return
		}
		f, err := os.Create(filepath.Join(s.dir, s.id+".log"))
		if err != nil {
			s.fail()
			return
		}
		s.f = f
		s.w = bufio.NewWriter(f)
		pending := s.pending
		s.pending = nil
		s.writeToFile(pending)
		return
	}
	s.writeToFile(p)
}

// writeToFile writes p to the open file, capping the total on-disk size at
// spillFileLimit and recording overflow when the cap is reached.
func (s *spillFile) writeToFile(p []byte) {
	if s.overflow {
		return
	}
	if s.written+int64(len(p)) > spillFileLimit {
		room := spillFileLimit - s.written
		if room < 0 {
			room = 0
		}
		p = p[:room]
		s.overflow = true
	}
	if len(p) == 0 {
		return
	}
	n, err := s.w.Write(p)
	s.written += int64(n)
	if err != nil {
		s.fail()
	}
}

// fail disables the spill and closes any open file, discarding buffered bytes.
func (s *spillFile) fail() {
	s.failed = true
	if s.f != nil {
		_ = s.w.Flush()
		_ = s.f.Close()
		s.f = nil
	}
	s.pending = nil
}

// close flushes and closes the file. It returns the absolute path (empty when
// the file was never opened or a write failed), the complete output byte count,
// and whether the on-disk file hit spillFileLimit. Safe on a nil receiver.
func (s *spillFile) close() (path string, bytes int64, truncated bool) {
	if s == nil || s.f == nil {
		return "", 0, false
	}
	flushErr := s.w.Flush()
	closeErr := s.f.Close()
	s.f = nil
	if flushErr != nil || closeErr != nil {
		return "", 0, false
	}
	return filepath.Join(s.dir, s.id+".log"), s.total, s.overflow
}

// spillState is shared bookkeeping for a cap type that tees its full stream to
// an optional spillFile. Embedded in cappedBuffer and cappedForwarder so both
// get identical spill accounting. A nil spill (the default) is a no-op: callers
// that never attach one behave byte-identically to a plain head+tail cap.
type spillState struct {
	spill        *spillFile
	root         string // the working directory the spill path is rendered relative to (the workspace's, when the command ran in one)
	spillClosed  bool
	spillPathAbs string
	spillBytesN  int64
	spillTrunc   bool
}

// attachSpill routes the full stream into sf, rendering its path relative to root.
func (s *spillState) attachSpill(root string, sf *spillFile) {
	s.root = root
	s.spill = sf
}

// teeSpill forwards p to the spill file (a no-op when none is attached).
func (s *spillState) teeSpill(p []byte) {
	if s.spill != nil {
		s.spill.write(p)
	}
}

// closeSpill flushes and closes the spill file, caching the result. Idempotent;
// must be called only after the writer goroutine has finished (happens-before).
func (s *spillState) closeSpill() {
	if s.spillClosed {
		return
	}
	s.spillClosed = true
	if s.spill != nil {
		s.spillPathAbs, s.spillBytesN, s.spillTrunc = s.spill.close()
	}
}

// spilled reports whether a complete spill file was written.
func (s *spillState) spilled() bool { s.closeSpill(); return s.spillPathAbs != "" }

// spillPath returns the absolute spill-file path, or "" when nothing spilled.
func (s *spillState) spillPath() string { s.closeSpill(); return s.spillPathAbs }

// spillBytes returns the complete output byte count when spilled, else 0.
func (s *spillState) spillBytes() int64 { s.closeSpill(); return s.spillBytesN }

// relSpillPath renders the spill path relative to the working directory for the
// in-band marker (shorter, and `read` resolves it fine). Falls back to the
// absolute path if a relative form can't be computed.
//
// Relative to the WORKING directory rather than the project, because that is
// what the model's paths mean: a command run in a workspace gets a path back
// out of it (`../project/.juggler/…`), which is where the spill actually is and
// which the read tool resolves, the project being in scope for reads.
func (s *spillState) relSpillPath() string {
	if s.spillPathAbs == "" {
		return ""
	}
	if s.root != "" {
		if rel, err := filepath.Rel(s.root, s.spillPathAbs); err == nil {
			return rel
		}
	}
	return s.spillPathAbs
}

// tailRing keeps the last `size` bytes written to it, discarding older bytes in
// O(1) amortised per write via a fixed circular buffer. Used to retain the tail
// of an over-long stream without buffering the whole thing.
type tailRing struct {
	buf  []byte
	size int
	pos  int  // next write index
	full bool // whether buf has wrapped at least once
}

func newTailRing(size int) *tailRing {
	if size < 0 {
		size = 0
	}
	return &tailRing{buf: make([]byte, size), size: size}
}

// write appends p, keeping only the most recent `size` bytes.
func (t *tailRing) write(p []byte) {
	if t.size == 0 {
		return
	}
	// If p alone overfills the ring, only its own tail matters.
	if len(p) >= t.size {
		copy(t.buf, p[len(p)-t.size:])
		t.pos = 0
		t.full = true
		return
	}
	n := copy(t.buf[t.pos:], p)
	if n < len(p) {
		// Wrapped around the end of the buffer.
		copy(t.buf, p[n:])
		t.pos = len(p) - n
		t.full = true
	} else {
		t.pos += n
		if t.pos == t.size {
			t.pos = 0
			t.full = true
		}
	}
}

// bytes returns the retained tail in write order.
func (t *tailRing) bytes() []byte {
	if !t.full {
		return append([]byte(nil), t.buf[:t.pos]...)
	}
	out := make([]byte, t.size)
	n := copy(out, t.buf[t.pos:])
	copy(out[n:], t.buf[:t.pos])
	return out
}

// cappedBuffer is an io.Writer that accumulates output but retains only the
// first headLimit bytes and the last tailLimit bytes, so a runaway command
// can't exhaust memory. It is a drop-in replacement for *bytes.Buffer on the
// non-streaming execution paths: Write never errors and String() stitches the
// retained head, a truncation marker, and the retained tail.
type cappedBuffer struct {
	spillState
	head      []byte
	headLimit int
	tail      *tailRing
	total     int64
	truncated bool
}

func newCappedBuffer(headLimit, tailLimit int) *cappedBuffer {
	return &cappedBuffer{headLimit: headLimit, tail: newTailRing(tailLimit)}
}

// withSpill routes the complete output to sf (rendered relative to root) and
// returns the receiver for chaining. A nil sf leaves the buffer a plain cap.
func (b *cappedBuffer) withSpill(root string, sf *spillFile) *cappedBuffer {
	b.attachSpill(root, sf)
	return b
}

// Write implements io.Writer. It always consumes all of p.
func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.teeSpill(p)
	b.total += int64(len(p))
	if len(b.head) < b.headLimit {
		room := b.headLimit - len(b.head)
		if len(p) <= room {
			b.head = append(b.head, p...)
			return len(p), nil
		}
		b.head = append(b.head, p[:room]...)
		b.truncated = true
		b.tail.write(p[room:])
		return len(p), nil
	}
	b.truncated = true
	b.tail.write(p)
	return len(p), nil
}

// String returns the retained output, with a marker in place of the dropped
// middle when bytes were genuinely dropped. In the (headLimit, spillThreshold]
// band the head+tail reconstruct the whole stream (omitted == 0), so no marker
// is emitted. When a spill file exists the marker names it and a trailer repeats
// the path after the tail (so it survives head eviction downstream).
func (b *cappedBuffer) String() string {
	b.closeSpill()
	if !b.truncated {
		return string(b.head)
	}
	tail := b.tail.bytes()
	omitted := b.total - int64(len(b.head)) - int64(len(tail))
	if omitted < 0 {
		omitted = 0
	}
	if omitted == 0 {
		return string(b.head) + string(tail)
	}
	relPath := b.relSpillPath()
	out := string(b.head) + truncationMarker(omitted, b.total, relPath, b.spillTrunc) + string(tail)
	if relPath != "" {
		out += fmt.Sprintf("\n[full output: %s]", relPath)
	}
	return out
}

// cappedForwarder streams a byte source to a sink live, but only up to
// headLimit bytes; past that it stops forwarding, retains just the last
// tailLimit bytes in a ring, and drops the middle — the same head+tail policy
// as cappedBuffer, but pushing to a sink instead of accumulating for String().
// It also stitches UTF-8 runes split across reads (see utf8SafeChunk) so the
// sink never receives an invalid half.
//
// Concurrency: drain() mutates the counters and ring, so it must run on a
// single goroutine; suffix() reads them and may only be called after that
// goroutine has returned (a happens-before edge — e.g. a WaitGroup join or a
// done channel receive).
type cappedForwarder struct {
	spillState
	headLimit int64
	sink      func(string)
	tail      *tailRing
	headBytes int64
	totalRead int64
	truncated bool
}

func newCappedForwarder(headLimit, tailLimit int, sink func(string)) *cappedForwarder {
	return &cappedForwarder{
		headLimit: int64(headLimit),
		sink:      sink,
		tail:      newTailRing(tailLimit),
	}
}

// withSpill routes the complete stream to sf (rendered relative to root) and
// returns the receiver for chaining. A nil sf leaves the forwarder a plain cap.
func (f *cappedForwarder) withSpill(root string, sf *spillFile) *cappedForwarder {
	f.attachSpill(root, sf)
	return f
}

// forward pushes emit through the head/tail cap: live to the sink while under
// headLimit, into the tail ring once over it.
func (f *cappedForwarder) forward(emit []byte) {
	if len(emit) == 0 {
		return
	}
	f.teeSpill(emit)
	f.totalRead += int64(len(emit))
	if f.headBytes < f.headLimit {
		room := int(f.headLimit - f.headBytes)
		if len(emit) <= room {
			f.sink(string(emit))
			f.headBytes += int64(len(emit))
			return
		}
		// Straddles the head limit: forward the head portion, retain the rest.
		f.sink(string(emit[:room]))
		f.headBytes += int64(room)
		f.truncated = true
		f.tail.write(emit[room:])
		return
	}
	f.truncated = true
	f.tail.write(emit)
}

// drain reads r to EOF in 4 KiB reads, forwarding UTF-8-safe chunks to the
// sink. If onFirstByte is non-nil it is invoked on each read that yields bytes
// (callers pass an idempotent signal to learn when output first appears).
func (f *cappedForwarder) drain(r io.Reader, onFirstByte func()) {
	reader := bufio.NewReader(r)
	buf := make([]byte, 4096)
	// carry holds the trailing bytes of a multi-byte UTF-8 rune split across two
	// reads; utf8SafeChunk prepends it to the next read so we never forward an
	// invalid half (which would render as U+FFFD).
	var carry []byte
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			if onFirstByte != nil {
				onFirstByte()
			}
			var emit []byte
			emit, carry = utf8SafeChunk(carry, buf[:n], false)
			f.forward(emit)
		}
		if err != nil {
			break
		}
	}
	f.forward(carry) // flush any trailing partial rune left when the stream ended
}

// suffix returns the dropped-middle marker plus the retained tail, or "" when
// the head alone covered the stream. In the (headLimit, spillThreshold] band
// nothing is dropped (omitted == 0): the streamed head plus this retained tail
// reconstruct the whole stream, so no marker is emitted. When a spill file
// exists the marker names it and a trailer repeats the path after the tail. Call
// only after drain() has returned (see the concurrency note on cappedForwarder).
func (f *cappedForwarder) suffix() string {
	f.closeSpill()
	if !f.truncated {
		return ""
	}
	tailBytes := f.tail.bytes()
	omitted := f.totalRead - f.headBytes - int64(len(tailBytes))
	if omitted < 0 {
		omitted = 0
	}
	if omitted == 0 {
		return string(tailBytes)
	}
	relPath := f.relSpillPath()
	out := truncationMarker(omitted, f.totalRead, relPath, f.spillTrunc) + string(tailBytes)
	if relPath != "" {
		out += fmt.Sprintf("\n[full output: %s]", relPath)
	}
	return out
}

// utf8SafeChunk splits a freshly-read chunk (cur), prepended with any bytes
// carried from the previous read (prev), into the portion that ends on a UTF-8
// rune boundary (emit) and the trailing bytes of an incomplete multi-byte rune
// to carry into the next read (carry).
//
// Streaming readers read into fixed 4096-byte buffers, so a multi-byte rune
// (emoji, CJK, accented text) can straddle a read boundary. Forwarding each
// half independently is lossy: each is invalid UTF-8 on its own, and Go's
// json.Marshal replaces every invalid byte with U+FFFD before the frontend can
// rejoin them — visible corruption even for perfectly valid UTF-8 output.
// Holding the trailing partial rune back until the next read fixes this.
//
// When atEOF is true there is no next read (the stream has ended), so a
// genuinely-truncated trailing sequence is returned as emit rather than held.
// The returned carry is always freshly allocated, so callers may reuse cur's
// backing buffer immediately.
func utf8SafeChunk(prev, cur []byte, atEOF bool) (emit, carry []byte) {
	combined := cur
	if len(prev) > 0 {
		combined = append(append([]byte(nil), prev...), cur...)
	}
	if atEOF {
		return combined, nil
	}
	validLen := findLastCompleteUTF8(combined)
	if validLen >= len(combined) {
		return combined, nil
	}
	return combined[:validLen], append([]byte(nil), combined[validLen:]...)
}
