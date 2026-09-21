//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the binary file viewer — the last-resort viewer that shows what is
 * known about a file nothing else will display.
 *
 * Two things are load-bearing. First, where it sits in resolution: it claims
 * every file, so it must lose to every viewer with any claim on the format, or
 * a source file renders as three facts instead of its text. Second, that it
 * says the facts it has — size and kind — rather than only that it can't help,
 * which is the whole reason it exists.
 * @module unit-tests/binary-viewer-test
 */

import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import BinaryFileViewer from '../../extensions/juggler-core/viewers/binary-file-viewer.js';
import TextFileViewer from '../../extensions/juggler-core/viewers/text-file-viewer.js';
import ImageFileViewer from '../../extensions/juggler-core/viewers/image-file-viewer.js';
import { createFileSource, toDescriptor } from '../../sdk/file-source.js';

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Install the real core viewers into the singleton registry, replacing whatever
 * the harness loaded, and return a restore function. Resolution order is the
 * thing under test, so the classes are the shipped ones rather than stand-ins.
 * @param {Array<[string, any]>} entries - [id, class] pairs in precedence order
 * @returns {() => void} Restores the registry's previous contents
 */
function installViewers(entries) {
  const reg = /** @type {any} */ (fileViewerRegistry);
  const saved = new Map(reg.items);
  reg.items.clear();
  for (const [id, cls] of entries) reg.items.set(id, cls);
  return () => {
    reg.items.clear();
    for (const [id, cls] of saved) reg.items.set(id, cls);
  };
}

/**
 * A binary file nothing has a format-specific claim on.
 * @returns {import('../../sdk/file-source.js').FileSource} The source
 */
function binarySource() {
  return createFileSource({
    path: 'build/app.icns',
    absPath: '/proj/build/app.icns',
    mime: '',
    size: 151552,
    isBinary: true,
    bytes: async () => new Uint8Array([0, 1, 2, 3]),
  });
}

/**
 * Render a source through the viewer and hand back the host it drew into.
 * @param {import('../../sdk/file-source.js').FileSource} source - The file
 * @returns {Promise<HTMLElement>} The populated host element
 */
async function render(source) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    await new BinaryFileViewer().render(source, host);
  } finally {
    host.remove();
  }
  return host;
}

/**
 * The value cell of a named fact row.
 * @param {HTMLElement} host - A rendered host
 * @param {string} label - The fact's label
 * @returns {string} The value text, or '' when there is no such row
 */
function factValue(host, label) {
  for (const row of host.querySelectorAll('.binary-file-fact')) {
    if (row.querySelector('.binary-file-fact__label')?.textContent === label) {
      return row.querySelector('.binary-file-fact__value')?.textContent || '';
    }
  }
  return '';
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  const restore = installViewers([
    ['text', TextFileViewer], ['image', ImageFileViewer], ['binary', BinaryFileViewer],
  ]);
  try {
    tally(check(
      fileViewerRegistry.resolve(toDescriptor(binarySource())) === BinaryFileViewer,
      'a binary file no viewer claims should resolve to the binary viewer', errors));

    tally(check(
      fileViewerRegistry.resolve(toDescriptor(createFileSource({
        path: 'src/main.js', mime: 'text/javascript', size: 400,
      }))) === TextFileViewer,
      'a source file must still resolve to the text viewer, not the catch-all', errors));

    tally(check(
      fileViewerRegistry.resolve(toDescriptor(createFileSource({
        path: 'docs/logo.png', mime: 'image/png', size: 400, isBinary: true,
      }))) === ImageFileViewer,
      'a format with a real viewer must beat the catch-all', errors));
  } finally {
    restore();
  }

  const host = await render(binarySource());
  tally(check(
    factValue(host, 'Size') === '148.0 KB',
    `the facts should include the size on disk, got ${JSON.stringify(factValue(host, 'Size'))}`, errors));
  tally(check(
    factValue(host, 'Kind') === '.icns file',
    `an unknown mime should fall back to the extension, got ${JSON.stringify(factValue(host, 'Kind'))}`, errors));
  tally(check(
    !!host.querySelector('.binary-file__note'),
    'the panel should still say why there is no content', errors));

  // A file whose mime the server did report names it rather than its extension.
  const known = await render(createFileSource({
    path: 'archive.zip', absPath: '/proj/archive.zip', mime: 'application/zip',
    size: 900, isBinary: true,
  }));
  tally(check(
    factValue(known, 'Kind') === 'application/zip',
    `a reported mime should be the kind, got ${JSON.stringify(factValue(known, 'Kind'))}`, errors));
  tally(check(
    factValue(known, 'Size') === '900 B',
    `a sub-kilobyte file should print its bytes, got ${JSON.stringify(factValue(known, 'Size'))}`, errors));

  // The modification time is the one fact no FileSource carries, so it is worth
  // a real file on disk and a real `stat` behind it: with no round trip there is
  // no row, and the failure would look exactly like a file that has none.
  const stamp = Math.random().toString(36).slice(2, 8);
  const dir = `binary-view-${stamp}`;
  const onDisk = `${dir}/blob.bin`;
  const project = createBoundOps(() => ({ workspaceId: '' }));
  try {
    await writeFileOp({ path: onDisk, content: 'bytes nothing will show\n' });
    const live = await render(createFileSource({
      path: onDisk, mime: '', size: 24, isBinary: true,
    }));
    tally(check(
      /\d{2}:\d{2}:\d{2}/.test(factValue(live, 'Modified')),
      `a file on disk should report when it changed, got ${JSON.stringify(factValue(live, 'Modified'))}`,
      errors));
  } finally {
    await project.copyTree({ to: '.', delete: [dir] });
  }

  // What the model sees is unchanged by any of the above: the file cannot be
  // read as text, and that is all extraction has to say.
  const extracted = await new BinaryFileViewer().extract(binarySource());
  tally(check(
    !extracted.text && !!extracted.warning?.includes('cannot be read as text'),
    `extract() must contribute a warning and no text, got ${JSON.stringify(extracted)}`, errors));

  return { passed, failed, errors };
}
