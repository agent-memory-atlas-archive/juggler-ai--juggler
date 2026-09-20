//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Markdown sanitizer test.
 *
 * The frontend renders LLM/user/tool output through renderMarkdown into the
 * DOM via innerHTML in many places. This test pins the sanitizer behavior so
 * a regression in escaping turns into a red test rather than an XSS vector.
 *
 * The renderer is not a full sanitizer (marked.js by itself isn't): it relies
 * on escapeXmlTagsForMarkdown to neutralize raw HTML/script content outside
 * code blocks. These cases lock that in.
 * @module unit-tests/markdown-sanitizer-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { renderMarkdown, renderAssistantContent } = await import('../../sdk/lib/markdown.js');

  /**
   * The class the sanitizer boxes authored HTML in. Pinned here rather than
   * imported because it is a contract with patterns/markdown.css, which is what puts the
   * `contain` on the box: if the name moves, the containment silently stops.
   */
  const HTML_SCOPE_CLASS = 'markdown-html-scope';

  /**
   * @param {string} html - Rendered HTML.
   * @returns {DocumentFragment} The parsed (inert) fragment.
   */
  const parse = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content;
  };

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('escapes <script> tags', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert(!html.includes('<script>'), `output should not contain raw <script>: ${html}`);
    assert(!html.toLowerCase().includes('alert(1)') || html.includes('&'), `script payload must be neutralized: ${html}`);
  });

  run('escapes <img onerror>', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    assert(!html.includes('<img'), `output should not contain raw <img>: ${html}`);
  });

  run('escapes <iframe>', () => {
    const html = renderMarkdown('<iframe src="javascript:alert(1)"></iframe>');
    assert(!html.includes('<iframe'), `output should not contain raw <iframe>: ${html}`);
  });

  run('escapes inline event handlers in attributes', () => {
    const html = renderMarkdown('<a href="#" onclick="alert(1)">x</a>');
    // The raw <a ...> must be escaped; an unescaped element with an
    // inline handler would be a live XSS sink. The escaped form
    // (`&lt;a ...&gt;`) is fine — it's text content, not markup.
    assert(!/<a\b[^>]*\bonclick=/i.test(html), `unescaped <a onclick=...> must not survive: ${html}`);
  });

  run('preserves code blocks (script inside ``` is data, not markup)', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    assert(html.includes('<code'), `code block should render: ${html}`);
    assert(!/<script>(?!&lt;)/.test(html), `script inside fence must be escaped: ${html}`);
  });

  run('allows safe HTML in assistant content', () => {
    const html = renderAssistantContent('<h2>Overview</h2><p><strong>Ready</strong></p>');
    assert(html.includes('<h2>Overview</h2>'), `heading should render: ${html}`);
    assert(html.includes('<strong>Ready</strong>'), `inline HTML should render: ${html}`);
  });

  run('sanitizes unsafe HTML in assistant content', () => {
    const html = renderAssistantContent('<a href="javascript:alert(1)" onclick="alert(1)">x</a><script>alert(2)</script>');
    assert(!/href="javascript:/i.test(html), `javascript URL must not survive: ${html}`);
    assert(!/\bonclick=/i.test(html), `event handler must not survive: ${html}`);
    assert(!html.includes('<script>'), `script must not survive: ${html}`);
  });

  run('allows declarative inline SVG in assistant content', () => {
    const html = renderAssistantContent(
      '<svg width="120" height="80" viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="sky"><stop offset="0%" stop-color="#1a2a6c"/>' +
      '<stop offset="100%" stop-color="#fdbb2d"/></linearGradient></defs>' +
      '<rect width="120" height="80" fill="url(#sky)"/><circle cx="60" cy="40" r="15" fill="#fff"/>' +
      '</svg>'
    );
    assert(html.includes('<svg'), `SVG should render: ${html}`);
    assert(html.includes('<linearGradient'), `gradient should render: ${html}`);
    assert(html.includes('fill="url(#sky)"'), `paint reference should survive: ${html}`);
    assert(html.includes('<circle'), `shape should render: ${html}`);
  });

  run('sanitizes executable and external SVG features', () => {
    const html = renderAssistantContent(
      '<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>' +
      '<use href="https://example.com/shape.svg#star"/><circle onclick="alert(2)" r="5"/></svg>'
    );
    assert(!html.includes('<script'), `script must not survive: ${html}`);
    assert(!html.includes('<foreignObject'), `foreignObject must not survive: ${html}`);
    assert(!/\bonload=|\bonclick=/i.test(html), `event handlers must not survive: ${html}`);
    assert(!/<use\b/i.test(html), `external SVG reference must not survive: ${html}`);
  });

  run('plain markdown still works', () => {
    const html = renderMarkdown('**bold** and _italic_');
    assert(html.includes('<strong>bold</strong>'), `bold should render: ${html}`);
    assert(html.includes('<em>italic</em>'), `italic should render: ${html}`);
  });

  run('autolink does not break on javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    assert(!/href="javascript:/i.test(html), `javascript: URL must not appear in href: ${html}`);
  });

  run('neutralizes a custom element that slips past the backtick pre-escaper', () => {
    // Real bug (thread-summary "mirror composer"): an unbalanced backtick
    // earlier in the text desyncs the naive escapeXmlTagsForMarkdown pass from
    // marked's own code-span parsing. The escaper believes it is inside a code
    // span (so it passes `<composer-box>` through verbatim) while marked treats the
    // lone backtick as a literal and emits the tag as raw HTML — which the
    // browser then upgrades into a live, in-sync copy of the composer.
    const html = renderMarkdown('use the `-x flag, then <composer-box></composer-box> shows up');
    assert(!/<composer-box\b/i.test(html), `raw <composer-box> must not survive into the DOM: ${html}`);
    assert(!/<[a-z][a-z0-9]*-[a-z0-9-]*/i.test(html), `no raw custom-element (hyphenated) tag may survive: ${html}`);
  });

  run('neutralizes raw custom elements even with escapeXml disabled', () => {
    // The plan renderer calls renderMarkdown(..., { escapeXml: false }), so no
    // pre-escaping runs at all. The post-parse output sanitizer is the
    // authoritative boundary and must still strip custom elements.
    const html = renderMarkdown('<composer-box></composer-box> and <my-widget>x</my-widget>', { escapeXml: false });
    assert(!/<composer-box\b/i.test(html), `raw <composer-box> must not survive: ${html}`);
    assert(!/<my-widget\b/i.test(html), `raw custom element must not survive: ${html}`);
  });

  run('strips inline event handlers from otherwise-allowed tags', () => {
    // With escapeXml off, a plain <a> is allowed markup, but an inline handler
    // on it is a live XSS sink and must be removed by the sanitizer.
    const html = renderMarkdown('<a href="#" onclick="alert(1)">x</a>', { escapeXml: false });
    assert(!/\bonclick=/i.test(html), `inline event handler must be stripped: ${html}`);
  });

  run('applies a message\'s own <style> instead of printing it', () => {
    // A message illustrating a design carries its CSS in a <style>. Dropping the
    // element to escaped text (the old behaviour for any unlisted tag) spilled
    // the whole stylesheet into the reply as prose.
    const html = renderAssistantContent('<div class="demo"><style>\n.demo p { color: red; }\n</style><p>x</p></div>');
    assert(html.includes('<style>'), `style element should survive: ${html}`);
    assert(!html.includes('&lt;style'), `style tag must not be printed as text: ${html}`);
    assert(!/&lt;\/style/i.test(html), `closing style tag must not be printed as text: ${html}`);
  });

  run('confines authored CSS to the message that brought it', () => {
    const html = renderAssistantContent('<style>p { color: red; } body { margin: 0; }</style><p>x</p>');
    const scope = /data-markdown-scope="([^"]+)"/.exec(html);
    assert(scope !== null, `content should be boxed in a scope element: ${html}`);
    const selector = `[data-markdown-scope="${scope?.[1]}"]`;
    assert(html.includes(`${selector} p`), `selector should be scoped: ${html}`);
    // `body` means "the thing I am in", so it retargets onto the scope element
    // rather than escaping to the real document body.
    assert(!/(^|[^\]])\bbody\s*{/.test(html), `body selector must not survive unscoped: ${html}`);

    // Two elements: the outer box holds the containment, the inner one holds the
    // scope id. Authored CSS can only ever name the inner one, so a `position:
    // fixed` it sets on itself still resolves against the contained box.
    const box = parse(html).querySelector(`.${HTML_SCOPE_CLASS}`);
    assert(box !== null, `content should sit in a contained box: ${html}`);
    assert(!box?.hasAttribute('data-markdown-scope'), `the contained box must not be nameable by the CSS it holds: ${html}`);
    assert(box?.querySelector('[data-markdown-scope]') !== null, `scope element should sit inside the box: ${html}`);
  });

  run('scopes selectors without breaking selector lists', () => {
    const html = renderAssistantContent('<style>:is(h1, h2), p[title="a,b"] { color: red; }</style><p>x</p>');
    assert(/:is\(\s*h1,\s*h2\s*\)/.test(html), `functional pseudo-class must keep its comma: ${html}`);
    assert(/\[title="a,b"\]/.test(html), `attribute value must keep its comma: ${html}`);
  });

  run('renames keyframes so a message cannot redefine an app animation', () => {
    const html = renderAssistantContent(
      '<style>@keyframes spin { from { opacity: 0 } to { opacity: 1 } } .x { animation: spin 1s infinite; }</style><p>x</p>'
    );
    assert(!/@keyframes\s+spin\s*{/.test(html), `keyframes name must be made unique: ${html}`);
    assert(/@keyframes\s+spin-md\d+/.test(html), `keyframes should be renamed per render: ${html}`);
    assert(/animation-name:\s*spin-md\d+|animation:[^;]*spin-md\d+/.test(html), `animation reference should follow the rename: ${html}`);
  });

  run('drops CSS that fetches on the message\'s behalf', () => {
    const html = renderAssistantContent(
      '<style>@import url("https://example.com/x.css"); @font-face { font-family: t; src: url("https://example.com/t.woff2") }</style><p>x</p>'
    );
    assert(!/@import/i.test(html), `@import must not survive: ${html}`);
    assert(!/@font-face/i.test(html), `@font-face must not survive: ${html}`);
  });

  run('a closing style tag inside CSS cannot break out of the style element', () => {
    const html = renderAssistantContent('<style>p::after { content: "</style><img src=x onerror=alert(1)>"; }</style><p>x</p>');
    // A literal `</style>` in a CSS string ends the element at the HTML parse —
    // in every engine; that's why inline scripts write `<\/script>`. So the
    // `<img>` here is real markup *after* the style block, and gets sanitized
    // like any other markup; what matters is that nothing smuggles a live sink
    // through the CSS itself, and the style content stays balanced CSS.
    assert(!/\bonerror=/i.test(html), `event handler must not survive: ${html}`);
    const style = parse(html).querySelector('style');
    assert(style !== null, `style element should survive: ${html}`);
    // cssText re-serialised from the CSSOM: balanced, no markup inside.
    assert(!/<img/i.test(style?.textContent || ''), `style content must stay CSS, not markup: ${style?.textContent}`);
  });

  run('unbalanced braces cannot close the scope early', () => {
    const html = renderAssistantContent('<style>.a { color: red; } } .escaped { display: none; }</style><p>x</p>');
    // Re-serialising from the CSSOM guarantees balance, so nothing can be left
    // sitting at the top level where it would apply to the whole app.
    assert(!/(^|\s)\.escaped\s*{/.test(html), `stray rule must not survive unscoped: ${html}`);
  });

  run('keeps inline style attributes, boxed', () => {
    const html = renderAssistantContent('<div style="color: red">x</div>');
    assert(/style="color: ?red"/i.test(html), `inline style should survive: ${html}`);
    assert(html.includes(HTML_SCOPE_CLASS), `inline style should still be boxed: ${html}`);
  });

  run('plain markdown is not boxed', () => {
    // The wrapper only appears for content that brought CSS; everything else
    // must render byte-for-byte as it did before.
    const html = renderMarkdown('**bold** and a [link](https://example.com)');
    assert(!html.includes(HTML_SCOPE_CLASS), `plain markdown should not gain a wrapper: ${html}`);
    assert(!html.includes('data-markdown-scope'), `plain markdown should not gain a scope: ${html}`);
  });

  run('user content still gets its style tag escaped', () => {
    // escapeXml is on for user/tool text: a <style> there is something the user
    // typed *about*, not a stylesheet to run.
    const html = renderMarkdown('<style>p { color: red }</style>');
    assert(!/<style\b/i.test(html), `style must not become live CSS in escaped content: ${html}`);
  });

  run('scopes rules inside @media and @supports blocks', () => {
    // The shape design previews actually arrive in: a wide/narrow split guarded
    // by a media query, with prefers-reduced-motion for the animation.
    const css = '@media (max-width: 46rem) { p { color: red } } ' +
      '@supports (appearance: none) { input { margin: 0 } }';
    const html = renderAssistantContent(`<style>${css}</style><p>x</p>`);
    const sheet = parse(html).querySelector('style')?.textContent || '';
    assert(/@media[^{]*\{[^}]*\[data-markdown-scope[^}]*\}/.test(sheet), `rule inside @media should be scoped: ${sheet}`);
    assert(/@supports[^{]*\{[^}]*\[data-markdown-scope[^}]*\}/.test(sheet), `rule inside @supports should be scoped: ${sheet}`);
    // A selector *outside* any block must not have leaked through unscoped.
    assert(!/\n\s*p \{/.test(sheet) && !/^\s*p \{/.test(sheet), `no unscoped p rule may survive: ${sheet}`);
  });

  run('a stylesheet with blank lines is not cut in half by markdown blocks', () => {
    // CommonMark ends an HTML block that opened with <div> at the first blank
    // line, and stylesheets are conventionally written with blank lines between
    // sections. Without the keepStyleBlocksIntact pre-pass the second half of
    // this CSS falls out of the block and parses as prose.
    const html = renderAssistantContent(
      '<div class="d">\n<style>\n.d a { color: red; }\n\n.d b { color: blue; }\n</style>\n<p><a>x</a> <b>y</b></p>\n</div>'
    );
    const css = parse(html).querySelector('style')?.textContent || '';
    assert(css.includes('.d a'), `rule before the blank line should survive: ${css}`);
    assert(css.includes('.d b'), `rule after the blank line must survive too: ${css}`);
  });

  run('blank lines outside style blocks are untouched', () => {
    // The pre-pass must not eat the blank lines markdown itself needs.
    const html = renderAssistantContent('<style>.x { color: red }</style>\n\npara one\n\npara two');
    const frag = parse(html);
    assert(frag.querySelectorAll('p').length === 2, `two paragraphs should survive: ${frag.childNodes.length} top-level nodes`);
  });

  run('a tilde beside a code span does not desync the spans after it', () => {
    // A `~` immediately followed by a backtick can be read as one delimiter run,
    // swallowing the opening backtick of the code span. Every span after it on
    // the line then inverts, and a `<tag>` that should have been code content
    // lands in the output as live markup for the sanitizer to strip — which
    // reads as the rest of the line turning into visible HTML.
    const html = renderMarkdown('see (`fn`, ~`:1097`) then `click` and `<menu class="x">` end');
    const codes = Array.from(parse(html).querySelectorAll('code')).map((c) => c.textContent);
    assert(codes.includes(':1097'), `the span after the tilde should be code: ${html}`);
    assert(codes.includes('click'), `the next span should still be code: ${html}`);
    assert(codes.includes('<menu class="x">'), `the tag must stay code content: ${html}`);
    assert(!/<menu/i.test(html), `no raw <menu> may reach the output: ${html}`);
  });

  run('strikethrough still renders', () => {
    // The tilde is load-bearing for gfm strikethrough, so pin it alongside.
    const frag = parse(renderMarkdown('~~gone~~ and `kept`'));
    assert(frag.querySelector('del')?.textContent === 'gone', `~~gone~~ should be a <del>: ${frag.textContent}`);
    assert(frag.querySelector('code')?.textContent === 'kept', `the code span should survive: ${frag.textContent}`);
  });

  return { passed, failed, errors };
}
