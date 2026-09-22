//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// createConvVia posts a create with the given JSON body and returns the new id.
func createConvVia(t *testing.T, api *SessionAPI, body string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	api.HandleCreateConversation(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("create %s: status %d, body %s", body, rr.Code, rr.Body.String())
	}
	var res struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode create response: %v (body %s)", err, rr.Body.String())
	}
	if res.ID == "" {
		t.Fatalf("create %s returned no id (body %s)", body, rr.Body.String())
	}
	return res.ID
}

// newPlacementFixture builds a manager holding three conversations and returns
// them in the order the session stores them. A create prepends when it is told
// nothing, so creating A then B then C leaves C, B, A.
func newPlacementFixture(t *testing.T) (*SessionAPI, *core.SessionManager, []string) {
	t.Helper()
	projectDir := t.TempDir()

	store, err := core.NewFileSessionStore(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := core.NewSessionManager(core.SessionManagerConfig{Store: store, ProjectPath: projectDir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)

	ids := make([]string, 0, 3)
	for _, name := range []string{"A", "B", "C"} {
		id, _, err := mgr.CreateConversation(name)
		if err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		ids = append(ids, id)
	}
	a, b, c := ids[0], ids[1], ids[2]

	api := &SessionAPI{managerProvider: func() *core.SessionManager { return mgr }}
	if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, []string{c, b, a}) {
		t.Fatalf("fixture order = %v, want %v — a create prepends", got, []string{c, b, a})
	}
	return api, mgr, []string{a, b, c}
}

// TestHandleCreateConversation_PlacesAfterAnchor covers the half of a create the
// client cannot do for itself. The conversation order lives here: the server
// keeps it, broadcasts it on every create, and a viewer re-slots its tab list
// into whatever arrives — so wherever a viewer puts a new tab locally, this is
// the answer that survives, and the one the next launch reads back.
//
// Prepending is right for a conversation of the project's, which belongs at the
// head of the bar, and wrong for one created inside a workspace box: the box is
// drawn where its first conversation sits, so sending that conversation to the
// head takes the whole box up there with it. The create therefore carries the
// conversation it is to follow, and the order is settled in one transaction
// rather than by the viewer arguing with the broadcast afterwards.
func TestHandleCreateConversation_PlacesAfterAnchor(t *testing.T) {
	api, mgr, ids := newPlacementFixture(t)
	a, b, c := ids[0], ids[1], ids[2]

	id := createConvVia(t, api, `{"name":"In the box","after":"`+b+`"}`)

	want := []string{c, b, id, a}
	if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v — the new conversation goes directly after the one it was told to follow", got, want)
	}
}

// TestHandleCreateConversation_AnchorAtEnd covers the empty box, which is drawn
// past every conversation there is: its first member follows the last tab in the
// list, and must land at the end rather than being wrapped back to the front.
func TestHandleCreateConversation_AnchorAtEnd(t *testing.T) {
	api, mgr, ids := newPlacementFixture(t)
	a, b, c := ids[0], ids[1], ids[2]

	id := createConvVia(t, api, `{"name":"First in an empty box","after":"`+a+`"}`)

	want := []string{c, b, a, id}
	if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v — following the last conversation means the end of the order", got, want)
	}
}

// TestHandleCreateConversation_HeadWithoutAnchor pins what a create has always
// done, and what it must keep doing: the "+" at the top of the strip names no
// anchor and its conversation belongs at the head. An anchor this project has
// never heard of — a viewer posting an id from a session it has since left, or
// one binned between the two requests — is not an error and not a reason to
// refuse the create; it means the same as naming nothing.
func TestHandleCreateConversation_HeadWithoutAnchor(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"no anchor", `{"name":"Plain"}`},
		{"empty anchor", `{"name":"Plain","after":""}`},
		{"unknown anchor", `{"name":"Plain","after":"conv_nobody_has_ever_seen"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api, mgr, ids := newPlacementFixture(t)
			a, b, c := ids[0], ids[1], ids[2]

			id := createConvVia(t, api, tc.body)

			want := []string{id, c, b, a}
			if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, want) {
				t.Fatalf("order = %v, want %v — with nothing to follow, a create goes to the head", got, want)
			}
		})
	}
}
