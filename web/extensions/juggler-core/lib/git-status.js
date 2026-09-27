//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * How the working tree is put into words, shared by the two surfaces that say
 * it: the sidebar info card and the Git pin. Only the phrasing lives here —
 * fetching and caching are the host's, and each surface builds its own DOM,
 * because a one-line summary and a full panel want different shapes out of the
 * same sentence fragments.
 * @module lib/git-status
 */

/**
 * @typedef {import('juggler/pinboard-item-type').PinGitRepo} GitRepo
 * @typedef {import('juggler/pinboard-item-type').PinGitFile} GitFile
 */

/**
 * Human label for a repo: a nested repo by its relative path, the root repo by
 * the project folder's name — a bare "." would be cryptic.
 * @param {string} root - Absolute project root path.
 * @param {string} repoPath - Repo path relative to root ('' for the root repo).
 * @returns {string} A short location label.
 */
export function repoLabel(root, repoPath) {
  if (repoPath) return repoPath;
  const base = (root || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base || 'repo';
}

/**
 * The counts, omitting a zero side entirely: "1 staged" beats "0 changed, 1
 * staged" every time it is read.
 * @param {GitRepo} repo - The repo to describe.
 * @returns {string} e.g. '2 changed, 1 staged', or '' when the tree is clean.
 */
export function countsPhrase(repo) {
  const parts = [];
  if (repo.changed > 0) parts.push(`${repo.changed} changed`);
  if (repo.staged > 0) parts.push(`${repo.staged} staged`);
  return parts.join(', ');
}

/**
 * Where the repo's HEAD is. A detached head is a state rather than a branch, so
 * it says so instead of showing a name it does not have.
 * @param {GitRepo} repo - The repo to describe.
 * @returns {string} e.g. 'develop', 'Detached head'.
 */
export function branchPhrase(repo) {
  if (repo.detached) return 'Detached head';
  return repo.branch || 'No branch';
}

/**
 * How far the branch has drifted from what it tracks. Empty when they agree, or
 * when there is nothing to compare against — an untracked branch is not behind,
 * it simply has no upstream, and saying "0 ahead, 0 behind" implies otherwise.
 * @param {GitRepo} repo - The repo to describe.
 * @returns {string} e.g. '1 ahead', '2 behind', '1 ahead, 2 behind', ''.
 */
export function divergencePhrase(repo) {
  if (!repo.upstream) return '';
  const parts = [];
  if (repo.ahead > 0) parts.push(`${repo.ahead} ahead`);
  if (repo.behind > 0) parts.push(`${repo.behind} behind`);
  return parts.join(', ');
}

/**
 * Git's status letters, spelled out.
 * @type {Map<string, string>}
 */
const STATUS_WORDS = new Map([
  ['M', 'Modified'],
  ['A', 'Added'],
  ['D', 'Deleted'],
  ['R', 'Renamed'],
  ['C', 'Copied'],
  ['T', 'Type changed'],
  ['U', 'Conflicted'],
  ['?', 'Untracked'],
]);

/**
 * The compact code shown against a file — git's own two letters, index side
 * first, with a space for an unmodified side. Anyone who reads `git status`
 * already knows this alphabet, and it stays one column wide however long the
 * word for it is.
 * @param {GitFile} file - The file to mark.
 * @returns {string} A two-character code, e.g. 'M ', ' M', '??'.
 */
export function fileCode(file) {
  const side = (/** @type {string} */ letter) => (letter && letter !== '.' ? letter : ' ');
  return `${side(file.index)}${side(file.worktree)}`;
}

/**
 * The same thing in words, for the code's tooltip: the alphabet is only obvious
 * to people who already know it.
 * @param {GitFile} file - The file to describe.
 * @returns {string} e.g. 'Modified', 'Staged, then modified again', 'Untracked'.
 */
export function fileStatusWords(file) {
  if (file.worktree === '?') return 'Untracked';
  const word = (/** @type {string} */ letter) =>
    (letter && letter !== '.' ? STATUS_WORDS.get(letter) || '' : '');
  const staged = word(file.index);
  const worktree = word(file.worktree);
  if (staged && worktree) return `${staged} and staged, then ${worktree.toLowerCase()} again`;
  if (staged) return `${staged} and staged`;
  return worktree || 'Unchanged';
}

/**
 * Which of the five things happened to a file, for the surfaces that colour its
 * status letters. A file carries two letters and they can disagree — staged one
 * way, changed another — so this answers with the most consequential of them: a
 * conflict first, then a file that has left the tree, then one that has just
 * joined it, then a move, with plain modification as the ordinary case.
 * @param {GitFile} file - The file to classify.
 * @returns {'conflicted'|'removed'|'added'|'renamed'|'modified'} What happened to it.
 */
export function fileTone(file) {
  if (file.conflicted || file.index === 'U' || file.worktree === 'U') return 'conflicted';
  const sides = [file.index, file.worktree];
  if (sides.includes('D')) return 'removed';
  if (file.worktree === '?' || sides.includes('A')) return 'added';
  if (sides.includes('R') || sides.includes('C')) return 'renamed';
  return 'modified';
}

/**
 * What to say when the server listed only some of the changed files. It knows
 * the real total, so this counts rather than trailing off.
 * @param {GitRepo} repo - The repo whose list was cut short.
 * @returns {string} The note, or '' when nothing was left out.
 */
export function truncationNote(repo) {
  if (!repo.truncated) return '';
  return `First ${repo.files.length} of ${repo.total} files.`;
}
