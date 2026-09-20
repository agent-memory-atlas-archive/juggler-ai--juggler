//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The assistant message that reported scoped-CSS not rendering: a design
 * preview carrying a `<style>` block, CSS variables, `@keyframes`, `@media`
 * guards, data-URL SVG glyphs and inline `style` attributes. Verbatim apart
 * from trailing whitespace, so the rendering tests exercise the shapes models
 * actually emit.
 * @module utilities/todo-preview-message
 */

/**
 * The message body, as markdown.
 * @type {string}
 */
export const TODO_PREVIEW_MESSAGE = `Here are all the states, drawn the way the real implementation would draw them: a single \`<input type="checkbox">\` with \`appearance: none\`, the box from CSS variables, and the glyph as a baked-white SVG \`background-image\` (no \`::after\`, no rotated borders — that's what's producing your blobby tick today).

<div class="tbx" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
<style>
.tbx * { box-sizing: border-box; }
.tbx .tbx-panel {
  --border-color: #30363d; --accent-green: #3fb950; --accent-yellow: #d29922;
  --accent-red: #f85149; --bg: #0d1117; --bg2: #161b22; --text: #c9d1d9; --muted: #8b949e;
  background: var(--bg); color: var(--text); border: 1px solid var(--border-color);
  border-radius: 8px; padding: 16px; font-size: 13px; line-height: 1.55;
}
.tbx .tbx-panel.light {
  --border-color: #d0d7de; --accent-green: #1a7f37; --accent-yellow: #9a6700;
  --accent-red: #d1242f; --bg: #ffffff; --bg2: #f6f8fa; --text: #1f2328; --muted: #656d76;
}
.tbx h4 { margin: 22px 0 8px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #8b949e; font-weight: 600; }
.tbx h4:first-child { margin-top: 0; }

/* ---- the box itself ---- */
.tbx input[type="checkbox"].tb {
  appearance: none; -webkit-appearance: none; margin: 0; padding: 0;
  display: inline-block; vertical-align: -0.1875em;
  width: 0.875rem; height: 0.875rem; flex: none;
  border: 1px solid var(--border-color); border-radius: 0.1875rem;
  background-color: transparent; background-repeat: no-repeat;
  background-position: center; background-size: 0.75rem 0.75rem;
  cursor: default;
}
.tbx input.tb[data-task-state="completed"], .tbx input.tb:checked {
  border-color: var(--accent-green); background-color: var(--accent-green);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960'%3E%3Cpath fill='%23fff' d='M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z'/%3E%3C/svg%3E");
}
.tbx input.tb[data-task-state="in_progress"] {
  border-color: var(--accent-yellow); background-color: var(--accent-yellow);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960'%3E%3Cpath fill='%23fff' d='M240-440v-80h480v80H240Z'/%3E%3C/svg%3E");
}
.tbx input.tb[data-task-state="failed"] {
  border-color: var(--accent-red); background-color: var(--accent-red);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960'%3E%3Cpath fill='%23fff' d='m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z'/%3E%3C/svg%3E");
}
.tbx input.tb[data-task-state="skipped"] {
  border-color: var(--muted); background-color: var(--muted);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960'%3E%3Cpath fill='%23fff' d='M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z'/%3E%3C/svg%3E");
}
/* pulse variants */
@keyframes tbx-fade { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes tbx-ring { 0% { box-shadow: 0 0 0 0 rgba(210,153,34,.55) } 70%,100% { box-shadow: 0 0 0 5px rgba(210,153,34,0) } }
.tbx .pulse-fade input.tb[data-task-state="in_progress"] { animation: tbx-fade 1.6s ease-in-out infinite; }
.tbx .pulse-ring input.tb[data-task-state="in_progress"] { animation: tbx-ring 1.8s ease-out infinite; }
@media (prefers-reduced-motion: reduce) { .tbx input.tb { animation: none !important; } }

/* ---- swatch grid ---- */
.tbx .sw { display: grid; grid-template-columns: 2.5rem 5.5rem 1fr; gap: 10px 14px; align-items: center; }
.tbx .sw .big { transform: scale(3); transform-origin: left center; }
.tbx .sw code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--bg2); border: 1px solid var(--border-color); border-radius: 4px; padding: 1px 5px; }
.tbx .sw .lbl { color: var(--muted); }

/* ---- list rendering ---- */
.tbx ol.demo { margin: 0; padding-left: 1.6rem; }
.tbx ol.demo li { margin: 0.375rem 0; }
.tbx ol.broken li input { position: relative; top: 0.125rem; margin: 0 0.4375rem 0 0; }
.tbx ol.fixed li { padding-left: 1.3125rem; text-indent: -1.3125rem; }
.tbx ol.fixed li > * { text-indent: 0; }
.tbx ol.fixed li input.tb { margin-right: 0.4375rem; }
.tbx ol.demo em { color: var(--muted); }
.tbx ol.demo code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--bg2); border-radius: 4px; padding: 1px 4px; }
.tbx li.skip-text { color: var(--muted); }
.tbx .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 46rem) { .tbx .two { grid-template-columns: 1fr; } }
.tbx .cap { font-size: 11px; color: #8b949e; margin: 0 0 6px; }

/* old tick, reproduced exactly as it is in patterns/icons.css today */
.tbx input.old { appearance:none; -webkit-appearance:none; position:relative; top:.125rem; width:.875rem; height:.875rem; margin:0 .4375rem 0 0; border:.0625rem solid #30363d; border-radius:.1875rem; background:transparent; }
.tbx input.old:checked { border-color:#3fb950; background:#3fb950; }
.tbx input.old:checked::after { content:""; position:absolute; top:.0625rem; left:.25rem; width:.1875rem; height:.4375rem; border:solid #fff; border-width:0 .0938rem .0938rem 0; transform:rotate(45deg); }
</style>

<div class="tbx-panel pulse-fade">

<h4>All states — actual size (14px) and 3×</h4>
<div class="sw">
  <div><input type="checkbox" class="tb" disabled></div>
  <div><span class="big" style="display:inline-block"><input type="checkbox" class="tb" disabled></span></div>
  <div><code>[ ]</code> <span class="lbl">pending</span></div>

  <div><input type="checkbox" class="tb" data-task-state="in_progress" disabled></div>
  <div><span class="big" style="display:inline-block"><input type="checkbox" class="tb" data-task-state="in_progress" disabled></span></div>
  <div><code>[/]</code> <span class="lbl">in progress — pulsing</span></div>

  <div><input type="checkbox" class="tb" data-task-state="completed" checked disabled></div>
  <div><span class="big" style="display:inline-block"><input type="checkbox" class="tb" data-task-state="completed" checked disabled></span></div>
  <div><code>[x]</code> <span class="lbl">completed</span></div>

  <div><input type="checkbox" class="tb" data-task-state="failed" disabled></div>
  <div><span class="big" style="display:inline-block"><input type="checkbox" class="tb" data-task-state="failed" disabled></span></div>
  <div><code>[!]</code> <span class="lbl">failed</span></div>

  <div><input type="checkbox" class="tb" data-task-state="skipped" disabled></div>
  <div><span class="big" style="display:inline-block"><input type="checkbox" class="tb" data-task-state="skipped" disabled></span></div>
  <div><code>[&gt;]</code> <span class="lbl">skipped</span></div>
</div>

<h4>The tick, old vs new — 3×</h4>
<div style="display:flex; gap:64px; align-items:center; padding: 14px 0 20px;">
  <div style="text-align:center">
    <span style="display:inline-block; transform:scale(3); transform-origin:center"><input type="checkbox" class="old" checked disabled></span>
    <div class="cap" style="margin-top:22px">current — rotated 1.5px borders</div>
  </div>
  <div style="text-align:center">
    <span style="display:inline-block; transform:scale(3); transform-origin:center"><input type="checkbox" class="tb" data-task-state="completed" checked disabled></span>
    <div class="cap" style="margin-top:22px">proposed — SVG, house icon path</div>
  </div>
</div>

<h4>Alignment, with wrapping text</h4>
<div class="two">
  <div>
    <p class="cap">Current — wrapped lines flow back under the box</p>
    <ol class="demo broken">
      <li><input type="checkbox" class="old" checked disabled>Add a <code>sortBy</code> field to the conversation store and persist it (write the load/save path) — verified by the existing settings round-trip test.</li>
      <li><input type="checkbox" class="old" disabled>Render a sort menu in the sidebar header (<code>web/js/views/sidebar.js</code>) — covered by the browser suite. <em>(in progress)</em></li>
    </ol>
  </div>
  <div>
    <p class="cap">Proposed — hanging indent, text forms one block</p>
    <ol class="demo fixed">
      <li><input type="checkbox" class="tb" data-task-state="completed" checked disabled>Add a <code>sortBy</code> field to the conversation store and persist it (write the load/save path) — verified by the existing settings round-trip test.</li>
      <li><input type="checkbox" class="tb" data-task-state="in_progress" disabled>Render a sort menu in the sidebar header (<code>web/js/views/sidebar.js</code>) — covered by the browser suite. <em>(in progress)</em></li>
    </ol>
  </div>
</div>

<h4>A full plan, all five states</h4>
<ol class="demo fixed">
  <li><input type="checkbox" class="tb" data-task-state="completed" checked disabled>Add a <code>sortBy</code> field to the conversation store and persist it (write the load/save path) — verified by the existing settings round-trip test.<br>Result: Demo only — nothing actually changed; store step marked done.</li>
  <li><input type="checkbox" class="tb" data-task-state="in_progress" disabled>Render a sort menu in the sidebar header (<code>web/js/views/sidebar.js</code>), covered by the browser suite. <em>(in progress)</em></li>
  <li><input type="checkbox" class="tb" data-task-state="failed" disabled>Unit-test the comparator in <code>web/js-tests/unit-tests/</code> and run it with <code>RUN='TestBrowser/^unit:&lt;name&gt;$'</code>. <em>(failed)</em></li>
  <li class="skip-text"><input type="checkbox" class="tb" data-task-state="skipped" disabled>Run the definitive full suite with <code>make test-all</code>. <em>(skipped)</em></li>
  <li><input type="checkbox" class="tb" disabled>Roll a terse <code>CHANGELOG.md</code> entry (~12-word one-liner).</li>
</ol>

<h4>Pulse: A — fill fades <span style="text-transform:none; letter-spacing:0; font-weight:400">(shown above)</span></h4>
<ol class="demo fixed pulse-fade" style="margin-bottom:14px">
  <li><input type="checkbox" class="tb" data-task-state="in_progress" disabled>Render a sort menu in the sidebar header. <em>(in progress)</em></li>
</ol>

<h4>Pulse: B — expanding ring</h4>
<ol class="demo fixed pulse-ring">
  <li><input type="checkbox" class="tb" data-task-state="in_progress" disabled>Render a sort menu in the sidebar header. <em>(in progress)</em></li>
</ol>

</div>

<div class="tbx-panel light" style="margin-top:14px">
<h4 style="color:#656d76">Light theme — same states</h4>
<div class="sw">
  <div><input type="checkbox" class="tb" disabled></div>
  <div><input type="checkbox" class="tb" data-task-state="in_progress" disabled></div>
  <div><span class="lbl">pending · in progress</span></div>
  <div><input type="checkbox" class="tb" data-task-state="completed" checked disabled></div>
  <div><input type="checkbox" class="tb" data-task-state="failed" disabled></div>
  <div><span class="lbl">completed · failed</span></div>
  <div><input type="checkbox" class="tb" data-task-state="skipped" disabled></div>
  <div></div>
  <div><span class="lbl">skipped</span></div>
</div>
<ol class="demo fixed" style="margin-top:14px">
  <li><input type="checkbox" class="tb" data-task-state="completed" checked disabled>Add a <code>sortBy</code> field to the conversation store and persist it — verified by the existing round-trip test.</li>
  <li><input type="checkbox" class="tb" data-task-state="in_progress" disabled>Render a sort menu in the sidebar header. <em>(in progress)</em></li>
</ol>
</div>

</div>

Three things I need you to rule on before I write any code:

**1. Pulse A or B?** A fades the fill; B pulses a ring outward and leaves the box solid. B stays legible throughout, A is quieter. Both go inert under \`prefers-reduced-motion\`.

**2. The marker syntax.** Since this is general markdown, the state has to live in the text — marked only recognises \`[ ]\` and \`[x]\`, so anything else needs a tokenizer extension in \`sdk/lib/markdown.js\`. I've used \`[/]\` in-progress, \`[!]\` failed, \`[>]\` skipped (roughly the Obsidian convention). These become part of what the LLM writes and reads, so they're a public contract, not just styling.

**3. Does the italic \`(in progress)\` suffix stay?** Once the box carries the state it's redundant to a reader — but it's the only signal a model gets if it doesn't grok \`[/]\`, and both context items document that string as *one rendering shared by the UI and the LLM*. My inclination is keep it and let the box be the fast visual read.

One thing worth flagging: the glyph colour is baked white into the data URI, so it can't follow a CSS variable. Every state is a filled box with a white mark, which is why they're all saturated fills rather than outlines — if you'd rather in-progress/skipped were outlined boxes with a tinted glyph, that needs the \`mask\` idiom on a wrapper element instead, and the checkbox can't be a bare \`<input>\` any more.`;
