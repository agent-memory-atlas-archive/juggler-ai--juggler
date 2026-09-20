# Tutorial: build an extension

[`extension_guide.md`](extension_guide.md) is the reference — it tells you what
every field and hook does. This is the other thing: one extension, built from an
empty directory to a working, installable tool, in the order you would actually
build it.

We are going to write **Bookmarks**: save named locations in a project
(`retry loop → worker/turn.go:212`) and recall them later. It is small enough to
finish and real enough to keep.

By the end it will have four capabilities — a pair of tools, an approval-gated
tool, a slash command, and a sidebar card — plus a user setting. You can read the
finished code at any point in
[`examples/extensions/bookmarks/`](../examples/extensions/bookmarks).

**You do not need Juggler's source for this.** Everything ships with the app.

---

## 1. Scaffold it

```bash
juggler ext init bookmarks
cd bookmarks
```

You get a complete extension that already loads:

```
bookmarks/
  juggler.extension.json
  context-items/echo-context-item.js
  strategies/sample-strategy-type.js
  commands/hello-command-type.js
  README.md
```

Install it into your own Juggler and see it work before changing anything:

```bash
juggler ext link .
```

That symlinks the directory into `~/.juggler/extensions/` (validating it first).
Start or reconnect to Juggler, and from now on **saving any file hot-reloads the
extension** in connected viewers. No restart, all the way through this tutorial.

Check it arrived: Settings → **Extensions** should list *bookmarks* with its
three capabilities. Ask the model to echo something and it will call the sample
tool.

We do not need a strategy, so delete it:

```bash
rm strategies/sample-strategy-type.js
```

Then remove the `"strategies"` line from `provides` in
`juggler.extension.json`. A glob that matches nothing is **not** refused at load
— the extension simply contributes nothing for that type, silently. Only
`juggler ext validate` reports it:

```bash
juggler ext validate .
```

Which is the argument for running it: a typo'd glob is otherwise indistinguishable
from a capability that mysteriously never appears.

---

## 2. A place to keep them

Bookmarks need to live somewhere. `.juggler/bookmarks.json` in the project is a
good home: ops resolve relative paths against the project root, so bookmarks
follow the project rather than the machine.

Create `lib/bookmark-store.js`. Note the directory — files under `lib/` carry no
capability suffix, so none of the manifest's globs match them. This is a plain
module the capabilities import, not a capability itself.

```javascript
import { readFile, writeFile } from 'juggler/ops';

const STORE_PATH = '.juggler/bookmarks.json';

export async function loadBookmarks(signal) {
  try {
    const file = await readFile({ path: STORE_PATH }, signal);
    const parsed = JSON.parse(file.content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];        // no file yet is the normal first-run state, not an error
  }
}

export async function saveBookmarks(bookmarks, signal) {
  await writeFile(
    { path: STORE_PATH, content: `${JSON.stringify(bookmarks, null, 2)}\n` },
    signal
  );
}

// One line per bookmark. Used by the tool, the command and the card alike —
// which is most of the reason this module exists.
export function format(bookmarks) {
  return bookmarks
    .map(b => `${b.name} — ${b.path}${b.line ? `:${b.line}` : ''}`)
    .join('\n');
}
```

`juggler/ops` is the privileged host layer — filesystem, shell, search, web.
Extensions import **only** from `juggler/*` specifiers; that is the same surface
the built-in extension uses, which is what guarantees a third-party extension can
do anything a built-in can.

---

## 3. The first real tool

Replace `context-items/echo-context-item.js` with
`context-items/bookmarks-context-item.js`. A context item is a tool the model can
call, and there are four members that matter:

