//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** @typedef {import('./diff-types.js').DiffLine} DiffLine */
/** @typedef {import('./diff-types.js').DiffHunk} DiffHunk */

/**
 * One line of the diff before it is numbered: what happened to it, and its
 * text. Line numbers are derived from the finished sequence of these.
 * @typedef {{type: 'equal'|'add'|'remove', content: string}} DiffOp
 */

/**
 * The largest changed region worth diffing here, as cells of the table the LCS
 * pass builds: one row per differing old line, one column per differing new
 * one, computed on the spot in the only thread there is. A full rewrite of a
 * two-thousand-line file sits at this budget and takes on the order of a tenth
 * of a second; past it the caller is told the diff was refused, because a panel
 * that stopped answering would be a worse outcome than not drawing.
 *
 * Only the region that differs is counted. Identical leading and trailing lines
 * are matched before the table is built, so file size alone never reaches this
 * — an edit to one line of a ten-thousand-line file costs one cell.
 */
const DIFF_CELL_BUDGET = 4_000_000;

/**
 * Slide every block of pure insertions or pure deletions as far down the file
 * as it can go: while the context line just below a block repeats the block's
 * own first line, the two are interchangeable, and the diff reads in file order
 * only if the block is the later of the two. A closing brace inserted with the
 * function below it is the everyday case — aligned the other way, the reader is
 * shown the brace that closes the function *above* being added.
 *
 * The walk over the table already matches every line it can as early as it can,
 * which places its own blocks this way. The prefix and suffix trim does not:
 * matching identical trailing lines from the end inwards can leave a block one
 * or more lines above where the table would have put it. This puts them back,
 * and is a no-op on anything already in position.
 * @param {DiffOp[]} ops - The ops, edited in place.
 * @returns {void}
 */
function slideChangesDown(ops) {
  let at = 0;
  while (at < ops.length) {
    const kind = /** @type {DiffOp} */ (ops[at]).type;
    if (kind === 'equal') { at++; continue; }

    let end = at;
    while (end < ops.length && /** @type {DiffOp} */ (ops[end]).type === kind) end++;

    // Only a block of one kind can slide: where an addition and a removal meet,
    // the lines below belong to whichever of them the table paired them with.
    while (end < ops.length
      && /** @type {DiffOp} */ (ops[end]).type === 'equal'
      && /** @type {DiffOp} */ (ops[end]).content === /** @type {DiffOp} */ (ops[at]).content) {
      // The two ends hold the same text, so exchanging their kinds rotates the
      // whole block down one line.
      /** @type {DiffOp} */ (ops[at]).type = 'equal';
      /** @type {DiffOp} */ (ops[end]).type = kind;
      at++; end++;
    }

    at = end;
  }
}

/**
 * Build a line-level diff using a simple LCS algorithm.
 *
 * Identical leading and trailing lines belong to every longest common
 * subsequence of the two files, so they are matched greedily and emitted as
 * context; the table covers only what lies between them. That is what keeps a
 * small edit to a large file cheap, and it is what `DIFF_CELL_BUDGET` is
 * measured against.
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [startLineNumber=1]
 * @returns {DiffLine[]|null} The line-level differences, or null when the
 *   changed region is past the budget.
 */
function buildDiffLines(oldText, newText, startLineNumber = 1) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');

  let lo = 0;
  let oHi = oldLines.length;
  let nHi = newLines.length;
  while (lo < oHi && lo < nHi && oldLines[lo] === newLines[lo]) lo++;
  while (oHi > lo && nHi > lo && oldLines[oHi - 1] === newLines[nHi - 1]) { oHi--; nHi--; }

  // Lines of the changed region on each side. The rest is common context.
  const m = oHi - lo;
  const n = nHi - lo;
  if (m * n > DIFF_CELL_BUDGET) return null;

  /** @type {DiffOp[]} */
  const ops = [];
  for (let k = 0; k < lo; k++) {
    ops.push({ type: 'equal', content: /** @type {string} */ (oldLines[k]) });
  }

  // DP table for LCS lengths, over the changed region only: index i counts from
  // oldLines[lo], index j from newLines[lo].
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const dpi = /** @type {number[]} */ (dp[i]); // bounded: dp has m+1 rows
    const dpi1 = /** @type {number[]} */ (dp[i + 1]);
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[lo + i] === newLines[lo + j]) dpi[j] = (dpi1[j + 1] ?? 0) + 1;
      else dpi[j] = Math.max(dpi1[j] ?? 0, dpi[j + 1] ?? 0);
    }
  }

  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[lo + i] === newLines[lo + j]) {
      ops.push({ type: 'equal', content: /** @type {string} */ (oldLines[lo + i]) });
      i++; j++;
    } else if (i < m && (j === n || (dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0))) {
      // Prefer emitting the removal on a tie so that within a modified block
      // the '-' line precedes the '+' line, matching POSIX unified diff order.
      ops.push({ type: 'remove', content: /** @type {string} */ (oldLines[lo + i]) });
      i++;
    } else {
      ops.push({ type: 'add', content: /** @type {string} */ (newLines[lo + j]) });
      j++;
    }
  }

  for (let k = oHi; k < oldLines.length; k++) {
    ops.push({ type: 'equal', content: /** @type {string} */ (oldLines[k]) });
  }

  slideChangesDown(ops);

  // Numbering comes last: sliding a block moves lines between the sides, so a
  // line's number is only known once every op is in its final place.
  /** @type {DiffLine[]} */
  const out = [];
  let oldLineNum = startLineNumber;
  let newLineNum = startLineNumber;
  for (const op of ops) {
    if (op.type === 'equal') {
      out.push(/** @type {DiffLine} */ ({ type: 'equal', content: op.content, oldLineNum, newLineNum }));
      oldLineNum++; newLineNum++;
    } else if (op.type === 'remove') {
      out.push(/** @type {DiffLine} */ ({ type: 'remove', content: op.content, oldLineNum, newLineNum: null }));
      oldLineNum++;
    } else {
      out.push(/** @type {DiffLine} */ ({ type: 'add', content: op.content, oldLineNum: null, newLineNum }));
      newLineNum++;
    }
  }

  return out;
}

