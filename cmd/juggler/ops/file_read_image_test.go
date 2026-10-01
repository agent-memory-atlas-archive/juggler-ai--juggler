//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// writeTestPNG encodes a tiny w×h PNG to path.
func writeTestPNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write png: %v", err)
	}
}

// TestLoadFileDetectsImage: a supported image within the size cap returns an
// isImage marker (mime, no text content, no warning) so the read tool can
// snapshot it for a multimodal model rather than reporting a binary file.
func TestLoadFileDetectsImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pic.png")
	writeTestPNG(t, path, 3, 2)

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isImage"] != true {
		t.Fatalf("expected isImage=true, got %#v", m)
	}
	if m["mime"] != "image/png" {
		t.Errorf("expected mime image/png, got %v", m["mime"])
	}
	if m["warning"] != nil {
		t.Errorf("image result must not carry a warning, got %v", m["warning"])
	}
	if m["exists"] != true {
		t.Errorf("expected exists=true, got %v", m["exists"])
	}
	// The bytes travel back as base64 so the read tool can upload them.
	b64, _ := m["imageBase64"].(string)
	if b64 == "" {
		t.Fatalf("expected non-empty imageBase64, got %#v", m)
	}
	if _, err := base64.StdEncoding.DecodeString(b64); err != nil {
		t.Errorf("imageBase64 is not valid base64: %v", err)
	}
}

// TestLoadFileOversizedImageReports: an image larger than the inline cap is not
// snapshotted (no isImage), and the op REPORTS it as a binary image of that size
// rather than issuing a verdict. The size limit belongs to the image viewer,
// whose own maxBytes declines the file and lands it on the no-viewer fallback.
func TestLoadFileOversizedImageReports(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.png")
	// Above the image cap but below MaxFileSize so ValidateFileSize still passes.
	if err := os.WriteFile(path, make([]byte, MaxImageReadBytes+1), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isImage"] == true {
		t.Errorf("oversized image must not be inlined: %#v", m)
	}
	if m["warning"] != nil {
		t.Errorf("the read op must not bake in a displayability verdict, got warning %v", m["warning"])
	}
	if m["isBinary"] != true {
		t.Errorf("expected isBinary=true, got %#v", m)
	}
	if m["mime"] != "image/png" {
		t.Errorf("expected mime image/png, got %v", m["mime"])
	}
	if m["size"] != int64(MaxImageReadBytes+1) {
		t.Errorf("expected the on-disk size to be reported, got %v", m["size"])
	}
}

// TestLoadFileBinaryReports: a binary file returns the observation (isBinary,
// mime, size) and no content — the browser's viewer registry decides whether
// anything can display it.
func TestLoadFileBinaryReports(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(path, []byte{0x00, 0x01, 0x02, 0x00, 0xff}, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isBinary"] != true {
		t.Errorf("expected isBinary=true, got %#v", m)
	}
	if m["warning"] != nil {
		t.Errorf("binary content must be reported, not judged, got warning %v", m["warning"])
	}
	if m["content"] != "" {
		t.Errorf("binary content must not be returned as text, got %v", m["content"])
	}
	if m["exists"] != true {
		t.Errorf("expected exists=true, got %v", m["exists"])
	}
}

// TestLoadFileLargeBinaryReports: the read op's size ceiling guards decoding a
// file as text, so a binary beyond it — a screen recording, a long audio take —
// is reported like any other binary rather than refused. Refusing it is what
// made a pinned video read as a file that does not exist.
func TestLoadFileLargeBinaryReports(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clip.mp4")
	// Truncate makes a sparse file of zero bytes: binary, and costs no disk.
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := f.Truncate(MaxFileSize + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	_ = f.Close()

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile refused a large binary: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isBinary"] != true || m["exists"] != true {
		t.Errorf("expected an existing binary, got %#v", m)
	}
	if m["mime"] != "video/mp4" {
		t.Errorf("expected mime video/mp4, got %v", m["mime"])
	}
	if m["size"] != int64(MaxFileSize+1) {
		t.Errorf("expected the on-disk size to be reported, got %v", m["size"])
	}
}

// TestLoadFileLargeTextRefused: the ceiling still holds for what it protects.
func TestLoadFileLargeTextRefused(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.log")
	if err := os.WriteFile(path, bytes.Repeat([]byte("line of text\n"), MaxFileSize/13+1), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	ops := NewFileOperations(NewPathScope(dir, nil))
	if _, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path}); err == nil {
		t.Fatal("expected a text file over MaxFileSize to be refused")
	}
}

// TestMimeForPath covers the general mime table used by the content route and
// reported on every read.
func TestMimeForPath(t *testing.T) {
	cases := map[string]string{
		"a.png":      "image/png",
		"doc.pdf":    "application/pdf",
		"notes.md":   "text/markdown",
		"app.js":     "text/javascript",
		"data.json":  "application/json",
		"styles.css": "text/css",
		"clip.mp4":   "video/mp4",
		"clip.MOV":   "video/quicktime",
		"clip.webm":  "video/webm",
		"song.mp3":   "audio/mpeg",
		"take.wav":   "audio/wav",
		"take.m4a":   "audio/mp4",
		"take.flac":  "audio/flac",
		"icon.bmp":   "image/bmp",
		"pic.avif":   "image/avif",
		"unknown.qq": "",
		"noext":      "",
	}
	for path, want := range cases {
		if got := MimeForPath(path); got != want {
			t.Errorf("MimeForPath(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestImageMimeForPath maps supported extensions and rejects others.
func TestImageMimeForPath(t *testing.T) {
	cases := map[string]string{
		"a.png":       "image/png",
		"b.JPG":       "image/jpeg",
		"c.jpeg":      "image/jpeg",
		"d.gif":       "image/gif",
		"e.webp":      "image/webp",
		"f.txt":       "",
		"g":           "",
		"dir/h.PNG":   "image/png",
		"weird.png.x": "",
	}
	for path, want := range cases {
		if got := ImageMimeForPath(path); got != want {
			t.Errorf("ImageMimeForPath(%q) = %q, want %q", path, got, want)
		}
	}
}