```javascript
import ContextItem from 'juggler/context-item';
import { loadBookmarks, saveBookmarks, format } from '../lib/bookmark-store.js';

class BookmarksContextItem extends ContextItem {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'Save and recall named locations in the project',
    requiresApproval: false
  };

  static getToolDefinitions() {
    return [
      {
        name: 'bookmark_add',
        category: 'write',
        description: 'Save a named bookmark pointing at a file, optionally a specific line.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short label for this location' },
            path: { type: 'string', description: 'Project-relative file path' },
            line: { type: 'number', description: 'Optional 1-indexed line number' }
          },
          required: ['name', 'path']
        }
      },
      {
        name: 'bookmark_list',
        category: 'read',
        description: 'List every saved bookmark in this project.',
        input_schema: { type: 'object', properties: {} }
      }
    ];
  }

  async execute(params) {
    const bookmarks = await loadBookmarks(this.signal);
    if (params.name === undefined) {
      return { action: 'list', count: bookmarks.length, listing: format(bookmarks) };
    }
    const kept = bookmarks.filter(b => b.name !== params.name);
    kept.push({ name: params.name, path: params.path, line: params.line,
                savedAt: new Date().toISOString() });
    await saveBookmarks(kept, this.signal);
    return { action: 'add', name: params.name, count: kept.length };
  }

  getSummary(outcome) {
    if (!outcome.success) return this.failureSummary(outcome.error);
    const result = outcome.result;          // ← see the trap below
    if (result.action === 'list') {
      return result.count === 0
        ? this.successSummary('No bookmarks saved.')
        : this.successSummary(this.truncateForLLM(result.listing));
    }
    return this.successSummary(`Saved bookmark "${result.name}".`);
  }
}

export default BookmarksContextItem;
```

Save the file and ask the model to bookmark something. It works already.

Four things in there are worth stopping on.

**`category` is not decoration.** It is what strategies gate on: a read-only
strategy keeps `read` and `meta` and drops `write`. Label `bookmark_add` as
`write` and it correctly disappears under read-only, instead of quietly writing
to disk in a mode the user chose for safety.

**Two tools, not one tool with a mode.** A model chooses between two well-named
tools far more reliably than between two modes of one. Do not collapse them to
`bookmark({action})`.

**`summary` IS what the model reads.** There is no separate LLM-content hook:
`getSummary()`'s `summary` field is both the `tool_result` content and the
transcript line. So the actual listing goes there, wrapped in
`this.truncateForLLM()` so a huge result is capped at the conversation's budget
rather than blowing it.

**The trap: `outcome.result`, not `outcome`.** `execute()` returns raw data and
the framework wraps it:

```javascript
{ success: true, result: <what execute returned>, prepared: …, error: … }
```

Reading `outcome.action` gives `undefined`, and the model sees an empty result
with nothing explaining it. This is the single most common mistake in a first
extension, and it fails quietly.

---

## 4. Fail before you act

Right now `bookmark_add` with a blank name writes a nameless bookmark. Add
`validate()` — it runs before anything executes, and its error text goes to the
model:

```javascript
async validate(toolInput) {
  if (toolInput.name === undefined && toolInput.path === undefined) {
    return { valid: true, params: toolInput };      // bookmark_list takes nothing
  }
  if (typeof toolInput.name !== 'string' || toolInput.name.trim() === '') {
    return { valid: false, error: 'Parameter "name" must be a non-empty string' };
  }
  if (typeof toolInput.path !== 'string' || toolInput.path.trim() === '') {
    return { valid: false, error: 'Parameter "path" must be a project-relative file path' };
  }
  return { valid: true, params: { ...toolInput, name: toolInput.name.trim() } };
}
```

Write these messages as instructions, not diagnostics. The model is the reader,
and "must be a non-empty string" tells it what to do next; "invalid input" does
not.

---

## 5. Ask before you destroy

Clearing every bookmark should stop and ask. Approval is declared **per class**,
so this goes in a new file, `context-items/bookmark-clear-context-item.js` —
putting it on the existing class would gate listing too.

