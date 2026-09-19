//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"

	"github.com/pion/webrtc/v4"
)

type webrtcSignalRequest struct {
	Role  string                    `json:"role"`
	Offer webrtc.SessionDescription `json:"offer"`
}

type webrtcSignalResponse struct {
	Answer webrtc.SessionDescription `json:"answer"`
}

type webrtcICEConfig struct {
	Servers []webrtc.ICEServer
}

const (
	webRTCChunkType = "__juggler_dc_chunk"
	webRTCChunkSize = 16 * 1024
)

// dataChannelIngressKind is the MarkRemoteIngress kind for synthetic requests
// dispatched from a WebRTC DataChannel by the http-over-DC dispatcher.
const dataChannelIngressKind = "datachannel"

// RendezvousProtocolVersion is the http-over-DataChannel / signaling protocol
// version the binary speaks. It is published by handleVersion so a remote
// bootstrap page (e.g. the juggler.studio rendezvous client) can refuse to
// boot against a mismatched binary.
const RendezvousProtocolVersion = 2

type webRTCChunk struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Index int    `json:"index"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

type webRTCChunkAssembly struct {
	total    int
	parts    []string
	received int
}

// handleWebRTCSignal exchanges one non-trickle SDP offer/answer pair over the
// LAN HTTP path. Once ICE succeeds, all realtime protocol messages flow over the
// browser-created DataChannel and the signaling path goes idle. It owns only HTTP
// request parsing/validation; the peer-connection core is acceptWebRTCOffer,
// shared with the juggler.studio rendezvous client.
func (s *Server) handleWebRTCSignal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		handlers.WriteError(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	req, ok := handlers.DecodeJSON[webrtcSignalRequest](w, r)
	if !ok {
		return
	}
	if req.Role == "engine" {
		handlers.WriteError(w, r, http.StatusForbidden, "WebRTC engine role is not supported")
		return
	}
	if req.Offer.Type != webrtc.SDPTypeOffer || req.Offer.SDP == "" {
		handlers.WriteError(w, r, http.StatusBadRequest, "missing WebRTC offer")
		return
	}

	answer, err := s.acceptWebRTCOffer(r.Context(), req.Offer)
	if err != nil {
		status := http.StatusInternalServerError
		var bad *badOfferError
		if errors.As(err, &bad) {
			status = http.StatusBadRequest
		}
		handlers.WriteError(w, r, status, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(webrtcSignalResponse{Answer: *answer})
}

// badOfferError marks a core failure caused by a malformed client offer so the
// HTTP handler can answer 400; every other core error is an internal 500.
type badOfferError struct{ err error }

func (e *badOfferError) Error() string { return e.err.Error() }
func (e *badOfferError) Unwrap() error { return e.err }

// acceptWebRTCOffer builds the peer connection for one already-validated SDP
// offer, wires the browser-created "juggler" DataChannel to the realtime loop,
// and returns the local SDP answer. It is the shared core for both the LAN
// /api/webrtc/signal HTTP handler and the outbound juggler.studio rendezvous
// client. On any error it closes the peer connection before returning. ctx
// bounds the synchronous setup/ICE-gathering phase only; the established
// connection outlives ctx on its own pcCtx.
func (s *Server) acceptWebRTCOffer(ctx context.Context, offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	return s.acceptWebRTCOfferWithICEConfig(ctx, offer, webrtcICEConfig{
		Servers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
}

func (s *Server) acceptWebRTCOfferWithICEConfig(ctx context.Context, offer webrtc.SessionDescription, iceConfig webrtcICEConfig) (*webrtc.SessionDescription, error) {
	cfg := webrtc.Configuration{ICEServers: iceConfig.Servers}
	// Present the persistent identity so this peer's DTLS fingerprint is stable
	// across restarts (and across every connection within a run). When it is
	// nil — a first run whose identity could not be persisted — pion mints an
	// ephemeral certificate per connection, the pre-persistence behaviour.
	if s.webrtcCert != nil {
		cfg.Certificates = []webrtc.Certificate{*s.webrtcCert}
	}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	pcCtx, cancelPC := context.WithCancel(context.Background())
	startupTimer := time.AfterFunc(2*time.Minute, func() {
		cancelPC()
		_ = pc.Close()
	})
	var startOnce sync.Once
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "juggler" {
			_ = dc.Close()
			return
		}
		client := newWebRTCClient(dc, pc, s.stats)
		msgCh := make(chan []byte, 100)
		done := make(chan struct{})
		incomingChunks := make(map[string]*webRTCChunkAssembly)
		var doneOnce sync.Once

		dc.OnOpen(func() {
			startupTimer.Stop()
			startOnce.Do(func() {
				go s.runRealtimeClientLoop(pcCtx, client, msgCh, done)
			})
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if !msg.IsString {
				return
			}
			s.dispatchWebRTCFrame(client, append([]byte(nil), msg.Data...), incomingChunks, msgCh)
		})
		dc.OnClose(func() {
			cancelPC()
			doneOnce.Do(func() {
				close(done)
				close(msgCh)
			})
		})
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			// Only Failed/Closed are terminal. Disconnected is TRANSIENT — ICE
			// enters it after a few missed consent/STUN responses (a brief Wi-Fi
			// hiccup, a NAT rebind, a momentary CPU stall) and recovers back to
			// Connected on its own; pion only escalates to Failed (~25s later) if
			// the path is genuinely dead. Tearing the DataChannel down on
			// Disconnected killed otherwise-recoverable sessions after ~a minute
			// (worse over the TURN-less studio path, which has no relay to smooth
			// a blip, and worse on Firefox, which trips Disconnected sooner). Ride
			// it out and let ICE either recover or escalate to Failed.
			if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
				cancelPC()
				client.Close()
			}
		})
	})

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetRemoteDescription(offer); err != nil {
		_ = pc.Close()
		return nil, &badOfferError{fmt.Errorf("set remote description: %w", err)}
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("create answer: %w", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("set local description: %w", err)
	}

	select {
	case <-gatherComplete:
	case <-ctx.Done():
		_ = pc.Close()
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		jlog.Info("WebRTC: ICE gathering timed out; returning partial answer")
	}

	local := pc.LocalDescription()
	if local == nil {
		_ = pc.Close()
		return nil, errors.New("missing local description")
	}
	return local, nil
}

// dispatchWebRTCFrame routes one inbound DataChannel text frame. Frame-type
// routing is centralized here so additional multiplexed protocols can be added
// as new branches without touching the OnMessage wiring:
//   - __juggler_dc_chunk: reassemble, then dispatch the completed frame.
//   - __juggler_http_req: http-over-DC; dispatch through s.router and reply with
//     a __juggler_http_res frame instead of forwarding to msgCh.
//   - anything else (realtime WS JSON): forward to msgCh -> runRealtimeClientLoop.
func (s *Server) dispatchWebRTCFrame(client *webRTCClient, data []byte, chunks map[string]*webRTCChunkAssembly, msgCh chan<- []byte) {
	assembled, complete := assembleWebRTCChunk(chunks, data)
	isChunk := isWebRTCChunk(data)
	if complete {
		data = assembled
	} else if isChunk {
		return
	}
	if isHTTPOverDCRequest(data) {
		// Dispatch off the read loop so a slow handler never blocks chunk
		// reassembly or the realtime protocol. Each response carries its own id,
		// so concurrent responses interleave safely.
		go s.handleHTTPOverDC(client, data)
		return
	}
	select {
	case msgCh <- data:
	default:
		jlog.Error("WebRTC: inbound message queue full, dropping")
	}
}

const (
	httpOverDCRequestType  = "__juggler_http_req"
	httpOverDCResponseType = "__juggler_http_res"
)

type httpOverDCRequest struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type httpOverDCResponse struct {
	Type         string              `json:"type"`
	ID           string              `json:"id"`
	Status       int                 `json:"status"`
	Headers      map[string][]string `json:"headers"`
	Body         string              `json:"body"`
	BodyEncoding string              `json:"bodyEncoding"`
}

// isHTTPOverDCRequest peeks the frame's type without fully decoding it.
func isHTTPOverDCRequest(data []byte) bool {
	var hdr struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &hdr) == nil && hdr.Type == httpOverDCRequestType
}

// handleHTTPOverDC services one __juggler_http_req frame: it reconstructs a
// synthetic *http.Request, marks it as rendezvous ingress (so the LAN gate admits
// it while the engine WS role still refuses it), dispatches it through s.router
// via an httptest recorder, and sends the captured response back as a
// __juggler_http_res frame. SendRaw chunks the reply through the same
// __juggler_dc_chunk envelope automatically. Bodies are base64 in both
// directions so binary assets (fonts, images) travel uniformly.
func (s *Server) handleHTTPOverDC(client *webRTCClient, frame []byte) {
	var req httpOverDCRequest
	if err := json.Unmarshal(frame, &req); err != nil {
		jlog.Error("WebRTC http-over-DC: bad request frame: %v", err)
		return
	}

	var bodyReader io.Reader
	if req.Body != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			jlog.Error("WebRTC http-over-DC: bad body base64 for %s: %v", req.Path, err)
			return
		}
		bodyReader = bytes.NewReader(decoded)
	}

	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	httpReq := httptest.NewRequest(method, req.Path, bodyReader)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	httpReq = MarkRemoteIngress(httpReq, dataChannelIngressKind)

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httpReq)
	res := rec.Result()
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		jlog.Error("WebRTC http-over-DC: read response body for %s: %v", req.Path, err)
		return
	}

	payload, err := json.Marshal(httpOverDCResponse{
		Type:         httpOverDCResponseType,
		ID:           req.ID,
		Status:       res.StatusCode,
		Headers:      res.Header,
		Body:         base64.StdEncoding.EncodeToString(body),
		BodyEncoding: "base64",
	})
	if err != nil {
		jlog.Error("WebRTC http-over-DC: marshal response for %s: %v", req.Path, err)
		return
	}
	client.SendRaw(payload)
}

type webRTCClient struct {
	id        string
	role      ClientRole
	info      ClientInfo
	dc        *webrtc.DataChannel
	pc        *webrtc.PeerConnection
	send      chan wsMessage // Channel for outgoing messages
	closed    chan struct{}  // Closed to signal shutdown; see Close
	closeOnce sync.Once      // Ensures closed is closed only once
	stats     *wsStats
	// lastSendAt is when a message last reached the channel, as unix nanoseconds.
	// Written by the writer goroutine, read by the client's message loop. See
	// IdleOutbound.
	lastSendAt atomic.Int64
}

func newWebRTCClient(dc *webrtc.DataChannel, pc *webrtc.PeerConnection, stats *wsStats) *webRTCClient {
	c := &webRTCClient{
		id:   generateClientID(),
		role: ClientRoleViewer,
		// A data-channel viewer always reaches us over the WebRTC peer transport;
		// there is no HTTP request (hence no User-Agent) at channel-open time.
		info:   ClientInfo{Origin: "remote", Detail: remoteTransportLabel(dataChannelIngressKind), ConnectedAt: time.Now().UnixMilli()},
		dc:     dc,
		pc:     pc,
		send:   make(chan wsMessage, 256),
		closed: make(chan struct{}),
		stats:  stats,
	}
	// The channel has just opened, so the link starts idle from now rather than
	// from the zero time.
	c.lastSendAt.Store(time.Now().UnixNano())
	go c.writePump()
	return c
}

// IdleOutbound reports how long this client has had nothing to send, so the link
// supervisor can beat only on a quiet link. Zero while writes are queued — see
// WSClient.IdleOutbound for why a backlog counts as busy.
func (c *webRTCClient) IdleOutbound() time.Duration {
	if len(c.send) > 0 {
		return 0
	}
	return time.Since(time.Unix(0, c.lastSendAt.Load()))
}

func (c *webRTCClient) ClientID() string       { return c.id }
func (c *webRTCClient) ClientRole() ClientRole { return c.role }
func (c *webRTCClient) ClientInfo() ClientInfo { return c.info }

// ViewerID is always empty for a data-channel viewer: the channel opens without
// an HTTP request to carry one, so there is nowhere to read it from. Nothing can
// address such a viewer, which costs it the surfaces built on viewer-to-viewer
// addressing and nothing else. Announcing an id over the channel would be a
// protocol addition, not a plumbing fix.
func (c *webRTCClient) ViewerID() string { return "" }

func (c *webRTCClient) writePump() {
	// Marking the client closed on the way out covers the exit a write error
	// forces: nothing drains send once this goroutine is gone, so without it a
	// sender would fill the buffer and then block on a channel with no reader.
	// Close is idempotent (closeOnce), so the ordinary exit — the loop ending
	// because Close closed the closed channel — passes through it harmlessly.
	defer c.Close()
	for {
		var msg wsMessage
		select {
		case msg = <-c.send:
		case <-c.closed:
			// Close has already shut the data channel and the peer connection, so
			// anything still queued has nowhere to go; drop it and stop.
			return
		}
		payload := msg.raw
		if payload == nil {
			var err error
			payload, err = json.Marshal(msg.json)
			if err != nil {
				jlog.Error("WebRTC marshal error for client %s: %v", c.id, err)
				continue
			}
		}
		c.stats.record(statsOut, payload, c.role)
		if err := c.sendTextChunked(payload); err != nil {
			jlog.Error("WebRTC write error for client %s: %v", c.id, err)
			return
		}
		c.lastSendAt.Store(time.Now().UnixNano())
	}
}

// sendTextChunked delivers one frame over the DataChannel, splitting a payload
// larger than webRTCChunkSize across several __juggler_dc_chunk envelopes.
//
// Splits land on a UTF-8 rune boundary. Chunk data rides in a JSON string field,
// and json.Marshal coerces its input to valid UTF-8 — every byte of a truncated
// rune becomes U+FFFD — so a rune straddling a boundary arrives corrupted in
// both halves. Nothing downstream notices: U+FFFD is legal in a JSON string, so
// the reassembled frame still parses and the damage surfaces only as mangled
// text. Receivers concatenate the parts in order and never inspect the split
// points, so choosing them here needs no cooperation from the far end.
// webRTCChunkBounds splits payload into [start, end) spans of at most
// webRTCChunkSize bytes, each ending on a UTF-8 rune boundary.
func webRTCChunkBounds(payload []byte) [][2]int {
	bounds := make([][2]int, 0, len(payload)/webRTCChunkSize+1)
	for start := 0; start < len(payload); {
		end := start + webRTCChunkSize
		if end >= len(payload) {
			end = len(payload)
		} else {
			// Walk back over continuation bytes (0b10xxxxxx) to the start of the
			// rune spanning the boundary. A rune is at most four bytes, so this
			// steps back three times at worst.
			for end > start && payload[end]&0xC0 == 0x80 {
				end--
			}
			// A whole chunk of continuation bytes is not valid UTF-8 and has no
			// boundary to find. Split at full width so the loop still advances.
			if end == start {
				end = start + webRTCChunkSize
			}
		}
		bounds = append(bounds, [2]int{start, end})
		start = end
	}
	return bounds
}

func (c *webRTCClient) sendTextChunked(payload []byte) error {
	if len(payload) <= webRTCChunkSize {
		return c.dc.SendText(string(payload))
	}
	bounds := webRTCChunkBounds(payload)
	id := fmt.Sprintf("%s-%d", c.id, time.Now().UnixNano())
	for i, b := range bounds {
		chunk, err := json.Marshal(webRTCChunk{
			Type:  webRTCChunkType,
			ID:    id,
			Index: i,
			Total: len(bounds),
			Data:  string(payload[b[0]:b[1]]),
		})
		if err != nil {
			return err
		}
		if err := c.dc.SendText(string(chunk)); err != nil {
			return err
		}
	}
	return nil
}

func isWebRTCChunk(data []byte) bool {
	var hdr struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &hdr) == nil && hdr.Type == webRTCChunkType
}

func assembleWebRTCChunk(chunks map[string]*webRTCChunkAssembly, data []byte) ([]byte, bool) {
	var chunk webRTCChunk
	if err := json.Unmarshal(data, &chunk); err != nil || chunk.Type != webRTCChunkType {
		return nil, false
	}
	if chunk.ID == "" || chunk.Total <= 0 || chunk.Index < 0 || chunk.Index >= chunk.Total {
		return nil, false
	}
	entry := chunks[chunk.ID]
	if entry == nil {
		entry = &webRTCChunkAssembly{total: chunk.Total, parts: make([]string, chunk.Total)}
		chunks[chunk.ID] = entry
	}
	if entry.total != chunk.Total {
		delete(chunks, chunk.ID)
		return nil, false
	}
	if entry.parts[chunk.Index] == "" {
		entry.parts[chunk.Index] = chunk.Data
		entry.received++
	}
	if entry.received != entry.total {
		return nil, false
	}
	delete(chunks, chunk.ID)
	var totalLen int
	for _, part := range entry.parts {
		totalLen += len(part)
	}
	buf := make([]byte, 0, totalLen)
	for _, part := range entry.parts {
		buf = append(buf, part...)
	}
	return buf, true
}

// trySend queues a message, blocking while the buffer is full but never past
// the client's close. Returns false once the client is closed.
//
// Shutdown is signalled by closing a separate `closed` channel rather than the
// send channel itself: a sender and a closer can run on any two goroutines (the
// realtime loop racing the write pump's deferred Close, say), and closing a
// channel from under a concurrent send is a data race that costs a panic per
// send.
func (c *webRTCClient) trySend(msg wsMessage) bool {
	// Prefer the closed signal when both are ready, so a closed client stops
	// accepting work promptly rather than by chance.
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.send <- msg:
		return true
	case <-c.closed:
		return false
	}
}

func (c *webRTCClient) Send(msg any) bool        { return c.trySend(wsMessage{json: msg}) }
func (c *webRTCClient) SendRaw(data []byte) bool { return c.trySend(wsMessage{raw: data}) }

// Close stops the writer goroutine and tears down the transport. Safe to call
// multiple times, and from any goroutine — including one that is not the
// client's owner, which is how a wedged viewer is evicted.
func (c *webRTCClient) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.dc.Close()
		_ = c.pc.Close()
	})
}
