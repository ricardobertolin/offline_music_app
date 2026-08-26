/** Whole-library backup and restore.
 *
 *  Everything this app is worth lives in IndexedDB, which the browser is allowed
 *  to evict, and which a wiped profile or a new machine takes with it. The old
 *  "export" wrote a JSON report with no way back in. This writes a real archive:
 *  a plain ZIP holding the audio, the covers and a manifest of every measurement,
 *  and reads it back.
 *
 *  The expensive part of this library is not the files, it is the analysis and
 *  the corrections — the loudness histograms, the quality scores, the covers you
 *  fixed by hand, the album orders you dragged into place. All of that is in the
 *  manifest, so even a metadata-only backup (audio left out) is worth taking:
 *  re-import the folder afterwards and everything reattaches by content hash.
 *
 *  The archive is an ordinary ZIP. Nothing stops you opening it in anything. */

import * as db from './db.js';
import { APP_VERSION } from './util.js';
import { zipStream, saveStream } from './zipwrite.js';
import { listEntries, extract } from './zip.js';

export const ARCHIVE_VERSION = 1;
const MANIFEST = 'manifest.json';

/* ------------------------- typed arrays in JSON --------------------------- */

/* The loudness histogram (Int32Array, 900 bins) and the scrubber envelope
   (Uint8Array) are what make album gain and the waveform work, and JSON turns a
   typed array into {"0":…,"1":…} — which round-trips as an object, not an
   array, and quietly breaks both. Pack them as base64 instead. */

