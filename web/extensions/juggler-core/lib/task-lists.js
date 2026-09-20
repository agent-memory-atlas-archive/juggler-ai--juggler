//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering a plan or a todo list as markdown, for the surfaces that show the
 * assistant's own checklist.
 *
 * Four of those exist: the plan and todo context items, which render into the
 * LLM's context block and into each tool-action row, and the Plan and Todo pins
 * on the pinboard. Since neither context item draws a standing transcript card,
 * the pins are the only place persistent plan and todo state is visible at all —
 * so it matters that all four agree, and they do by sharing the rendering here.
 *
 * One rendering serves both audiences: the viewer shows it through the standard
 * markdown block, and the model reads the same text in its context block and in
 * each step action's tool_result echo, so the list the user reads and the list
 * the model reads cannot drift apart. The options add to the model's copy only,
 * where it needs what the viewer conveys by other means — a step's executing
 * thread, which the transcript shows, and its status in words, which the viewer
 * draws as a distinct box. The traffic runs the other way once: the viewer's
 * blocks carry a progress bar, which is the count in the text made visible and
 * so tells the model nothing it is not already reading.
 * @module lib/task-lists
 */

import { createElement, injectStylesOnce, taskMarker, taskStatusWord } from 'juggler/ui';
import { createTextBlock } from 'juggler/item-utils';

injectStylesOnce('task-progress-styles', `
.task-progress {
  display: flex;
  height: 0.375rem;
  margin: -0.25rem 0 0.625rem;
  border-radius: 999rem;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.task-progress__segment--completed { background: var(--task-done-box); }
.task-progress__segment--in-progress { background: var(--task-progress-box); }
.task-progress__segment--failed { background: var(--task-failed-box); }
`);

/**
 * The states the bar colours, in the order it lays them out: what is done, what
 * is being done, what broke. Each takes the colour of its own tick box, so a
 * glance at the bar and a glance at the list say the same thing.
 *
 * Pending and skipped items are deliberately absent — they leave bare track,
 * which is what the "n/m completed" line above the bar already says. A todo list
 * spells only three of these states; it simply never draws the fourth.
 */
const BAR_STATES = [
  { status: 'completed', modifier: 'completed' },
  { status: 'in_progress', modifier: 'in-progress' },
  { status: 'failed', modifier: 'failed' },
];

/**
 * The indent a continuation line needs to stay inside item `n` of a numbered
 * list: the width of the marker `n. ` that opens it.
 *
 * It is the item's own width, never a constant — `9. ` is three characters
 * wide and `10. ` is four. A continuation line short of its marker's width
 * ends the list, and because an ordered list cannot interrupt a paragraph
 * unless it starts at 1, the escaped text then swallows every later item as
 * prose.
 * @param {number} n - The item's 1-based number.
 * @returns {string} Spaces matching the marker's width.
 */
function markerIndent(n) {
  return ' '.repeat(String(n).length + 2);
}

/**
 * Indent every line after the first to the width of its list marker, so
 * multi-line step or item text stays inside its own list item when rendered.
 *
 * Blank lines are emitted empty rather than padded: the indent is there to
 * hold a line inside its item, and a line with nothing on it holds nothing —
 * padding it only writes trailing whitespace.
 * @param {string} text - Step content, item content, or result summary.
 * @param {string} indent - The item's continuation indent, from {@link markerIndent}.
 * @returns {string} The text with continuation lines indented.
 */
function indentContinuation(text, indent) {
  return String(text || '')
    .split('\n')
    .map((line, i) => (i === 0 ? line : (line.trim() ? indent + line : '')))
    .join('\n');
}

/**
 * How much of a list is done. The pins show this as a tab badge, where there is
 * room for a count and not for a list.
 * @param {Array<{status?: string}>} items - Plan steps or todo items.
 * @returns {{completed: number, total: number}} Completed against total.
 */
export function taskProgress(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    completed: list.filter((item) => item?.status === 'completed').length,
    total: list.length,
  };
}

/**
 * Render a plan as markdown: a title heading, a status/progress line, and a
 * numbered task list — each step a tick box carrying its status, with any result
 * summary beneath it.
 * @param {{title?: string, status?: string, steps?: Array<Record<string, any>>}} planData - Plan data to render.
 * @param {object} [opts] - Rendering options.
 * @param {boolean} [opts.includeThreadIds] - Append the executing sub-thread's id to a step (LLM text only).
 * @param {boolean} [opts.statusWords] - Append the status in words to a step (LLM text only).
 * @returns {string} Markdown, or '' when the plan has no steps.
 */
