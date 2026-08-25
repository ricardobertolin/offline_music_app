/** Domain layer: importing, analysis, album aggregation, artwork and quality jobs. */

import * as db from './db.js';
import { readMetadata } from './metadata.js';
import { analyzeBlob } from './audio/decode.js';
import { transcode, matchesTarget } from './audio/transcode.js';
import { saveArtwork, forgetArtUrl } from './image.js';
import { normalizationGain, mergeHistograms, integratedFromHistogram } from './dsp/loudness.js';
import { uid, albumKeyOf, fileHash, naturalCompare, folderOf, pathOf } from './util.js';

const AUDIO_RE = /\.(mp3|m4a|m4b|mp4|aac|flac|ogg|oga|opus|wav|wave|aif|aiff|weba|webm|wma)$/i;

/** By name alone — for archive entries, where there is no File to inspect. */
export const isAudioName = (name) => AUDIO_RE.test(String(name || ''));

export const isAudioFile = (f) => (f.type && f.type.startsWith('audio/')) || isAudioName(f.name);

/* --------------------------------- import --------------------------------- */

/**
 * @param {File[]} files
 * @param {object} o { settings, onProgress(done,total,label), onTrack(track), signal }
 */
export async function importFiles(files, o = {}) {
  const { settings, onProgress, onTrack, signal } = o;
  // Import in folder order (numeric-aware), because that is the order an album
  // is meant to be played in when the tags are missing or wrong.
  const audio = files.filter(isAudioFile).sort((a, b) => naturalCompare(pathOf(a), pathOf(b)));
  const result = { added: 0, skipped: 0, failed: [], total: audio.length };
  const known = await db.getAll('tracks');
  const existing = new Set(known.map((t) => t.hash));
  let pos = known.reduce((m, t) => Math.max(m, t.pos || 0), 0);
  const albumArt = new Map(); // albumKey → artId, so a 12-track album stores one cover
  const touched = new Set();

  for (let i = 0; i < audio.length; i++) {
    if (signal?.aborted) break;
    const file = audio[i];
    onProgress?.(i, audio.length, file.name);
    try {
      const hash = await fileHash(file);
      if (existing.has(hash)) { result.skipped++; continue; }

      const meta = await readMetadata(file);
      const track = newTrack(file, meta, hash, ++pos);
      touched.add(track.albumKey);

      if (meta.picture?.bytes?.length) {
        // A track's own embedded cover always wins. saveArtwork dedupes by image
        // content, so an album that embeds one cover in every track still stores
        // it once — without ever handing a different album's art to this track.
        try {
          const art = await saveArtwork(meta.picture, settings);
          track.artId = art.id;
          albumArt.set(track.albumKey, art.id);
        } catch { /* a broken embedded cover shouldn't fail the import */ }
      } else {
        // No cover of its own: fall back to whatever this album already uses.
        track.artId = albumArt.get(track.albumKey) ?? await albumArtId(track.albumKey);
      }

      await db.put('blobs', { id: track.id, blob: file });
      await db.put('tracks', track);
      existing.add(hash);
      result.added++;
      onTrack?.(track);

      // Analysis is the whole point, so do it now — but never lose the track over it.
      try {
        await analyzeTrack(track, { onProgress: (p) => onProgress?.(i + p, audio.length, file.name) });
      } catch (err) {
        track.analyzeError = String(err.message || err);
        await db.put('tracks', track);
      }
      await refreshAlbum(track.albumKey);
    } catch (err) {
      result.failed.push({ name: file.name, error: String(err?.message || err) });
    }
  }
  onProgress?.(audio.length, audio.length, '');
  return result;
}

function newTrack(file, meta, hash, pos) {
  const base = (file.name || 'Unknown').replace(/\.[^.]+$/, '');
  const folder = folderOf(file);
  const t = {
    id: uid(),
    hash,
    pos,
    fileName: file.name || 'audio',
    path: pathOf(file),
    mime: file.type || '',
    size: file.size,
    addedAt: Date.now(),
    title: meta.title || base,
    artist: meta.artist || 'Unknown Artist',
    albumArtist: meta.albumArtist || '',
    // An untagged file still belongs somewhere: its folder is the best guess,
    // and it keeps two untagged folders from merging into one "Unknown Album".
    album: meta.album || folder || 'Unknown Album',
    trackNo: meta.trackNo || 0,
    discNo: meta.discNo || 0,
    year: meta.year || '',
    genre: meta.genre || '',
    codec: meta.codec || '',
    container: meta.container || '',
    lossless: !!meta.lossless,
    vbr: !!meta.vbr,
    sampleRate: meta.sampleRate || 0,
    channels: meta.channels || 0,
    bits: meta.bits || 0,
    declaredKbps: meta.declaredKbps || 0,
    duration: 0,
    artId: null,
    analyzed: false,
    loudness: null,
    quality: null,
    transcode: null,
    hasOriginal: false,
  };
  t.albumKey = albumKeyOf(t);
  return t;
}