const B64_CHUNK = 0x8000;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const packArray = (arr, type) => {
  if (!arr) return null;
  const view = arr instanceof Int32Array || arr instanceof Uint8Array ? arr
    : type === 'i32' ? Int32Array.from(arr) : Uint8Array.from(arr);
  return { t: type, d: toB64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
};

function unpackArray(v, type) {
  if (!v) return null;
  // Tolerate a hand-edited manifest that put a plain array back.
  if (Array.isArray(v)) return type === 'i32' ? Int32Array.from(v) : Uint8Array.from(v);
  if (typeof v !== 'object' || typeof v.d !== 'string') return null;
  const bytes = fromB64(v.d);
  return type === 'i32'
    ? new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
    : bytes;
}

const packLoudness = (l) => (l ? { ...l, hist: packArray(l.hist, 'i32'), envelope: packArray(l.envelope, 'u8') } : null);
const unpackLoudness = (l) => (l ? { ...l, hist: unpackArray(l.hist, 'i32'), envelope: unpackArray(l.envelope, 'u8') } : null);

/* ------------------------------ entry naming ------------------------------ */

const EXT_BY_MIME = {
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  'audio/x-flac': '.flac', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/webm': '.weba',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif',
};

/** Keep the real extension where there is one — a backup you can browse beats a
 *  backup of `a1b2c3.bin`. Falls back to the mime, then to nothing useful. */
function extFor(name, mime) {
  const fromName = String(name || '').match(/\.[A-Za-z0-9]{1,5}$/);
  if (fromName) return fromName[0].toLowerCase();
  return EXT_BY_MIME[String(mime || '').toLowerCase()] || '.bin';
}

/** ZIP paths are '/'-separated and must not escape the archive. */
const safeName = (s) => String(s).replace(/[\\/]+/g, '_').replace(/^\.+/, '_');

/* --------------------------------- export --------------------------------- */

/**
 * Build the archive's manifest and the list of files to write.
 * Blobs are *not* read here — each is fetched only as the writer reaches it.
 */
async function plan({ includeAudio = true, includeOriginals = true, settings }) {
  const tracks = await db.getAll('tracks');
  const albums = await db.getAll('albums');
  const art = await db.getAll('art');
  const folders = await db.getAll('folders');

  const files = [];   // { name, load: () => Promise<Blob|null> }
  const manifestTracks = [];

  for (const t of tracks) {
    const linked = t.source === 'folder';
    const rec = { ...t, loudness: packLoudness(t.loudness), audio: null, original: null };
    // A linked track's audio belongs to the folder, not to this app — the
    // manifest records where it was so a restore can re-link, and the bytes
    // stay out of the archive.
    if (includeAudio && !linked) {
      rec.audio = `audio/${safeName(t.id)}${extFor(t.fileName, t.mime)}`;
      files.push({ name: rec.audio, load: async () => (await db.get('blobs', t.id))?.blob || null });
      if (includeOriginals && t.hasOriginal) {
        rec.original = `originals/${safeName(t.id)}${extFor(t.transcode?.from?.container, '')}`;
        files.push({ name: rec.original, load: async () => (await db.get('blobs', `${t.id}:orig`))?.blob || null });
      }
    }
    manifestTracks.push(rec);
  }

  const manifestArt = art.map((a) => {
    const { full, thumb, ...meta } = a;
    const rec = { ...meta, full: null, thumb: null };
    // Close over the id alone, never over `a` — a closure that captured the
    // record would pin every cover's Blob for as long as the export runs.
    const id = a.id;
    if (full) {
      rec.full = `art/${safeName(id)}-full${extFor('', a.mime || full.type)}`;
      files.push({ name: rec.full, load: async () => (await db.get('art', id))?.full || null });
    }
    if (thumb) {
      rec.thumb = `art/${safeName(id)}-thumb${extFor('', a.mime || thumb.type)}`;
      files.push({ name: rec.thumb, load: async () => (await db.get('art', id))?.thumb || null });
    }
    return rec;
  });

  // Settings are values plus one Blob; the picture goes in as a file.
  const { backdropImage, ...rest } = settings || {};
  const manifestSettings = { ...rest, backdropImage: null };
  if (backdropImage instanceof Blob) {
    manifestSettings.backdropImage = `backdrop${extFor('', backdropImage.type)}`;
    files.push({ name: manifestSettings.backdropImage, load: async () => backdropImage });
  }

  const manifest = {
    app: 'offpress',
    archiveVersion: ARCHIVE_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    includesAudio: !!includeAudio,
    counts: {
      tracks: manifestTracks.length,
      linked: manifestTracks.filter((t) => t.source === 'folder').length,
      albums: albums.length,
      art: manifestArt.length,
      files: files.length,
    },
    settings: manifestSettings,
    // The link itself cannot travel (a directory handle is bound to the browser
    // that made it), so record what it pointed at and let the user re-link.
    folders: folders.map((f) => ({ id: f.id, name: f.name, addedAt: f.addedAt, trackCount: f.trackCount })),
    albums,
    art: manifestArt,
    tracks: manifestTracks,
  };

  return { manifest, files };
}

/** How big the archive will be, so the UI can say so before it starts. */
export async function estimate({ includeAudio = true, includeOriginals = true } = {}) {
  const tracks = await db.getAll('tracks');
  const art = await db.getAll('art');
  let bytes = 0;
  let audioFiles = 0;
  for (const t of tracks) {
    if (!includeAudio || t.source === 'folder') continue;
    bytes += t.size || 0;
    audioFiles++;
    if (includeOriginals && t.hasOriginal) audioFiles++;
  }
  for (const a of art) bytes += a.bytes || 0;
  return {
    bytes,
    tracks: tracks.length,
    linked: tracks.filter((t) => t.source === 'folder').length,
    audioFiles,
    art: art.length,
  };
}

/**
 * The archive as a stream, without deciding where it goes. Blobs are pulled one
 * at a time as the consumer reads, so the whole library never has to be in
 * memory at once.
 *
 * @param {object} o
 * @param {boolean} [o.includeAudio] false writes measurements and covers only —
 *        small, fast, and still worth having: a later import reattaches by hash
 * @returns {Promise<{stream:ReadableStream, name:string, entries:number}>}
 */
export async function exportStream({
  includeAudio = true, includeOriginals = true, settings, onProgress, signal,
} = {}) {
  const { manifest, files } = await plan({ includeAudio, includeOriginals, settings });
  const total = files.length + 1;

  async function* entries() {
    yield { name: MANIFEST, blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) };
    for (const f of files) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const blob = await f.load();
      // A record whose blob went missing is not worth failing a backup over.
      if (blob) yield { name: f.name, blob };
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    name: `offpress-${includeAudio ? 'library' : 'metadata'}-${stamp}.zip`,
    entries: total,
    stream: zipStream(entries(), {
      signal,
      onProgress: (done, bytes, entry) => onProgress?.(done / total, `${done} / ${total} — ${entry}`),
    }),
  };
}

/**
 * Write the whole library to a file the user picks.
 * @returns {Promise<{entries:number, via:'file'|'download', name:string}>}
 */
export async function exportLibrary(opts = {}) {
  const { stream, name, entries } = await exportStream(opts);
  const via = await saveStream(stream, name, {
    types: [{ description: 'Offpress backup', accept: { 'application/zip': ['.zip'] } }],
  });
  return { entries, via, name };
}

/* --------------------------------- restore -------------------------------- */

