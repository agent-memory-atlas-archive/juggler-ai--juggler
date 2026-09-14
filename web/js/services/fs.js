//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node.js `fs.promises`-compatible filesystem API backed by Go ops.
 * @module fs
 */

import { readFileLoad, writeFileOp, statOp, mkdirOp } from './ops-api.js';
import { treeExpandDirectory } from './ops-api.js';

/**
 * Lightweight Dirent-like object returned by readdir with `withFileTypes`.
 */
class Dirent {
  /**
   * @param {string} name - Entry name
   * @param {boolean} isDir - Whether this entry is a directory
   */
  constructor(name, isDir) {
    this.name = name;
    this._isDir = isDir;
  }

  /** @returns {boolean} True if this entry is a regular file */
  isFile() { return !this._isDir; }
  /** @returns {boolean} True if this entry is a directory */
  isDirectory() { return this._isDir; }
}

/**
 * Stats object returned by stat(), matching Node.js fs.Stats shape.
 */
class Stats {
  /** @param {{size?: number, modified?: number, isFile?: boolean, isDirectory?: boolean}} raw - Raw response from the stat op */
  constructor(raw) {
    /** @type {number} */
    this.size = /** @type {number} */ (raw.size ?? 0);
    /** @type {number} */
    this.mtimeMs = /** @type {number} */ (raw.modified ?? 0);
    /** @type {Date} */
    this.mtime = new Date(/** @type {number} */ (this.mtimeMs));
    /** @type {boolean} */
    this._isFile = /** @type {boolean} */ (raw.isFile ?? false);
    /** @type {boolean} */
    this._isDir = /** @type {boolean} */ (raw.isDirectory ?? false);
  }

  /** @returns {boolean} True if this is a regular file */
  isFile() { return this._isFile; }
  /** @returns {boolean} True if this is a directory */
  isDirectory() { return this._isDir; }
}

/**
 * Filesystem error with a Node.js-style `code` property.
 */
class FileSystemError extends Error {
  /**
   * @param {string} code - Error code (e.g. 'ENOENT')
   * @param {string} message - Error detail
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * Standard filesystem API backed by Go ops.
 */
export class FileSystem {
  /**
   * @param {string[]} [allowedPaths] - Standing allowed-paths grant (session +
   *   conversation + project root). Forwarded as the dedicated allowed-paths
   *   transport arg to the read/search/tree ops (NOT inside params) so this
   *   filesystem can reach user-approved locations outside the project root.
   *   Defaults to project-root-only when omitted.
   * @param {string} [workspaceId] - The workspace this filesystem is rooted in,
   *   carried on every op as the dedicated top-level transport arg. Omitted (or
   *   '') is the project, which is what every filesystem meant before
   *   workspaces existed; relative paths then resolve against the project root
   *   rather than the caller's tree.
   */
  constructor(allowedPaths = [], workspaceId = '') {
    /** @type {string[]} */
    this._allowedPaths = Array.isArray(allowedPaths) ? allowedPaths : [];
    /** @type {string} */
    this._workspaceId = typeof workspaceId === 'string' ? workspaceId : '';
    /**
     * Files successfully read through this instance: path → the backend's
     * contentHash of the raw on-disk bytes (null when the backend reported
     * none). The query_code tool records this in its tool-action result so
     * the read-before-mutate freshness guard (read-history.js) can credit a
     * sandbox script's reads. Capped so a sweep over thousands of files can't
     * bloat the transcript — files beyond the cap simply earn no credit.
     * @type {Map<string, string|null>}
     */
    this.filesRead = new Map();
  }

  /** Maximum number of read records retained per instance. */
  static MAX_FILES_READ = 200;

