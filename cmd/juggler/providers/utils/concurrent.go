//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"sync"
)

// MapConcurrent applies fn to every item through a bounded worker pool and
// returns the results index-aligned with items.
//
// Provider model discovery keeps arriving at this shape: one cheap list call,
// then a per-item probe for the detail the list omits — an Ollama model's
// Modelfile num_ctx, an OpenRouter preset's model. Serially that costs a refresh
// N round trips; unbounded it points N simultaneous requests at one endpoint.
// At most maxConcurrent run at a time, which holds a refresh to roughly
// ceil(len(items)/maxConcurrent) probe intervals while keeping the load on the
// endpoint polite. A non-positive bound runs the work serially.
//
// fn returns a value rather than a (value, error) pair deliberately: a per-item
// failure here must DEGRADE rather than fail the list, so fn absorbs its own
// error and returns the zero value or its own conservative fallback. Every input
// therefore keeps a result slot whatever happened to it, which is what lets a
// caller pair the two up by position.
//
// A cancelled context stops the fan-out; items never started keep the zero value.
func MapConcurrent[T, R any](ctx context.Context, items []T, maxConcurrent int, fn func(context.Context, T) R) []R {
	results := make([]R, len(items))
	if len(items) == 0 {
		return results
	}
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}

	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
dispatch:
	for i, item := range items {
		// Checked before the select, not only inside it: with a free slot both
		// cases are ready and the select would pick between them at random.
		if ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
			break dispatch
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = fn(ctx, item)
		}()
	}
	wg.Wait()
	return results
}
