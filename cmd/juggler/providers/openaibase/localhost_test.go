//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAutoDetectAcceptsSuccessfulErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"Unexpected endpoint or method."}`))
	}))
	defer server.Close()

	host := LocalHost{DefaultHost: server.URL, HealthPath: "/health"}
	if !host.AutoDetect()() {
		t.Fatal("AutoDetect rejected a 200 response with an error-shaped body")
	}
}

// A provider that must recognise its own server, not merely a listening port,
// sets ValidBody — and then a server answering 200 to everything, as LM Studio
// does, is not mistaken for it.
func TestAutoDetectValidatesBodyWhenAsked(t *testing.T) {
	body := `{"error":"Unexpected endpoint or method. (GET /.well-known/thing.json)"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	host := LocalHost{
		DefaultHost: server.URL,
		HealthPath:  "/.well-known/thing.json",
		ValidBody:   func(b []byte) bool { return strings.Contains(string(b), `"thing":true`) },
	}
	if host.AutoDetect()() {
		t.Fatal("AutoDetect accepted a 200 whose body ValidBody rejects")
	}
	body = `{"thing":true}`
	if !host.AutoDetect()() {
		t.Fatal("AutoDetect rejected a body ValidBody accepts")
	}
}

func TestNormaliseHost(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"bare host:port", "192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full http url", "http://192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"full https url", "https://ollama.lan:11434", "https://ollama.lan:11434"},
		{"trailing slash trimmed", "http://localhost:11434/", "http://localhost:11434"},
		{"surrounding whitespace", "  http://localhost:11434  ", "http://localhost:11434"},
		// Missing-`//` typo repair.
		{"http missing slashes", "http:192.168.1.70:11434", "http://192.168.1.70:11434"},
		{"https missing slashes", "https:ollama.lan:11434", "https://ollama.lan:11434"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormaliseHost(tc.in); got != tc.want {
				t.Errorf("NormaliseHost(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