/**
 * Group diff lines into hunks with context.
 * @param {DiffLine[]} lines
 * @param {number} [startLineNumber=1]
 * @param {number} [contextLines=3]
 * @returns {DiffHunk[]} An array of DiffHunk objects, where each hunk represents a contiguous block of changes.
 */
function groupIntoHunks(lines, startLineNumber = 1, contextLines = 3) {
  if (!lines || lines.length === 0) return [];

  const hasChanges = lines.some(l => l.type !== 'equal');
  if (!hasChanges) {
    const first = /** @type {DiffLine} */ (lines[0]); // bounded: length > 0 checked above
    return [/** @type {DiffHunk} */ ({
      oldStart: /** @type {number} */ (first.oldLineNum || startLineNumber),
      oldCount: lines.length,
      newStart: /** @type {number} */ (first.newLineNum || startLineNumber),
      newCount: lines.length,
      lines: [...lines]
    })];
  }

  /** @type {DiffHunk[]} */
  const hunks = [];
  let currentHunk = null;
  /** @type {DiffLine[]} */
  let contextBuffer = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = /** @type {DiffLine} */ (lines[idx]); // bounded by idx < lines.length

    if (line.type === 'equal') {
      if (currentHunk) {
        contextBuffer.push(line);

        if (contextBuffer.length >= contextLines) {
          // Another change close behind keeps the hunk open, so the lines
          // between the two changes stay in it as interior context.
          let hasMore = false;
          for (let k = idx + 1; k < Math.min(idx + contextLines * 2 + 1, lines.length); k++) {
            if (/** @type {DiffLine} */ (lines[k]).type !== 'equal') { hasMore = true; break; }
          }

          if (!hasMore) {
            const ctx = contextBuffer.slice(0, contextLines);
            currentHunk.lines.push(...ctx);
            finalizeHunkStarts(currentHunk, startLineNumber);
            hunks.push(currentHunk);
            currentHunk = null;
            contextBuffer = [];
          } else {
            currentHunk.lines.push(...contextBuffer);
            contextBuffer = [];
          }
        }
      } else {
        contextBuffer.push(line);
        if (contextBuffer.length > contextLines) contextBuffer.shift();
      }
    } else {
      if (!currentHunk) {
        currentHunk = /** @type {DiffHunk} */ ({ oldStart: startLineNumber, oldCount: 0, newStart: startLineNumber, newCount: 0, lines: [...contextBuffer] });
      } else {
        // Context held back as a possible hunk tail turned out to be interior:
        // it must land ahead of this change, not after it.
        currentHunk.lines.push(...contextBuffer);
      }
      contextBuffer = [];
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk) {
    // Whatever context is left at end of input is this hunk's tail.
    if (contextBuffer.length > 0) currentHunk.lines.push(...contextBuffer.slice(0, contextLines));
    finalizeHunkStarts(currentHunk, startLineNumber);
    hunks.push(currentHunk);
  }

  for (const h of hunks) {
    h.oldCount = 0; h.newCount = 0;
    for (const l of h.lines) {
      if (l.type === 'remove' || l.type === 'equal') h.oldCount++;
      if (l.type === 'add' || l.type === 'equal') h.newCount++;
    }
  }

  return hunks;
}

/**
 * Calculates and sets the correct start line numbers for a diff hunk.
 * @param {DiffHunk} hunk - The diff hunk to finalize.
 * @param {number} fallbackStart - The fallback start line number if no old/new lines are found.
 */
function finalizeHunkStarts(hunk, fallbackStart) {
  const firstOld = hunk.lines.find(l => l.oldLineNum !== null);
  const firstNew = hunk.lines.find(l => l.newLineNum !== null);
  hunk.oldStart = (firstOld && firstOld.oldLineNum !== null) ? /** @type {number} */ (firstOld.oldLineNum) : fallbackStart;
  hunk.newStart = (firstNew && firstNew.newLineNum !== null) ? /** @type {number} */ (firstNew.newLineNum) : fallbackStart;
}

/**
 * Computes the diff between two texts and groups them into hunks.
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [startLineNumber=1]
 * @param {number} [contextLines=3]
 * @returns {DiffHunk[]|null} The grouped changes with context, or null when the
 *   region that differs is past `DIFF_CELL_BUDGET` and no diff was computed.
 */
export function computeDiff(oldText, newText, startLineNumber = 1, contextLines = 3) {
  const diffLines = buildDiffLines(oldText, newText, startLineNumber);
  if (diffLines === null) return null;
  const hunks = groupIntoHunks(diffLines, startLineNumber, contextLines);
  return hunks;
}