```javascript
import ContextItem from 'juggler/context-item';
import { loadBookmarks, saveBookmarks, format } from '../lib/bookmark-store.js';

class BookmarkClearContextItem extends ContextItem {
  static MANIFEST = {
    id: 'bookmark-clear',
    name: 'Clear Bookmarks',
    version: '1.0.0',
    description: 'Delete every saved bookmark in this project',
    requiresApproval: true          // park the call and ask
  };

  static getToolDefinitions() {
    return [{
      name: 'bookmark_clear',
      category: 'write',
      description: 'Delete every saved bookmark in this project. Cannot be undone.',
      input_schema: { type: 'object', properties: {} }
    }];
  }

  async getApprovalConfig(_params) {
    const bookmarks = await loadBookmarks(this.signal);
    return {
      title: 'Clear bookmarks',
      message: `Delete all ${bookmarks.length} bookmarks? This cannot be undone.\n\n`
        + format(bookmarks)
    };
  }

  async execute(_params) {
    const bookmarks = await loadBookmarks(this.signal);
    await saveBookmarks([], this.signal);
    return { removed: bookmarks.length };
  }
}
```

`getApprovalConfig()` runs *before* approval, so it can read the store and name
what is about to be lost. That is the difference between a dialog someone reads
and a dialog someone clicks through: "Delete all 14 bookmarks?" with the list
underneath, not "Run bookmark_clear?".

Note the manifest carries **two ids** and they are different things: the
extension id in `juggler.extension.json` is the unit the user enables or
disables; each capability's `MANIFEST.id` identifies that capability. Two
extensions cannot claim the same capability id — a duplicate is a surfaced load
error, not a silent overwrite.

---

## 6. Let the user configure it

An unbounded bookmark list is a slow leak. Add a cap the user controls, in
`juggler.extension.json`:

```jsonc
"settings": [
  {
    "key": "max_bookmarks",
    "type": "number",
    "label": "Maximum bookmarks",
    "help": "Adding beyond this drops the oldest bookmark.",
    "default": 50
  }
]
```

Save, and the control appears under Settings → Extensions → Bookmarks. You write
no UI.

Read it back with `extensionConfigResolve`, keyed by your **extension** id:

```javascript
import { extensionConfigResolve } from 'juggler/ops';

const EXTENSION_ID = '@local/bookmarks';   // must match the manifest exactly

export async function maxBookmarks(signal) {
  try {
    const config = await extensionConfigResolve({ extId: EXTENSION_ID }, signal);
    const value = Number(config.max_bookmarks);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
  } catch {
    return 50;
  }
}
```

Then enforce it in `execute()`, adding `maxBookmarks` to that file's import from
`../lib/bookmark-store.js`:

```javascript
const cap = await maxBookmarks(this.signal);
const final = kept.length > cap ? kept.slice(kept.length - cap) : kept;
await saveBookmarks(final, this.signal);
```

Defaults are applied on read, so a user who never touches the setting still gets
50 — the fallback above is for the case where the op itself fails.

**If you need an API key**, declare it as `"type": "secret"`. Secrets are stored
in the credential store rather than the settings file, and only
`extensionConfigResolve` returns their values — `extensionConfigGet`, which the
settings UI uses, sees a presence marker and never the secret itself. A `secret`
may not declare a `default`.

---

## 7. A command, for when you don't want a model turn

Asking a model to list your bookmarks costs a turn. A slash command costs
nothing. Replace `commands/hello-command-type.js` with
`commands/bookmarks-command-type.js`:

```javascript
import CommandType from 'juggler/command-type';
import { loadBookmarks, format } from '../lib/bookmark-store.js';

class BookmarksCommandType extends CommandType {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'List the bookmarks saved in this project'
  };

  async execute(args) {
    const bookmarks = await loadBookmarks();
    if (bookmarks.length === 0) return { handled: true, message: 'Nothing bookmarked yet.' };
    return { handled: true, message: format(bookmarks) };
  }
}
```

Type `/bookmarks`. That is the whole capability — no LLM, no approval, no schema.

Commands cannot perform host side-effects directly. To open a thread or set the
composer draft, **declare** it on `sideEffects` and the host dispatches it. And
if your command writes to the conversation, set both `mutatesConversation: true`
(so the host settles any live turn before `execute()` runs) and
`coalesceUndo: true` (so a multi-step change reverts as one undo). This one only
reads, so it needs neither.

