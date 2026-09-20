# Context windows and compaction

Every model Juggler talks to has a finite context window. This page explains
how Juggler keeps requests inside that window: where the limits come from,
what is checked before each call, and what happens when a conversation
outgrows the window anyway.

## Where the limits come from

Four sources, in order. Each one is only consulted when the one above it has
nothing to say about that exact model id:

1. **What the endpoint says about itself.** Most model-list endpoints publish
   each model's limits — Claude and Gemini report them directly, and among
   OpenAI-compatible servers so do vLLM, llama.cpp, LM Studio, LiteLLM, Groq,
   Together, Mistral, Moonshot, OpenRouter and Copilot. This is the best
   possible answer, because it describes the machine that will actually serve
   your request rather than what a documentation page said once. Refreshing the
   model list in settings refreshes these numbers.
2. **Juggler's built-in catalog.** Some endpoints publish no limits at all —
   OpenAI, DeepSeek, Z.AI and Cerebras return a bare list of model ids, and so
   does Ollama's OpenAI-compatible route. For those, and for any provider that
   cannot be reached right now, Juggler falls back to figures it ships, taken
   from each vendor's published documentation.
3. **A conservative default**, for a model neither of the above knows. It is a
   guess, and deliberately a low one: guessing low compacts a conversation
   earlier than it needed to be, while guessing high walks a fully-assembled
   request into a rejection.
4. **Your own figure**, which outranks all three. Settings → Providers → expand
   a provider's model list gives every model a context-window and
   maximum-output field. Set one when you know better than the list above —
   most often for a gateway that publishes nothing.

Some providers need more than a lookup:

- **Ollama:** the window that matters is the one the daemon is *serving* with,
  not the model's training maximum. Juggler probes each model's Modelfile for
  a configured `num_ctx`. When nothing reveals the daemon's setting it assumes
  Ollama's documented default of 4096 — deliberately conservative, because
  over-estimating the window makes the daemon silently truncate your history.
  If you raised your daemon's default, declare it in the provider settings
  (stored as `ollama_num_ctx`) or via the `OLLAMA_NUM_CTX` or
  `OLLAMA_CONTEXT_LENGTH` environment variables (the latter is the one the
  daemon itself honors). Precedence: a Modelfile `num_ctx` wins over all of
  them; among the overrides, the stored setting beats `OLLAMA_NUM_CTX`, which
  beats `OLLAMA_CONTEXT_LENGTH`.
- **LocalAI:** its model list is a bare list of ids, but a second route —
  `/v1/models/capabilities` — states the window the backend will actually serve
  each model with, and Juggler reads it once per listing. That route reports the
  window from LocalAI v4.10.0 onwards; an older server leaves every model on an
  assumed 8192, which is LocalAI's own default. Note that only a **top-level**
  `context_size:` in a model's YAML changes what it serves — under `parameters:`
  it is ignored, which is where LocalAI's gallery configs put it, so gallery
  models report 8192 whatever their file says. The same capabilities route is
  read for any OpenAI-compatible endpoint that answers it, so a LocalAI reached
  as a custom endpoint gets the same numbers.
- **Claude Code custom aliases:** an alias the CLI has never seen has no known
  limit, so the first turn is allowed through and the real limit is learned
  from the provider's response. Learned sizes are cached in
  `~/.juggler/cache/claudecode-model-info.json` (safe to delete; it
  re-learns).
- **Other custom aliases fail closed.** If you type a model id the provider
  doesn't report, Juggler refuses to guess — it does *not* inherit the
  provider's default window. The error tells you to check the model id or
  refresh the provider's model list in settings.

A gateway is the awkward case. The same model id served through two different
backends genuinely has different limits — across one aggregator's providers,
one model's maximum output ranged from 16K to 943K under a single name — so for
a gateway only what that gateway reports means anything, and a built-in figure
is a last resort rather than a fact.

## The output reserve

Every request must leave room for the answer. Juggler reserves, in order of
preference: the model's reported maximum output, or — when only the window is
known — a derived reserve: a fifth of the window, capped at a flat 20k (so a
window of 100k or more reserves 20k, and anything smaller reserves a fifth).
The same number is sent to the provider as the wire
output cap and charged against the window before sending, so the two never
diverge.

