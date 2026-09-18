# Styling Juggler

The contract for every stylesheet in the app, and for CSS shipped by an
extension. If you are adding a rule and wondering where it goes, the answer is
in [Where a rule goes](#where-a-rule-goes).

## The shape of it

- **Light DOM, one global cascade.** No Shadow DOM anywhere, deliberately:
  components are styled by element-name and class selectors from these
  stylesheets, and an extension can restyle what the host renders.
- **No build step.** These files are authored by hand, embedded into the binary
  by the `css/*` glob in `web/embed.go`, and served verbatim under a
  per-process version prefix (`/v<id>/css/…`). Nothing bundles, minifies or
  transforms them. What you write is what ships.
- **Two `<link>` lists, and they must agree**: `web/index.html` and
  `web/js-tests/headless-test.html`. A sheet missing from the second is a sheet
  the browser suite never applies, so its rules are untested. `lint-css-arch`
  checks the two lists match.

## Layers

Every sheet declares its layer, and the layer order is declared once in the
HTML:

```css
@layer tokens, base, layout, patterns, components, utilities;
```

| Layer | Holds |
|---|---|
| `tokens` | Custom properties only — the scales and the two themes. No selectors beyond `:root`. |
| `base` | Element defaults: reset, typography, forms, scrollbars, per-platform tweaks. Unclassed selectors live here and nowhere else. |
| `layout` | The app shell — header, columns, conversation area, the responsive rules that move them. |
| `patterns` | Idioms shared by several unrelated components: menus, modals, buttons, badges, icons. |
| `components` | One file per feature group. The bulk of the CSS. |
| `utilities` | Single-purpose `u-*` helpers. Last, so they win. |

Layers mean **source order between files no longer decides who wins**, which is
what makes it safe to have twenty component files instead of one enormous one.
Two consequences worth knowing:

- An override that crosses layers is explicit — a `layout` rule cannot be
  quietly beaten by a `components` rule, whatever the specificity. If you find
  yourself wanting that, the rule is in the wrong layer.
- **Unlayered CSS beats every layer.** Extension stylesheets are unlayered, so
  an extension can override host styling without `!important`. That is the
  supported mechanism; do not use `!important` to achieve it.

## Where a rule goes

**A selector belongs to the file that owns its root.** The root is the leading
element name or class of the selector — `composer-box .send-button` is owned by
`composer-box`, not by `.send-button`. Find the group that owns that root in
`manifest.json` and put the rule there, with the rest of its group.

Three corollaries, and they are the whole discipline:

- **A rule never goes "at the end of the file".** That habit is what produced a
  12,000-line `components.css` in which the composer was styled in seven places
  spread over four thousand lines.
- **`@media` and `@keyframes` live with what they modify**, not in a block of
  their own at the bottom. A component's responsive behaviour is part of that
  component.
- **`patterns/` is a decision, not a drift.** Move something there when a second
  unrelated component needs it, and say so in a comment. "Shared" should be a
  choice someone made, not the residue of a rule that was never re-filed.

`lint-css-arch` enforces ownership against `manifest.json`. A violation it
cannot yet fix sits in `.lint-css-allowlist` — that file is the outstanding
debt, and it only ever shrinks.

## Tokens

Split by what they are, not by which theme was written first:

- **`tokens/scale.css`** — everything theme-independent: spacing, radii, font
  sizes, z-index, shadows, transitions, scrollbar metrics. One definition,
  applying to both themes.
- **`tokens/theme-dark.css`, `tokens/theme-light.css`** — colour, and nothing
  else. **Every colour token must be defined in both.** The linter checks it.

The exception is a token deliberately defined for one theme only, consumed with
the other as its fallback:

```css
background: var(--ci-preset-badge-blue, var(--ci-preset-blue));
```

That is a light-theme override with a documented default, not a missing token.
Write it that way and the check will accept it.

Rules for using them:

- **Never hardcode a colour.** Use a token; add one if none fits.
- **`rem`, not `px`**, except borders, outlines and shadows. stylelint enforces
  this; a genuine exception (geometry that must not scale with the user's zoom)
  takes a `stylelint-disable` with a comment saying why, and a matching
  `stylelint-enable`.
- **`var(--x)` with no fallback must resolve.** An undefined custom property
  silently invalidates the whole declaration — and inside `color-mix()` it takes
  the rest of the value with it. If JS sets the property, list it in
  `manifest.json` under `jsSetProperties` so the linter knows.

## Naming

- A class is prefixed with its group: `.composer-*`, `.settings-*`,
  `.pinboard-*`. The prefix is what makes ownership checkable.
- `__element` / `--modifier` within a component is fine and used in places
  (`.pinboard-tabbar__list`, `.pp-status--invalid`). Consistency inside one file
  matters more than consistency across all of them.
- Utilities are `u-` prefixed, and only utilities are.
- **A class name assembled in JS must still be findable.** `color-${name}` is
  fine, but list the pattern in `manifest.json` under `dynamicClasses`, or the
  dead-selector check will offer to delete the CSS that serves it.

## Extensions

Extension CSS ships as a `.css` file beside the extension and is linted like
everything else. `injectStylesOnce()` remains for styles that genuinely can't be
static.

Extension sheets are unlayered, so they win against host CSS by default. With
that comes the obligation not to break the app:

- **Scope to something you own.** Context item content renders inside
  `.context-item-expanded-content` / `.context-item-collapsed-content` — the
  classes the host actually sets. Prefix your own classes `ci-{pluginId}-`.
- **Both themes must work.** Use tokens and you get this for free; reach for
  `:root[data-theme="light"] …` only when a token genuinely cannot express it.
- **Stay off the host's stacking layers.** `var(--z-base)` and `var(--z-raised)`
  are yours; `--z-controls`, `--z-dropdown`, `--z-modal`, `--z-above-modal` and
  `--z-toast` belong to host chrome.
- No `!important`, no Shadow DOM, no inline styles for theming, no hardcoded
  colours, no `px`.

Useful classes the host styles for you: `.ci-badge` / `.ci-badge-label` (label
pill), `.ci-code-content` (monospace block), `.ci-empty`, `.ci-error`, and the
twenty `color-*` presets (`slate blue indigo purple magenta pink red orange
amber yellow lime green emerald teal cyan sky brown stone zinc crimson`).

## What the linter checks

`make lint` runs stylelint and then `scripts/lint-css-arch`, which checks:

| Check | What fails it |
|---|---|
| ownership | A selector in a file that does not own its root. |
| dead selectors | A class in the CSS that appears in no JS, HTML or extension, and matches no `dynamicClasses` pattern. |
| token parity | A colour token defined for one theme only without the fallback idiom; a `var()` that resolves to nothing. |
| link parity | `index.html` and `headless-test.html` disagreeing on the sheet list. |

Run it on what you changed with `make lint-files FILES="web/css/…"`.
