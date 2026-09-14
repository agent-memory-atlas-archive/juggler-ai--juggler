//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/ops` — the privileged host-operations layer.
 *
 * This is the keystone of third-party parity: file, shell, web, grep and tree
 * operations that previously only built-in plugins could reach. These ops run
 * with the user's full authority — there is no per-extension sandbox. The
 * manifest `permissions` list is a *declaration* of the host access an
 * extension's code uses, surfaced to the user in the catalog and the
 * install/trust prompt; it is disclosure, not a gate. The real gate is the
 * user-approval layer (tool approval dialogs, allowed-paths), which applies to
 * every op regardless of what an extension declared in its manifest.
 *
 * The public names below are a clean, guessable vocabulary (`readFile`, `glob`,
 * `grep`, `shell`, …) — deliberately decoupled from the internal `ops-api`
 * implementation names, which carry a subsystem prefix (`readFileLoad`,
 * `treeGlob`, `grepSearch`, …). Import what you need by name; there is no bare
 * `fetch`/`search` (those would shadow web globals). Use `httpRequest` for
 * generic server-side HTTP, or `webFetch`/`webSearch` for the convenience
 * specialisations. All three refuse private, loopback and link-local
 * destinations; `httpRequest`'s `allowPrivateHosts` is the only way to reach a
 * server on the machine or the network Juggler is running inside.
 */
import {
  readFileLoad,
  writeFileOp,
  readFileEdit,
  readFileEditLines,
  readFileGetHash,
  statOp,
  mkdirOp,
  treeGetTree,
  treeExpandDirectory,
  treeGlob,
  treeCopy,
  treeCompare,
  grepSearch,
  grepFindSymbol,
  shellExecute,
  shellStartBackground
} from '../js/services/ops-api.js';
import { shellExecuteStreaming } from '../js/services/shell-streaming.js';
import { FileSystem, ReadOnlyFileSystem } from '../js/services/fs.js';

export {
  OpsError,
  MAX_EXEC_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  // Filesystem
  readFileLoad as readFile,
  uploadAssetBase64,
  writeFileOp as writeFile,
  readFileEdit as editFile,
  readFileEditLines as editFileLines,
  readFileGetHash as fileHash,
  statOp as stat,
  mkdirOp as mkdir,
  // Directory tree
  treeGetTree as getTree,
  treeExpandDirectory as expandDirectory,
  treeGlob as glob,
  treeCopy as copyTree,
  treeCompare as compareTrees,
  // Search
  grepSearch as grep,
  grepFindSymbol as findSymbol,
  // Shell
  shellExecute as shell,
  shellStartBackground as shellBackground,
  shellGetOutput as shellOutput,
  shellGetOutputDelta as shellOutputDelta,
  shellKill,
  // Liveness for tasks you already hold ids for. Not an inventory: it answers
  // only about the ids you pass, and carries no output, so a surface watching a
  // long-lived task polls this rather than dragging the whole log back with
  // `shellOutput` every few seconds.
  shellTaskStatus as shellStatus,
  // Web
  httpRequest,
  webFetch,
  webSearch,
  // Extension configuration
  extensionConfigGet,
  extensionConfigSet,
  extensionConfigResolve,
  // LLM (out-of-band text generation)
  generateText,
  // OS integration
  osOpenPath as openPath,
  osRevealPath as revealPath,
  // MCP (Model Context Protocol) client
  mcpListServers,
  mcpListTools,
  mcpSnapshot,
  mcpCallTool,
  mcpServerControl,
  mcpGetLog,
  mcpGetConfig,
  mcpSetConfig,
} from '../js/services/ops-api.js';

// Live shell execution is the one op that streams rather than returning once,
// so it rides the WebSocket instead of /api/ops/call and lives beside it.
export {
  shellExecuteStreaming as shellStreaming,
  shellCancelStreaming as cancelShellStreaming,
} from '../js/services/shell-streaming.js';

export { FileSystem, ReadOnlyFileSystem } from '../js/services/fs.js';

/**
 * @typedef {object} OpsScope
 * @property {string[]} [allowedPaths] - The caller's explicit allowed-path grants.
 * @property {string} [workspaceId] - The workspace the caller works in ('' = project).
 */