async function albumArtId(key) {
  const album = await db.get('albums', key);
  if (album?.artId) return album.artId;
  const tracks = await db.byIndex('tracks', 'albumKey', key);
  return tracks.find((t) => t.artId)?.artId || null;
}

/* -------------------------------- analysis -------------------------------- */

export async function analyzeTrack(track, { onProgress } = {}) {
  const rec = await db.get('blobs', track.id);
  if (!rec?.blob) throw new Error('Audio data is missing for this track');

  const res = await analyzeBlob(rec.blob, {
    lossless: track.lossless,
    codec: track.codec,
    nativeSampleRate: track.sampleRate || 0,
  }, onProgress);

  track.duration = res.duration;
  track.channels = track.channels || res.decodedChannels;
  track.sampleRate = track.sampleRate || res.decodedRate;
  track.loudness = {
    integratedLufs: res.loudness.integratedLufs,
    lra: res.loudness.lra,
    momentaryMaxLufs: res.loudness.momentaryMaxLufs,
    shortTermMaxLufs: res.loudness.shortTermMaxLufs,
    truePeakDb: res.loudness.truePeakDb,
    samplePeakDb: res.loudness.samplePeakDb,
    hist: res.loudness.hist,
    envelope: res.loudness.envelope,   // momentary loudness over time, for the scrubber
  };
  track.quality = res.quality;
  track.analyzed = true;
  track.analyzeError = null;
  track.analyzedAt = Date.now();
  await db.put('tracks', track);
  return track;
}

/* --------------------------------- albums --------------------------------- */

/** Album loudness is the gated mean over every block of every track — recomputed
 *  from the stored histograms, not averaged from the per-track numbers. */
export async function refreshAlbum(key) {
  const tracks = await db.byIndex('tracks', 'albumKey', key);
  if (!tracks.length) { await db.del('albums', key); return null; }
  const previous = await db.get('albums', key);
  const first = sortAlbumTracks(tracks, previous)[0];
  const hists = tracks.map((t) => t.loudness?.hist).filter(Boolean);
  const merged = hists.length ? mergeHistograms(hists) : null;
  const integrated = merged ? integratedFromHistogram(merged) : null;
  const peaks = tracks.map((t) => t.loudness?.truePeakDb).filter((v) => typeof v === 'number');

  const ids = new Set(tracks.map((t) => t.id));
  const album = {
    key,
    name: first.album || 'Unknown Album',
    artist: first.albumArtist || first.artist || 'Unknown Artist',
    artId: tracks.find((t) => t.artId)?.artId || null,
    // Custom ordering survives re-analysis, renames and new imports.
    sortMode: previous?.sortMode || 'folder',
    order: (previous?.order || []).filter((id) => ids.has(id)),
    year: tracks.map((t) => t.year).find(Boolean) || '',
    trackCount: tracks.length,
    duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
    bytes: tracks.reduce((a, t) => a + (t.size || 0), 0),
    integratedLufs: integrated !== null && isFinite(integrated) ? Math.round(integrated * 10) / 10 : null,
    truePeakDb: peaks.length ? Math.max(...peaks) : null,
    analyzedTracks: hists.length,
    updatedAt: Date.now(),
  };
  if (album.sortMode === 'custom') {
    // Tracks imported after the last reorder join the end, in folder order.
    const have = new Set(album.order);
    album.order = [...album.order, ...tracks.filter((t) => !have.has(t.id)).sort(byPos).map((t) => t.id)];
  }
  await db.put('albums', album);
  return album;
}

/* ----------------------------- album ordering ----------------------------- */

export const ALBUM_SORTS = {
  folder: 'Folder order (as imported)',
  track: 'Track number from tags',
  title: 'Title',
  custom: 'Custom (drag to reorder)',
};