> Note: if all you want is a reusable *prompt*, you do not need an extension at
> all — a [custom slash command](custom-commands.md) is a markdown file with no
> code. Reach for this capability when the command needs to *do* something.

---

## 8. Put it on screen

Last capability: a sidebar card, in `cards/bookmarks-card.js`. Add the glob to
`provides` as `"infoCards": ["cards/*-card.js"]`.

```javascript
import InfoCardType from 'juggler/info-card-type';
import { loadBookmarks } from '../lib/bookmark-store.js';

let cached = [];                  // outside the class — see below

class BookmarksCard extends InfoCardType {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'List this project’s saved bookmarks in the sidebar.',
    eyebrow: 'Bookmarks',
    priority: 5
  };

  hasContent() {
    return cached.length > 0;     // no bookmarks → no card in the rail
  }

  mount(contentEl) {
    let disposed = false;
    const paint = () => { /* …build elements from `cached`… */ };
    const refresh = async () => {
      const bookmarks = await loadBookmarks();
      if (disposed) return;
      cached = bookmarks;
      paint();
    };
    paint();
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; clearInterval(timer); };   // teardown
  }
}
```

Two things here are easy to get wrong.

**Return the teardown.** Without it the interval outlives the element, and the
rail removes and rebuilds cards more often than you would think.

**Cache outside the class.** When the sidebar runs short of room it *drops* the
lowest-priority card — a real teardown — and rebuilds it when the room comes
back. So `mount()` runs on every resize, not once per session. A card that
fetched on each mount would fire a request per frame during a window drag. Paint
from cache, refresh quietly.

Cards are **viewer-only**: they touch the DOM and never run in the engine, which
is why this is the one capability type with no worker twin to think about.

---

## 9. Check it, then publish it

```bash
juggler ext validate .
```

This runs the server's admission check — required manifest fields and
`engineApi` compatibility with this host — plus the glob check from step 1 that
discovery does not do. A packaging mistake fails here with a clear `✗` rather
than becoming an extension that mysteriously never appears.

Add tests while you are at it — declare them in the manifest:

```jsonc
"provides": { "tests": ["_tests/*-test.js"] }
```

The leading underscore matters: it is what keeps test files out of an embedded
build. `tests` is test-only and does not count as a capability.

To publish, put the directory in a git repository. Anyone can then install it:

```bash
juggler ext add github.com/you/bookmarks
```

That clones into `~/.juggler/extensions/`, printing your declared `permissions`
and asking for confirmation first. There is **no auto-update** — users update
with `git pull` in that directory, then reconnect.

Before you ship, be honest in `permissions`. It is disclosure, not a sandbox:
extensions run unsandboxed with the full privileges of the app, and the list is
what lets someone decide whether to trust yours. Ours is:

```jsonc
"permissions": ["filesystem.read", "filesystem.write"]
```

---

## Where to go next

- [`extension_guide.md`](extension_guide.md) — the reference. Every manifest
  field, all five capability types, the trust model, `contextPosition`, sub-agents.
- `web/sdk/context-item.js`, `strategy-type.js`, `command-type.js`,
  `info-card-type.js`, `file-viewer.js` — the base classes. Each opens with a
  quickstart and a full method reference, and is the canonical API documentation.
  Inside the app, the `ReadJugglerSource` tool reads them with no checkout.
- [`../examples/extensions/`](../examples/extensions) — the finished Bookmarks
  extension, plus small standalone examples of the capability types it doesn't
  cover.
- `web/extensions/juggler-core/` — the built-in extension, loaded through exactly
  the same path as yours. Much bigger, and the best reference for real detail.

The capability we never touched here is the **strategy** — a policy for how the
whole agentic loop runs, which tools exist, and what gets auto-approved. See
`examples/extensions/focus-strategy/` for a small one.