/**
 * The rooted operations, minus the two arguments the facade supplies. Each is
 * the identically-named export above with `allowedPaths` and `workspaceId`
 * already in it.
 * @typedef {object} BoundOps
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof readFileLoad>} readFile - Read a file.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof writeFileOp>} writeFile - Create or overwrite a file.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof readFileEdit>} editFile - Search-and-replace within a file.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof readFileEditLines>} editFileLines - Replace a line range.
 * @property {(params: any) => ReturnType<typeof readFileGetHash>} fileHash - Hash a file, for staleness checks.
 * @property {(params: any) => ReturnType<typeof statOp>} stat - File/directory metadata.
 * @property {(params: any) => ReturnType<typeof mkdirOp>} mkdir - Create a directory.
 * @property {(params: any) => ReturnType<typeof treeGetTree>} getTree - Directory tree.
 * @property {(params: any) => ReturnType<typeof treeExpandDirectory>} expandDirectory - One directory's entries.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof treeGlob>} glob - Files matching a pattern.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof treeCopy>} copyTree - Copy a tree, respecting the ignore rules.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof treeCompare>} compareTrees - Say how two trees differ.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof grepSearch>} grep - Search file contents.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof grepFindSymbol>} findSymbol - Find a symbol's definition.
 * @property {(params: any, signal?: AbortSignal) => ReturnType<typeof shellExecute>} shell - Run a command and wait for it; aborting the signal kills it.
 * @property {(params: any) => ReturnType<typeof shellStartBackground>} shellBackground - Start a command in the background (stopped by id, not by signal).
 * @property {(params: any, onOutput: (chunk: any) => void, signal?: AbortSignal) => ReturnType<typeof shellExecuteStreaming>} shellStreaming - Run a command, streaming its output.
 * @property {() => FileSystem} fileSystem - An fs.promises-alike rooted here.
 * @property {() => ReadOnlyFileSystem} readOnlyFileSystem - The same, refusing writes.
 */

/**
 * The ops above, with the caller's scope already in them.
 *
 * Every operation below is rooted somewhere, and the two facts that say where —
 * the workspace it runs in and the roots the user has granted outside it — are
 * properties of the CALLER, not of the call. Passed per call site they are
 * optional, and omitting them is silent: the op runs, in the project, and looks
 * exactly like it worked. There is no answer to "which tree did you mean" that
 * is safe to guess, so the ops that need one are reached through a facade that
 * cannot be built without it — and a tool implementation may not import them any
 * other way, which ESLint enforces (tooling/eslint.config.js) the same way it
 * refuses a bare `fetch` to /api/ops/call.
 *
 * The scope is resolved on every call rather than captured once: a tool item
 * outlives both a permission grant being added and — through a rebind — the
 * binding itself.
 * @param {() => OpsScope} resolveScope - Called per op for the caller's current scope.
 * @returns {BoundOps} The scoped operations.
 */
export function createBoundOps(resolveScope) {
  /** @returns {string[]|undefined} The grant, or undefined to send none. */
  const paths = () => resolveScope().allowedPaths;
  /** @returns {string|undefined} The workspace id, or undefined for the project. */
  const where = () => resolveScope().workspaceId || undefined;

  return {
    readFile: (params, signal) => readFileLoad(params, signal, paths(), where()),
    writeFile: (params, signal) => writeFileOp(params, signal, paths(), where()),
    editFile: (params, signal) => readFileEdit(params, signal, paths(), where()),
    editFileLines: (params, signal) => readFileEditLines(params, signal, paths(), where()),
    fileHash: (params) => readFileGetHash(params, paths(), where()),
    stat: (params) => statOp(params, paths(), where()),
    mkdir: (params) => mkdirOp(params, paths(), where()),
    getTree: (params) => treeGetTree(params, paths(), where()),
    expandDirectory: (params) => treeExpandDirectory(params, paths(), where()),
    glob: (params, signal) => treeGlob(params, signal, paths(), where()),
    copyTree: (params, signal) => treeCopy(params, signal, paths(), where()),
    compareTrees: (params, signal) => treeCompare(params, signal, paths(), where()),
    grep: (params, signal) => grepSearch(params, signal, paths(), where()),
    findSymbol: (params, signal) => grepFindSymbol(params, signal, where()),
    shell: (params, signal) => shellExecute(params, where(), signal),
    shellBackground: (params) => shellStartBackground(params, where()),
    shellStreaming: (params, onOutput, signal) => shellExecuteStreaming(params, onOutput, signal, where()),
    fileSystem: () => new FileSystem(paths(), where()),
    readOnlyFileSystem: () => new ReadOnlyFileSystem(paths(), where())
  };
}