const byPos = (a, b) => (a.pos || 0) - (b.pos || 0) || naturalCompare(a.path || a.fileName, b.path || b.fileName);

/** Order an album's tracks the way the album says it wants to be ordered. */
export function sortAlbumTracks(tracks, album) {
  const list = tracks.slice();
  const mode = album?.sortMode || 'folder';
  if (mode === 'custom' && album?.order?.length) {
    const rank = new Map(album.order.map((id, i) => [id, i]));
    return list.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb || byPos(a, b); // tracks added since the reorder go last
    });
  }
  if (mode === 'track') {
    return list.sort((a, b) =>
      (a.discNo || 0) - (b.discNo || 0)
      || (a.trackNo || Infinity) - (b.trackNo || Infinity)
      || byPos(a, b));
  }
  if (mode === 'title') return list.sort((a, b) => naturalCompare(a.title, b.title) || byPos(a, b));
  return list.sort(byPos);
}

export async function setAlbumSort(key, mode) {
  const album = await db.get('albums', key);
  if (!album) return null;
  album.sortMode = mode;
  if (mode === 'custom' && !album.order?.length) {
    // Materialize whatever is on screen now, so dragging starts from that order.
    album.order = sortAlbumTracks(await db.byIndex('tracks', 'albumKey', key), { ...album, sortMode: 'folder' }).map((t) => t.id);
  }
  await db.put('albums', album);
  return album;
}

/** Persist a drag-and-drop reorder. */
export async function setAlbumOrder(key, ids) {
  const album = await db.get('albums', key);
  if (!album) return null;
  album.sortMode = 'custom';
  album.order = ids;
  await db.put('albums', album);
  return album;
}

/* -------------------------------- editing --------------------------------- */

/** Tag fields the user is allowed to edit. */
const EDITABLE = ['title', 'artist', 'albumArtist', 'album', 'trackNo', 'discNo', 'year', 'genre'];
const NUMERIC = new Set(['trackNo', 'discNo']);

function applyFields(track, fields) {
  for (const k of EDITABLE) {
    if (!(k in fields) || fields[k] === undefined) continue;
    const v = fields[k];
    track[k] = NUMERIC.has(k) ? (parseInt(v, 10) || 0) : String(v ?? '').trim();
  }
  // A track must always have something to show and somewhere to live.
  if (!track.title) track.title = (track.fileName || 'Unknown').replace(/\.[^.]+$/, '');
  if (!track.artist) track.artist = 'Unknown Artist';
  if (!track.album) track.album = 'Unknown Album';
  return track;
}

/**
 * Edit one track's tags. The album key is derived from album/albumArtist/artist,
 * so changing any of those moves the track between albums — both the old and the
 * new album are refreshed.
 */
export async function updateTrack(id, fields) {
  const track = await db.get('tracks', id);
  if (!track) return null;
  const oldKey = track.albumKey;
  applyFields(track, fields);
  track.albumKey = albumKeyOf(track);
  await db.put('tracks', track);
  if (oldKey !== track.albumKey) await refreshAlbum(oldKey);
  await refreshAlbum(track.albumKey);
  return track;
}

/** Apply the same fields to many tracks (e.g. fixing the artist on a selection). */
export async function updateTracks(ids, fields, { onProgress, signal } = {}) {
  const wanted = new Set(ids);
  const tracks = (await db.getAll('tracks')).filter((t) => wanted.has(t.id));
  const touched = new Set();
  let done = 0;
  for (const t of tracks) {
    if (signal?.aborted) break;
    touched.add(t.albumKey);
    applyFields(t, fields);
    t.albumKey = albumKeyOf(t);
    touched.add(t.albumKey);
    await db.put('tracks', t);
    onProgress?.(++done, tracks.length, t.title);
  }
  for (const key of touched) await refreshAlbum(key);
  return done;
}

/**
 * Rename an album and/or set its artist across every track in it.
 * @param {object} o
 * @param {string} [o.name]    new album title
 * @param {string} [o.artist]  new album artist
 * @param {boolean} [o.applyToTrackArtists] also overwrite each track's own artist —
 *        wanted for a single-artist album, not for a compilation
 * @returns {Promise<string>} the album's new key (it changes with the names)
 */