  /**
   * Read a file's content.
   * @param {string} filePath - Path to file
   * @param {string|{encoding?: string, offset?: number, limit?: number, raw?: boolean}} [options] - Encoding string or options object. `raw` returns the exact on-disk bytes with no line-length/line-count truncation (see ReadOnlyFileSystem).
   * @returns {Promise<string>} File content as string
   */
  async readFile(filePath, options) {
    /** @type {Record<string, unknown>} */
    const params = { path: filePath };
    if (typeof options === 'object' && options !== null) {
      if (options.offset !== undefined || options.limit !== undefined) {
        const offset = options.offset || 1;
        const limit = options.limit || 2000;
        params.lineRange = { start: offset, end: offset + limit - 1 };
      }
      if (options.raw) params.raw = true;
    }
    const result = await readFileLoad(/** @type {any} */ (params), undefined, this._allowedPaths, this._workspaceId);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
    if (this.filesRead.size < FileSystem.MAX_FILES_READ || this.filesRead.has(filePath)) {
      this.filesRead.set(filePath, typeof result.contentHash === 'string' ? result.contentHash : null);
    }
    return result.content;
  }

  /**
   * Write content to a file (creates or overwrites).
   * @param {string} filePath - Path to file
   * @param {string} content - Content to write
   * @returns {Promise<void>}
   */
  async writeFile(filePath, content) {
    await writeFileOp({ path: filePath, content: String(content) }, undefined, undefined, this._workspaceId);
  }

  /**
   * Read directory entries.
   * @param {string} dirPath - Path to directory
   * @param {{withFileTypes?: boolean}} [options] - Options
   * @returns {Promise<string[]|Dirent[]>} Directory entry names or Dirent objects
   */
  async readdir(dirPath, options) {
    const result = await treeExpandDirectory({ path: dirPath }, this._allowedPaths, this._workspaceId);
    const items = result.items || [];
    if (options?.withFileTypes) {
      return items.map(i => new Dirent(i.name, i.isDir));
    }
    return items.map(i => i.name);
  }

  /**
   * Get file/directory metadata.
   * @param {string} filePath - Path to file or directory
   * @returns {Promise<Stats>} Stats object with size, mtime, isFile/isDirectory
   */
  async stat(filePath) {
    const result = await statOp({ path: filePath }, this._allowedPaths, this._workspaceId);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
    return new Stats(result);
  }

  /**
   * Check that a path is accessible (throws if it doesn't exist).
   * @param {string} filePath - Path to check
   * @returns {Promise<void>}
   */
  async access(filePath) {
    const result = await statOp({ path: filePath }, this._allowedPaths, this._workspaceId);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
  }

  /**
   * Create a directory.
   * @param {string} dirPath - Path to create
   * @param {{recursive?: boolean}} [options] - Options
   * @returns {Promise<void>}
   */
  async mkdir(dirPath, options) {
    await mkdirOp({ path: dirPath, recursive: options?.recursive ?? false }, this._allowedPaths, this._workspaceId);
  }
}

/**
 * Read-only filesystem for sandboxed code execution (e.g. query_code).
 * Throws on any write operation.
 */
export class ReadOnlyFileSystem extends FileSystem {
  /**
   * Read a file's exact on-disk content. Sandboxed exploration code (query_code)
   * processes files programmatically — JSON.parse, hashing, counting lines — so it
   * needs the real bytes, never the LLM-context view that truncates long lines at
   * MaxLineLength (injecting "...") or caps the file at DefaultMaxLines. Reading a
   * minified/single-line JSON file the LLM way returns the first 2000 chars + "...",
   * making JSON.parse fail "at position 2000". Force raw mode so that can't happen.
   * @param {string} filePath - Path to file
   * @param {string|{encoding?: string, offset?: number, limit?: number, raw?: boolean}} [options] - Encoding or options
   * @returns {Promise<string>} Full, untruncated file content
   * @override
   */
  async readFile(filePath, options) {
    const opts = typeof options === 'string'
      ? { encoding: options }
      : (typeof options === 'object' && options !== null ? options : {});
    return super.readFile(filePath, { ...opts, raw: true });
  }

  /** @returns {Promise<never>} Always throws */
  async writeFile() {
    throw new FileSystemError('EROFS', 'read-only filesystem');
  }

  /** @returns {Promise<never>} Always throws */
  async mkdir() {
    throw new FileSystemError('EROFS', 'read-only filesystem');
  }
}

export { Dirent, Stats, FileSystemError };
