//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { createFileContentBlock, formatFileContentForLLM } from 'juggler/item-utils';
import { languageForPath } from 'juggler/ui';

/**
 * TextFileViewer — the fallback viewer, and the one that handles almost
 * everything. Renders a file as syntax-highlighted text, and extracts it as the
 * line-numbered `<file>` block the model reads.
 *
 * Markdown is the exception, and the branch is one level down, in
 * `createFileContentBlock`: it renders as formatted prose rather than numbered
 * lines. Anything reading line numbers back out of the rendered DOM gets none
 * from a markdown file — see `utils/code-selection`, which falls back to naming
 * the file alone.
 *
 * It sets `matchAll`, so it is a candidate for every file; `priority: 0` puts it
 * in the fallback tier beneath any viewer with a real claim on the format. Its
 * `claims()` veto on binary files is what lets a binary with no dedicated viewer
 * fall past it to the binary viewer below, which describes what it cannot show.
 * @augments FileViewer
 */
class TextFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'text',
    name: 'Text',
    version: '1.0.0',
    description: 'Renders text and source files with syntax highlighting',
    matchAll: true,
    priority: 0,
  };

  /**
   * Decline binary files. This is the *only* place `isBinary` is treated as a
   * verdict — for every other viewer it stays advisory, so an image or PDF
   * viewer still claims its (binary) format.
   * @param {import('juggler/file-viewer').FileDescriptor} descriptor - File metadata
   * @returns {boolean|undefined} False for binary content, otherwise no opinion
   */
  static claims(descriptor) {
    return descriptor.isBinary ? false : undefined;
  }

  /**
   * Language identifier for a source: the server's detection when the transport
   * carried one, else the path. A dropped file never reaches the server, so it
   * arrives with no `language` and only the path can answer.
   * @param {import('juggler/file-source').FileSource} source - The file
   * @returns {string} Language identifier for syntax highlighting
   */
  static languageFor(source) {
    if (source.language) return source.language;
    return languageForPath(source.path || '');
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to render
   * @param {HTMLElement} host - Element to render into
   * @returns {Promise<(() => void)|void>} Teardown when the block windows a long file
   */
  async render(source, host) {
    const text = source.text ?? new TextDecoder().decode(await source.bytes());
    const block = createFileContentBlock({
      content: text,
      language: TextFileViewer.languageFor(source),
      lineNumberStart: source.lineOffset || 1,
    });
    host.appendChild(block);
    // A file long enough to be rendered a window at a time is subscribed to its
    // scroller; hand that subscription to the host's teardown.
    const destroy = /** @type {any} */ (block).destroy;
    return typeof destroy === 'function' ? destroy : undefined;
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to extract
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} The model-facing text
   */
  async extract(source) {
    const text = source.text ?? new TextDecoder().decode(await source.bytes());
    return {
      text: formatFileContentForLLM({
        content: text,
        path: source.path,
        lineOffset: source.lineOffset || 1,
        lineCount: source.lineCount,
        totalLines: source.totalLines,
      }),
    };
  }
}

export default TextFileViewer;