export async function renameAlbum(key, { name, artist, applyToTrackArtists = false } = {}) {
  const tracks = await db.byIndex('tracks', 'albumKey', key);
  if (!tracks.length) return key;
  const previous = await db.get('albums', key);

  for (const t of tracks) {
    if (name != null && name.trim()) t.album = name.trim();
    if (artist != null) {
      t.albumArtist = artist.trim();
      if (applyToTrackArtists && t.albumArtist) t.artist = t.albumArtist;
    }
    t.albumKey = albumKeyOf(t);
    await db.put('tracks', t);
  }
  const newKey = tracks[0].albumKey;

  if (newKey !== key) {
    // Renaming onto an existing album merges into it; keep that album's order first.
    const target = await db.get('albums', newKey);
    const order = target?.order?.length
      ? [...target.order, ...(previous?.order || []).filter((id) => !target.order.includes(id))]
      : (previous?.order || []);
    await db.put('albums', {
      ...(target || {}),
      key: newKey,
      artId: target?.artId || previous?.artId || null,
      sortMode: target?.sortMode || previous?.sortMode || 'folder',
      order,
    });
    await db.del('albums', key);
    await refreshAlbum(key); // drops the old record if it is now empty
  }
  await refreshAlbum(newKey);
  return newKey;
}

/**
 * Self-healing pass at startup: album keys are derived from names, so any track
 * written by an older build (or edited elsewhere) gets its key and import
 * position rebuilt here.
 */
export async function migrateLibrary() {
  const tracks = await db.getAll('tracks');
  if (!tracks.length) return 0;
  let changed = 0;
  let nextPos = tracks.reduce((m, t) => Math.max(m, t.pos || 0), 0);
  const needPos = tracks.filter((t) => !t.pos).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  for (const t of needPos) { t.pos = ++nextPos; }

  for (const t of tracks) {
    const key = albumKeyOf(t);
    const stale = t.albumKey !== key;
    if (stale) t.albumKey = key;
    if (stale || needPos.includes(t)) { await db.put('tracks', t); changed++; }
  }
  if (changed) await refreshAllAlbums();
  return changed;
}

export async function refreshAllAlbums() {
  const tracks = await db.getAll('tracks');
  const keys = [...new Set(tracks.map((t) => t.albumKey))];
  const out = [];
  for (const k of keys) out.push(await refreshAlbum(k));
  const stale = (await db.getAll('albums')).filter((a) => !keys.includes(a.key));
  for (const a of stale) await db.del('albums', a.key);
  return out.filter(Boolean);
}

/* ------------------------------ gain resolution --------------------------- */

/**
 * Normalization gain for a track under the current settings.
 * @returns {{gainDb:number, wanted:number, limitedBy:string|null, basis:string}}
 */
export function gainFor(track, settings, album = null) {
  if (settings.mode === 'off' || !track?.loudness) {
    return { gainDb: 0, wanted: 0, limitedBy: null, basis: 'off' };
  }
  if (settings.mode === 'album' && album?.integratedLufs != null) {
    const g = normalizationGain(
      { integratedLufs: album.integratedLufs, truePeakDb: track.loudness.truePeakDb },
      settings,
    );
    return { ...g, basis: 'album' };
  }
  return { ...normalizationGain(track.loudness, settings), basis: 'track' };
}

/* --------------------------------- artwork -------------------------------- */

export async function setTrackArt(trackId, source, settings) {
  const track = await db.get('tracks', trackId);
  if (!track) return null;
  const art = await saveArtwork(source, settings);
  const old = track.artId;
  track.artId = art.id;
  await db.put('tracks', track);
  await refreshAlbum(track.albumKey);
  await sweepArtwork();
  return art;
}

export async function setAlbumArt(albumKey, source, settings, { onlyMissing = false } = {}) {
  const tracks = await db.byIndex('tracks', 'albumKey', albumKey);
  if (!tracks.length) return null;
  const art = await saveArtwork(source, settings);
  for (const t of tracks) {
    if (onlyMissing && t.artId) continue;
    t.artId = art.id;
    await db.put('tracks', t);
  }
  await refreshAlbum(albumKey);
  await sweepArtwork();
  return art;
}

/** Drop every art record nothing references any more (one pass, not one per track). */
export async function sweepArtwork() {
  const used = new Set((await db.getAll('tracks')).map((t) => t.artId).filter(Boolean));
  let dropped = 0;
  for (const art of await db.getAll('art')) {
    if (used.has(art.id)) continue;
    forgetArtUrl(art.id);
    await db.del('art', art.id);
    dropped++;
  }
  return dropped;
}