## What is checked before each call

Before any model call, Juggler sizes the full request envelope — messages,
system prompt, tool definitions, images, framing, and provider overhead —
preferring measurement over estimation: once a request has been billed, the
provider's own input count anchors everything up to that point, and only the
messages appended since are estimated. Crossing 85% of the window with an
anchored number is the compaction trigger.

An **unanchored** size — the first turn, or the turn after anything rewrote
earlier messages — is a character-heuristic estimate that deliberately
over-counts dense text (hashes, base64, CJK, emoji), often by a factor of two
on real transcripts. Such an estimate is never allowed to trigger compaction
on its own: unless it exceeds the hard window itself, the request is sent and
the provider's answer settles it — a billed count that re-anchors the sizing,
or a rejection that starts recovery.

The estimator is not an unconditional upper bound either. Content chopped into
short (≤16-character) alphanumeric chunks by punctuation — UUIDs, dotted or
snake-case ids, hex columns, minified JSON keys — tokenizes denser than the
estimate assumes and can be under-counted. Such a request may pass the check
and then be rejected by the provider itself; automatic recovery (below) is the
backstop for exactly that case.

## Automatic recovery

When a conversation genuinely outgrows the window — a measured count crosses
the ceiling, or the provider rejects the turn with its own context-overflow
error — Juggler recovers instead of failing the turn:

1. The status line shows *"Compacting"*.
2. The oldest history is summarized into a compaction-summary item; the most
   recent items stay verbatim, within a budget that leaves real headroom below
   the trigger rather than stopping just under the window. Tool calls and
   their results fold atomically, so a pair is never split, and any earlier
   compaction summary is carried into the new one — summaries never stack.
3. A tool result too large to ever fit is summarized in place (marked
   *"[tool result exceeded the model context window and was summarized]"*);
   the tool call and its summary stay paired and visible.
4. The turn is retried with the size guard bypassed — the compacted request is
   judged by the provider, whose billed count re-anchors the sizing — and the
   loop continues.

If **your newest message alone** exceeds the window, recovery cannot help and
you get a concise terminal error — nothing is folded. Edits made while a
summary is being built abort the fold rather than clobbering newer content.
Summary and error items carry the operation's accounting (calls, token usage,
duration) in their item data, so you can inspect what the recovery cost.

## The conversation spend ceiling

The window is about one request. Separately from it, Juggler keeps a running
total of the *new* input a conversation has sent — every turn, including the
ones inside sub-threads and the hidden calls compaction makes, and excluding
whatever the provider served from its cache. The exclusion is the whole point: a
turn re-sends its entire prompt at every tool round-trip, and a warm prompt is
almost all cache read, so counting prompts whole would measure how long you
worked rather than what that work cost. The total is not shown anywhere.

Past a ceiling on that total, Juggler stops delegating. Threads an agent started
are told at their next turn that the ceiling has been reached; their tools are
withheld, so the turn they are in becomes their report to whoever asked. This
exists because a fan-out of sub-agents is the one thing here that can spend a
great deal very quickly with nobody watching any single one of them.

Your own turns are never stopped, and neither is a thread you created or have
typed into — you can see a thread running and stop it yourself. What those
threads do lose is the ability to start new unwatched work: past the ceiling
`create_thread` is refused, and so is any tool that can only run as a sub-thread
(`Explore`, `Research`). The refusal names the figures and where to change them,
because a refusal you cannot explain reads as a bug. A tool that can also run
without a sub-thread, such as `WebFetch`, simply runs without one — you asked
for it, and only the delegation is in question.

**Settings → Defaults → Spend ceiling** sets it, in millions of new input
tokens. Blank uses the default of 10 million, `0` removes the ceiling entirely.
A long session of ordinary work lands well inside that; a fan-out reaches it
quickly, because every fresh transcript is content the conversation is paying
for the first time.

## Proactive compaction

`/compact` folds a conversation on demand through the same engine the
automatic recovery uses: a bounded map/reduce pinned to your model, capped at
8 reduction passes and 64 hidden calls with a spend ceiling. The fold either
converges to a faithful handoff summary or fails with a typed error — it never
degrades into an unbounded summary-of-a-summary spiral.