/** Read just the manifest, so the UI can describe an archive before committing. */
export async function inspect(file) {
  const entries = await listEntries(file);
  const found = entries.find((e) => e.name === MANIFEST || e.name.endsWith(`/${MANIFEST}`));
  if (!found) throw new Error('That file is not an Offpress backup (no manifest.json)');
  const manifest = JSON.parse(await (await extract(file, found)).text());
  if (manifest.app !== 'offpress') throw new Error('That archive was not written by this app');
  if ((manifest.archiveVersion || 0) > ARCHIVE_VERSION) {
    throw new Error(`That backup was written by a newer version (archive v${manifest.archiveVersion})`);
  }
  // Entries may sit under a folder if the archive was repacked by hand.
  const prefix = found.name.slice(0, found.name.length - MANIFEST.length);
  return { manifest, entries, prefix };
}

/**
 * Restore an archive.
 *
 * @param {File} file
 * @param {object} o
 * @param {'merge'|'replace'} [o.mode] merge keeps what is here and skips any
 *        track whose content hash is already in the library; replace clears the
 *        library first (settings are only touched if restoreSettings is set)
 * @param {boolean} [o.restoreSettings]
 * @returns {Promise<{added:number, skipped:number, art:number, albums:number,
 *                    relink:number, missingAudio:number, failed:string[]}>}
 */
export async function restoreLibrary(file, {
  mode = 'merge', restoreSettings = false, onProgress, signal,
} = {}) {
  const { manifest, entries, prefix } = await inspect(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const grab = async (name) => {
    const entry = name ? byName.get(prefix + name) || byName.get(name) : null;
    return entry ? extract(file, entry) : null;
  };

  if (mode === 'replace') await db.wipe();

  const known = new Set((await db.getAll('tracks')).map((t) => t.hash));
  const out = { added: 0, skipped: 0, art: 0, albums: 0, relink: 0, missingAudio: 0, failed: [] };
  const tracks = manifest.tracks || [];
  const art = manifest.art || [];
  const total = tracks.length + art.length + 1;
  let done = 0;
  // Note the increment sits outside the optional call: `onProgress?.(++done)`
  // would skip evaluating its own argument whenever no callback was passed.
  const step = (label) => { done++; onProgress?.(done / total, label); };

  /* Covers first: a restored track points at an art id that has to exist. */
  for (const a of art) {
    if (signal?.aborted) break;
    try {
      const { full: fullName, thumb: thumbName, ...meta } = a;
      const full = await grab(fullName);
      const thumb = await grab(thumbName);
      if (full || thumb) await db.put('art', { ...meta, full, thumb: thumb || full });
      out.art++;
    } catch (err) {
      out.failed.push(`cover ${a.id}: ${err.message}`);
    }
    step('Covers');
  }

  for (const rec of tracks) {
    if (signal?.aborted) break;
    const { audio: audioName, original: origName, ...track } = rec;
    try {
      if (mode === 'merge' && known.has(track.hash)) { out.skipped++; step(track.title); continue; }
      track.loudness = unpackLoudness(track.loudness);

      if (track.source === 'folder') {
        // The handle could not travel. Keep the row and its measurements, but
        // mark it so the library does not claim to hold audio it cannot reach.
        track.folderId = null;
        track.needsRelink = true;
        out.relink++;
      } else {
        const blob = await grab(audioName);
        if (blob) {
          await db.put('blobs', { id: track.id, blob });
        } else {
          // Metadata-only backup, or the audio was left out. The row is still
          // worth restoring: re-importing the file reattaches it by hash.
          track.needsAudio = true;
          out.missingAudio++;
        }
        if (origName) {
          const orig = await grab(origName);
          if (orig) await db.put('blobs', { id: `${track.id}:orig`, blob: orig });
          else track.hasOriginal = false;
        }
      }

      await db.put('tracks', track);
      known.add(track.hash);
      out.added++;
    } catch (err) {
      out.failed.push(`${track.title || track.id}: ${err.message}`);
    }
    step(track.title || 'Track');
  }

  /* Album records carry the one thing that cannot be recomputed: the order the
     user dragged them into. Put them back before refreshAlbum reads them. */
  for (const album of manifest.albums || []) {
    try { await db.put('albums', album); out.albums++; } catch { /* recomputed below */ }
  }

  if (restoreSettings && manifest.settings) {
    const { backdropImage, ...values } = manifest.settings;
    for (const [k, v] of Object.entries(values)) {
      if (k in db.DEFAULTS) await db.setSetting(k, v);
    }
    if (typeof backdropImage === 'string') {
      const pic = await grab(backdropImage);
      if (pic) await db.setSetting('backdropImage', pic);
    }
  }
  step('Finishing');
  return out;
}
