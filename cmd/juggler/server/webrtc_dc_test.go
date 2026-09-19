//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/pion/webrtc/v4"
)

// TestHTTPOverDataChannelEndToEnd exercises the shared WebRTC core end to end
// with a real pion guest peer: acceptWebRTCOffer answers the offer, the
// "juggler" DataChannel opens, and an http-over-DC request for /api/version is
// dispatched through the real router — with the LAN gate engaged (public mode
// OFF) the whole time, proving DataChannel ingress is admitted by its
// remote-ingress tag while ordinary remote requests are not. This is the same
// transport every WAN tunnel mode registered through the tunnel-mode registry
// rides, so the security-relevant path stays covered with no modes registered.
func TestHTTPOverDataChannelEndToEnd(t *testing.T) {
	// Host: hub + viewer group so the realtime loop (started on DC open) runs,
	// a router with the LAN gate, and /api/version registered.
	s := newTestServerState(t)
	s.router = mux.NewRouter()
	s.router.Use(s.lanGateMiddleware)
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/version", s.handleVersion).Methods(http.MethodGet)

	// --- GUEST side: real pion peer connection. ---
	// Empty ICE servers -> prefer loopback/LAN host candidates, no STUN round
	// trip needed for an in-process peer.
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("guest NewPeerConnection: %v", err)
	}
	defer func() { _ = pc.Close() }()

	dc, err := pc.CreateDataChannel("juggler", nil)
	if err != nil {
		t.Fatalf("guest CreateDataChannel: %v", err)
	}
	dcOpen := make(chan struct{})
	dcMsgs := make(chan []byte, 64)
	dc.OnOpen(func() { close(dcOpen) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if msg.IsString {
			dcMsgs <- append([]byte(nil), msg.Data...)
		}
	})

	// Create the offer and gather ICE fully (non-trickle) before handing it
	// to the host core, exactly as a signaling transport would.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("guest CreateOffer: %v", err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("guest SetLocalDescription: %v", err)
	}
	select {
	case <-gather:
	case <-time.After(20 * time.Second):
		t.Fatal("guest ICE gathering timed out")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	answer, err := s.acceptWebRTCOffer(ctx, *pc.LocalDescription())
	if err != nil {
		t.Fatalf("acceptWebRTCOffer: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("guest SetRemoteDescription: %v", err)
	}

	select {
	case <-dcOpen:
	case <-time.After(20 * time.Second):
		t.Fatal("guest DataChannel never opened")
	}

	// --- http-over-DC: GET /api/version over the established channel. ---
	reqFrame, _ := json.Marshal(map[string]any{
		"type":    "__juggler_http_req",
		"id":      "r1",
		"method":  http.MethodGet,
		"path":    "/api/version",
		"headers": map[string]string{},
		"body":    "",
	})
	if err := dc.SendText(string(reqFrame)); err != nil {
		t.Fatalf("guest send http-over-DC request: %v", err)
	}

	res := readHTTPOverDCResponse(t, dcMsgs, "r1")
	if res.Status != http.StatusOK {
		t.Fatalf("http-over-DC status: got %d, want 200 (LAN gate should have admitted DataChannel ingress)", res.Status)
	}
	bodyBytes, err := base64.StdEncoding.DecodeString(res.Body)
	if err != nil {
		t.Fatalf("decode response body base64: %v", err)
	}
	var version struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if err := json.Unmarshal(bodyBytes, &version); err != nil {
		t.Fatalf("parse /api/version body %q: %v", bodyBytes, err)
	}
	if version.ProtocolVersion != RendezvousProtocolVersion {
		t.Fatalf("protocolVersion: got %d, want %d", version.ProtocolVersion, RendezvousProtocolVersion)
	}
}

type httpOverDCResult struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// readHTTPOverDCResponse reads DataChannel frames, reassembling any
// __juggler_dc_chunk envelopes, until it sees the __juggler_http_res for reqID.
func readHTTPOverDCResponse(t *testing.T, frames <-chan []byte, reqID string) httpOverDCResult {
	t.Helper()
	type chunkAcc struct {
		parts []string
		got   int
	}
	assemblies := map[string]*chunkAcc{}
	deadline := time.After(20 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("timed out waiting for __juggler_http_res")
		case raw := <-frames:
			var chunk struct {
				Type  string `json:"type"`
				ID    string `json:"id"`
				Index int    `json:"index"`
				Total int    `json:"total"`
				Data  string `json:"data"`
			}
			if json.Unmarshal(raw, &chunk) == nil && chunk.Type == "__juggler_dc_chunk" {
				acc := assemblies[chunk.ID]
				if acc == nil {
					acc = &chunkAcc{parts: make([]string, chunk.Total)}
					assemblies[chunk.ID] = acc
				}
				if chunk.Index >= 0 && chunk.Index < len(acc.parts) && acc.parts[chunk.Index] == "" {
					acc.parts[chunk.Index] = chunk.Data
					acc.got++
				}
				if acc.got < chunk.Total {
					continue
				}
				raw = []byte(strings.Join(acc.parts, ""))
			}
			var res httpOverDCResult
			if json.Unmarshal(raw, &res) != nil || res.Type != "__juggler_http_res" {
				continue
			}
			if res.ID != reqID {
				continue
			}
			return res
		}
	}
}

// TestWebRTCClientSendSurvivesConcurrentClose drives Send and Close the way the
// realtime loop and the write pump do in production: a broadcast is still
// queueing messages when a write error sends the pump through its deferred
// Close. Signalling the close by closing the send channel itself makes that a
// data race between close and send, so this fails under -race until the close
// is signalled on a channel of its own.
func TestWebRTCClientSendSurvivesConcurrentClose(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	defer func() { _ = pc.Close() }()

	// The channel never opens, so the pump's first write fails and its deferred
	// Close runs while the senders below are still going — the CI stack exactly.
	dc, err := pc.CreateDataChannel("juggler", nil)
	if err != nil {
		t.Fatalf("CreateDataChannel: %v", err)
	}
	c := newWebRTCClient(dc, pc, nil)

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 200 {
				c.Send(map[string]string{"type": "ping"})
			}
		}()
	}
	// Close from underneath the senders as well, so the race is driven from both
	// the pump's exit and an explicit eviction.
	go c.Close()
	wg.Wait()

	// Send must report the client is gone rather than panic or block.
	if c.Send(map[string]string{"type": "ping"}) {
		t.Error("Send reported success on a closed client")
	}
}
