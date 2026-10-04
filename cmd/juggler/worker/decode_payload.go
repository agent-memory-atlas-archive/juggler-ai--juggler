//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// decodePayload unmarshals an inbound message's payload into v and reports
// whether it decoded. It is the one error policy every message handler shares:
// a payload that does not decode is a protocol fault between a client and this
// worker, never something a user did, so it is logged under the message type
// and the handler drops the message.
//
// Two refinements sit on top of that policy, each at the handler that needs it.
// A handler whose dropped message the user would otherwise never hear about (an
// init, a send) also inserts an error item. A barrier whose work does not depend
// on its payload reads its ack id through ackIDOf, which logs the same way but
// lets the work go ahead.
//
// Deliberately outside it: readers that are total by design and say so at
// their declaration (threadItemIDFromPayload, cancelReasonFromPayload,
// describeRoundTrip), and handleEngineTrace, which logs the raw frame whether
// or not its probe decodes.
func (w *ConversationWorker) decodePayload(msgType string, payload json.RawMessage, v any) bool {
	if err := json.Unmarshal(payload, v); err != nil {
		w.log.Error("Failed to parse %s message: %v", msgType, err)
		return false
	}
	return true
}

// ackIDOf reads the ack id off a barrier message: one whose only payload field
// is the id the client awaits, and whose work — a flush, a history clear, an
// undo-group merge — is owed whatever the frame held. An absent payload is
// silently empty; a malformed one is logged by decodePayload and yields "", so
// the work still happens and the client's pending call times out rather than
// resolving against the wrong request.
func (w *ConversationWorker) ackIDOf(msgType string, payload json.RawMessage) string {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	if len(payload) > 0 {
		w.decodePayload(msgType, payload, &msg)
	}
	return msg.AckID
}
