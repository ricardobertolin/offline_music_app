/** Where a track's audio actually lives.
 *
 *  Two kinds of track:
 *
 *  - **stored** (`source: 'blob'`, and anything written before this existed) —
 *    the file was copied into IndexedDB at import. Self-contained, works in every
 *    browser, and costs a second copy of your music collection on disk.
 *  - **linked** (`source: 'folder'`) — the library keeps a directory handle and
 *    reads the file from the folder you already manage. Metadata, artwork and
 *    every measurement still live in IndexedDB, which is a few MB; the audio is
 *    never duplicated, and files you add to the folder outside the app turn up
 *    on the next scan.
 *
 *  Linking needs the File System Access API, so it is desktop Chromium only and
 *  is offered as an extra import mode rather than as a replacement. Permission
 *  does not always survive a reload — the browser can hand back "prompt", which
 *  only a user gesture can clear — so callers have to be ready for
 *  NeedsPermissionError and offer a way to reconnect. */

import * as db from './db.js';

/** Linking is available at all? (Firefox and Safari: no.) */
export const canLink = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/** The folder is still there, but the browser wants the user to say so again. */
export class NeedsPermissionError extends Error {
  constructor(folder) {
    super(`Reconnect the folder "${folder?.name || 'linked folder'}" to play or analyze this track`);
    this.name = 'NeedsPermissionError';
    this.folderId = folder?.id || null;
  }
}

/** The record is linked to a file that is no longer in the folder. */
export class MissingFileError extends Error {
  constructor(path) {
    super(`"${path}" is no longer in the linked folder`);
    this.name = 'MissingFileError';
  }
}

/* -------------------------------- folders --------------------------------- */

export const allFolders = () => db.getAll('folders');
export const getFolder = (id) => db.get('folders', id);

/** Ask for a folder and remember it. Must be called from a user gesture. */
export async function pickFolder() {
  if (!canLink()) throw new Error('This browser cannot link folders');
  const handle = await window.showDirectoryPicker({ id: 'offpress-library', mode: 'read' });
  // The same folder picked twice is the same folder, not a second one.
  for (const f of await allFolders()) {
    if (await sameEntry(f.handle, handle)) {
      f.handle = handle;   // refresh: this one carries a live permission
      await db.put('folders', f);
      return f;
    }
  }
  const folder = {
    id: `fold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: handle.name || 'Folder',
    handle,
    addedAt: Date.now(),
    lastScan: 0,
    trackCount: 0,
  };
  await db.put('folders', folder);
  return folder;
}

const sameEntry = async (a, b) => {
  try { return !!(a && b && await a.isSameEntry(b)); } catch { return false; }
};

/**
 * @param {object} folder
 * @param {boolean} [request] prompt if the answer would be "prompt" — only
 *        legal inside a user gesture, so it is off by default
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function permissionOf(folder, request = false) {
  const handle = folder?.handle;
  if (!handle) return 'denied';
  const opts = { mode: 'read' };
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission(opts);
      if (state === 'granted' || !request) return state;
    }
    if (request && handle.requestPermission) return await handle.requestPermission(opts);
    // No permissions API on the handle: the only way to know is to use it.
    await handle.values?.().next?.();
    return 'granted';
  } catch {
    return 'denied';
  }
}

/** Re-grant a folder from a user gesture. */
export async function reconnect(folderOrId) {
  const folder = typeof folderOrId === 'string' ? await getFolder(folderOrId) : folderOrId;
  if (!folder) return 'denied';
  const state = await permissionOf(folder, true);
  if (state === 'granted') { folder.lastScan = folder.lastScan || 0; await db.put('folders', folder); }
  return state;
}

/** Which folders would stop playback right now if you asked them for a file. */
export async function foldersNeedingPermission() {
  const out = [];
  for (const f of await allFolders()) {
    if (await permissionOf(f) !== 'granted') out.push(f);
  }
  return out;
}

/** Forget a link. The files themselves are never touched — only the handle. */
export async function forgetFolder(id) {
  await db.del('folders', id);
  folderCache.delete(id);
}

/* --------------------------------- walking -------------------------------- */

/** Every file under `dir`, depth-first, carrying its path relative to the root. */
async function* walk(dir, prefix = '', depth = 0) {
  // Skip the places that only ever hold noise, rather than reading them and
  // filtering later — a resource fork directory can be thousands of entries.
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.') || name === '__MACOSX') continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') yield { path, handle };
    else if (depth < 8) yield* walk(handle, path, depth + 1);
  }
}

/**
 * List the audio in a linked folder as Files, each tagged with `relPath` so the
 * existing import path orders and groups them exactly as a dragged folder.
 *
 * @param {object} folder
 * @param {object} o
 * @param {(name:string)=>boolean} o.keep name filter (library.isAudioName)
 * @returns {Promise<Array<File & {relPath:string}>>}
 */
export async function scanFolder(folder, { keep = () => true, onProgress, signal } = {}) {
  if (await permissionOf(folder) !== 'granted') throw new NeedsPermissionError(folder);
  const out = [];
  for await (const entry of walk(folder.handle)) {
    if (signal?.aborted) break;
    if (!keep(entry.path)) continue;
    try {
      const file = await entry.handle.getFile();
      // The folder's own name is the top of the path, so an album folder dropped
      // straight into the link still resolves to that album.
      Object.defineProperty(file, 'relPath', { value: `${folder.name}/${entry.path}`, enumerable: true });
      Object.defineProperty(file, 'linkPath', { value: entry.path, enumerable: true });
      out.push(file);
      onProgress?.(out.length, entry.path);
    } catch { /* vanished or unreadable between listing and opening */ }
  }
  return out;
}

/* ------------------------------- resolution ------------------------------- */

/** Folder records are read on every track load, so keep them in hand. */
const folderCache = new Map();

async function folderFor(track) {
  const id = track.folderId;
  if (!id) return null;
  if (!folderCache.has(id)) folderCache.set(id, await getFolder(id));
  return folderCache.get(id) || null;
}

/** Drop the cache after anything that rewrites folder records. */
export const forgetCache = () => folderCache.clear();

export const isLinked = (track) => track?.source === 'folder';

/**
 * The audio for a track, wherever it lives.
 * @throws {NeedsPermissionError|MissingFileError}
 * @returns {Promise<Blob|null>} null only when a stored track has lost its blob
 */
export async function blobFor(track) {
  if (!track) return null;
  if (!isLinked(track)) return (await db.get('blobs', track.id))?.blob || null;

  const folder = await folderFor(track);
  if (!folder) throw new MissingFileError(track.relPath || track.fileName);
  if (await permissionOf(folder) !== 'granted') throw new NeedsPermissionError(folder);

  const parts = String(track.relPath || '').split('/').filter(Boolean);
  if (!parts.length) throw new MissingFileError(track.fileName);
  try {
    let dir = folder.handle;
    for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    return await handle.getFile();
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw new NeedsPermissionError(folder);
    throw new MissingFileError(track.relPath);
  }
}

/** Like blobFor, but a missing file is an answer rather than an exception —
 *  for bulk passes that should skip what they cannot read and carry on. */
export async function tryBlobFor(track) {
  try { return await blobFor(track); } catch { return null; }
}