/**
 * Re-extract each track's embedded cover from its stored audio and reassign it.
 * Repairs libraries imported before artwork was deduped by image content, where
 * a track could inherit a different album's cover.
 */
export async function repairArtwork(settings, onProgress, signal) {
  const tracks = await db.getAll('tracks');
  const albumArt = new Map();
  let fixed = 0, cleared = 0;

  for (let i = 0; i < tracks.length; i++) {
    if (signal?.aborted) break;
    const t = tracks[i];
    onProgress?.(i, tracks.length, t.title);
    const rec = await db.get('blobs', t.id);
    if (!rec?.blob) continue;
    try {
      const meta = await readMetadata(rec.blob);
      if (meta.picture?.bytes?.length) {
        const art = await saveArtwork(meta.picture, settings);
        if (t.artId !== art.id) { t.artId = art.id; await db.put('tracks', t); fixed++; }
        albumArt.set(t.albumKey, art.id);
      } else if (t.artId) {
        // Art it never had embedded: keep it only if the album really uses it.
        const owner = albumArt.get(t.albumKey);
        if (owner && owner !== t.artId) { t.artId = owner; await db.put('tracks', t); fixed++; }
      }
    } catch { /* leave this track as it is */ }
  }

  cleared = await sweepArtwork();
  await refreshAllAlbums();
  onProgress?.(tracks.length, tracks.length, '');
  return { checked: tracks.length, fixed, cleared };
}

/** Re-run artwork normalization for every stored cover (after changing sizes). */
export async function renormalizeArtwork(settings, onProgress) {
  const arts = await db.getAll('art');
  const tracks = await db.getAll('tracks');
  let done = 0;
  for (const art of arts) {
    onProgress?.(done, arts.length, '');
    try {
      // Re-normalize from the stored full-size cover at the new settings.
      const fresh = await saveArtwork(art.full, settings);
      if (fresh.id !== art.id) {
        for (const t of tracks) {
          if (t.artId === art.id) { t.artId = fresh.id; await db.put('tracks', t); }
        }
        forgetArtUrl(art.id);
        await db.del('art', art.id);
      }
    } catch { /* keep the old one */ }
    done++;
  }
  await refreshAllAlbums();
  onProgress?.(arts.length, arts.length, '');
  return arts.length;
}

/* ---------------------------- quality normalization ----------------------- */

export function needsQualityNormalization(track, settings) {
  if (!track.analyzed) return false;
  if (matchesTarget(track, settings)) return false;
  if (!settings.reencodeBetter) {
    // Don't re-encode something already better than the target: that only loses quality.
    const targetKbps = settings.codec === 'opus' ? settings.bitrate : 1411;
    const cur = track.quality?.bitrateKbps || 0;
    if (track.lossless && settings.codec === 'wav') return false;
    if (!track.lossless && cur && cur <= targetKbps * 1.05 && !track.lossless) return false;
  }
  return true;
}

/**
 * Re-encode one track to the configured target profile.
 * The original can be kept (Settings) so the operation stays reversible.
 */
export async function normalizeQuality(track, settings, { onProgress, signal } = {}) {
  const rec = await db.get('blobs', track.id);
  if (!rec?.blob) throw new Error('Audio data is missing for this track');

  const before = { codec: track.codec, container: track.container, size: track.size, sampleRate: track.sampleRate, channels: track.channels };
  const gainDb = settings.bakeGain ? gainFor(track, settings, await db.get('albums', track.albumKey)).gainDb : 0;

  const res = await transcode(rec.blob, {
    codec: settings.codec,
    bitrate: settings.bitrate,
    rate: settings.rate,
    channels: settings.channels,
    sourceRate: track.sampleRate,
    gainDb,
    signal,
    onProgress: (p) => onProgress?.(p * 0.7),
  });

  if (settings.keepOriginal && !track.hasOriginal) {
    await db.put('blobs', { id: `${track.id}:orig`, blob: rec.blob });
    track.hasOriginal = true;
  }
  await db.put('blobs', { id: track.id, blob: res.blob });

  track.size = res.blob.size;
  track.mime = res.format.mime;
  track.codec = res.format.codec;
  track.container = res.format.container;
  track.lossless = res.format.lossless;
  track.sampleRate = res.sampleRate;
  track.channels = res.channels;
  track.bits = res.format.container === 'WAV' ? 16 : 0;
  track.declaredKbps = res.format.bitrate;
  track.vbr = res.format.codec === 'Opus';
  track.transcode = { at: Date.now(), from: before, profile: `${res.format.codec} ${res.format.bitrate} kbps ${res.sampleRate / 1000} kHz ${res.channels}ch`, bakedGainDb: gainDb };
  await db.put('tracks', track);

  // The file changed, so its measurements did too.
  await analyzeTrack(track, { onProgress: (p) => onProgress?.(0.7 + p * 0.3) });
  await refreshAlbum(track.albumKey);
  return track;
}