export function renderPlanMarkdown(planData, opts = {}) {
  const steps = planData?.steps || [];
  if (steps.length === 0) return '';

  const { completed } = taskProgress(steps);
  const lines = [
    `# Plan${planData.title ? ': ' + planData.title : ''}`,
    `Status: ${planData.status || 'planning'} | Progress: ${completed}/${steps.length} completed`,
    ''
  ];

  for (const [i, step] of steps.entries()) {
    const indent = markerIndent(i + 1);
    let line = `${i + 1}. ${taskMarker(step.status)} ${indentContinuation(step.content, indent)}`;
    const words = opts.statusWords ? taskStatusWord(step.status) : '';
    if (words) {
      line += ` _(${words})_`;
    }
    if (opts.includeThreadIds && step.threadItemId) {
      line += ` (thread: ${step.threadItemId})`;
    }
    lines.push(line);
    if (step.result) {
      lines.push(`${indent}Result: ${indentContinuation(step.result, indent)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a todo list as markdown: a progress line and a numbered task list, each
 * item a tick box carrying its status.
 * @param {Array<Record<string, any>>} todos - The list to render.
 * @param {object} [opts] - Rendering options.
 * @param {boolean} [opts.statusWords] - Append the status in words to an item (LLM text only).
 * @returns {string} Markdown, or '' when the list is empty.
 */
export function renderTodoMarkdown(todos, opts = {}) {
  const list = todos || [];
  if (list.length === 0) return '';

  const { completed } = taskProgress(list);
  const lines = [
    '# Todo list',
    `Progress: ${completed}/${list.length} completed`,
    ''
  ];

  for (const [i, todo] of list.entries()) {
    const words = opts.statusWords ? taskStatusWord(todo.status) : '';
    const note = words ? ` _(${words})_` : '';
    const indent = markerIndent(i + 1);
    lines.push(`${i + 1}. ${taskMarker(todo.status)} ${indentContinuation(todo.content, indent)}${note}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * A list's progress as a bar: one segment per state in {@link BAR_STATES}, sized
 * to its share of the items, against a track the rest leaves bare.
 *
 * It is `aria-hidden`: the line it sits under gives the same count in words, and
 * every item below it carries its state in its tick box's label, so a reader who
 * cannot see the bar has already been told everything it draws.
 * @param {Array<Record<string, any>>} items - Plan steps or todo items.
 * @returns {HTMLElement|null} The bar, or null when there is nothing to measure.
 */
function createProgressBar(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;

  const bar = createElement('div', 'task-progress');
  bar.setAttribute('aria-hidden', 'true');
  for (const state of BAR_STATES) {
    const count = list.filter((item) => item?.status === state.status).length;
    if (count === 0) continue;
    const segment = createElement('div', `task-progress__segment task-progress__segment--${state.modifier}`);
    segment.style.width = `${(count / list.length) * 100}%`;
    bar.appendChild(segment);
  }
  return bar;
}

/**
 * A rendered list in the standard markdown block, with the progress bar under
 * the count line it illustrates.
 *
 * That line is the first paragraph of the rendered markdown — the title above it
 * is a heading and the items below it are a list — so there is one place for the
 * bar to go, and none at all when an empty list renders as nothing.
 * @param {string} markdown - The list as markdown, from one of the renderers above.
 * @param {Array<Record<string, any>>} items - The items that markdown was rendered from.
 * @returns {HTMLElement} Rendered markdown element.
 */
function createTaskListBlock(markdown, items) {
  const block = createTextBlock(markdown);
  const bar = createProgressBar(items);
  const countLine = bar && block.querySelector('.markdown > p');
  if (bar && countLine) countLine.after(bar);
  return block;
}

/**
 * The plan's markdown in the standard markdown block, under its progress bar.
 * @param {{title?: string, status?: string, steps?: Array<Record<string, any>>}} planData - Plan data to render.
 * @returns {HTMLElement} Rendered markdown element.
 */
export function createPlanBlock(planData) {
  return createTaskListBlock(renderPlanMarkdown(planData), planData?.steps || []);
}

/**
 * The todo list's markdown in the standard markdown block, under its progress bar.
 * @param {Array<Record<string, any>>} todos - The list to render.
 * @returns {HTMLElement} Rendered markdown element.
 */
export function createTodoBlock(todos) {
  return createTaskListBlock(renderTodoMarkdown(todos), todos || []);
}