export async function restoreOriginal(track) {
  const orig = await db.get('blobs', `${track.id}:orig`);
  if (!orig?.blob) throw new Error('No original kept for this track');
  await db.put('blobs', { id: track.id, blob: orig.blob });
  await db.del('blobs', `${track.id}:orig`);
  const meta = await readMetadata(orig.blob);
  Object.assign(track, {
    size: orig.blob.size,
    codec: meta.codec || track.transcode?.from?.codec || track.codec,
    container: meta.container || track.transcode?.from?.container || track.container,
    lossless: !!meta.lossless,
    sampleRate: meta.sampleRate || track.transcode?.from?.sampleRate || track.sampleRate,
    channels: meta.channels || track.transcode?.from?.channels || track.channels,
    hasOriginal: false,
    transcode: null,
  });
  await db.put('tracks', track);
  await analyzeTrack(track);
  await refreshAlbum(track.albumKey);
  return track;
}

/* --------------------------------- deletion ------------------------------- */

export const deleteTrack = (id) => deleteTracks([id]);

/**
 * Remove tracks, their audio (and any kept original), then clean up artwork and
 * albums in a single pass — deleting 200 tracks shouldn't be 200 full scans.
 * @returns {Promise<{deleted:number, bytes:number, albums:string[]}>}
 */
export async function deleteTracks(ids, { onProgress, signal } = {}) {
  const wanted = new Set(ids);
  const tracks = (await db.getAll('tracks')).filter((t) => wanted.has(t.id));
  const albums = new Set(tracks.map((t) => t.albumKey));
  let bytes = 0, done = 0;

  for (const t of tracks) {
    if (signal?.aborted) break;
    await db.del('blobs', t.id);
    if (t.hasOriginal) await db.del('blobs', `${t.id}:orig`);
    await db.del('tracks', t.id);
    bytes += t.size || 0;
    onProgress?.(++done, tracks.length, t.title);
  }

  await sweepArtwork();
  for (const key of albums) await refreshAlbum(key);
  return { deleted: done, bytes, albums: [...albums] };
}

/** Delete every track in an album (and the album record with it). */
export async function deleteAlbum(key, opts = {}) {
  const tracks = await db.byIndex('tracks', 'albumKey', key);
  const res = await deleteTracks(tracks.map((t) => t.id), opts);
  await db.del('albums', key);
  return res;
}

/* --------------------------------- queries -------------------------------- */

export const allTracks = () => db.getAll('tracks');
export const allAlbums = () => db.getAll('albums');
export const getTrack = (id) => db.get('tracks', id);
export const getBlob = async (id) => (await db.get('blobs', id))?.blob || null;

export async function stats(settings) {
  const tracks = await db.getAll('tracks');
  const analyzed = tracks.filter((t) => t.analyzed);
  const lufs = analyzed.map((t) => t.loudness?.integratedLufs).filter((v) => typeof v === 'number');
  const scores = analyzed.map((t) => t.quality?.score).filter((v) => typeof v === 'number');
  const spread = lufs.length ? Math.max(...lufs) - Math.min(...lufs) : 0;
  return {
    tracks: tracks.length,
    analyzed: analyzed.length,
    bytes: tracks.reduce((a, t) => a + (t.size || 0), 0),
    duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
    avgLufs: lufs.length ? Math.round((lufs.reduce((a, b) => a + b, 0) / lufs.length) * 10) / 10 : null,
    spreadLu: Math.round(spread * 10) / 10,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    offTarget: lufs.filter((v) => Math.abs(v - settings.targetLufs) > 1).length,
    needsQuality: tracks.filter((t) => needsQualityNormalization(t, settings)).length,
    tiers: analyzed.reduce((m, t) => { const k = t.quality?.tier || 'pending'; m[k] = (m[k] || 0) + 1; return m; }, {}),
  };
}
