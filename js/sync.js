/** What two devices say to each other, and what they do with what arrives.
 *
 *  The wire is beam.js; this module is the meaning of the traffic. It is split
 *  that way because the interesting half is not WebRTC — it is deciding what
 *  actually has to travel.
 *
 *  A backup zip is a snapshot: pack the whole library, carry it across, unpack
 *  it. That is fine for one record and hopeless for a library, because it does
 *  not know what the other side already has. A sync starts with both devices
 *  describing themselves — one small line per track — and then only the
 *  difference moves. Run it twice and the second run sends nothing. Pull the
 *  cable halfway through and re-running picks up exactly where it stopped,
 *  because every track that finished is already committed.
 *
 *  Three things make the difference computable:
 *
 *  - **Tracks** are identified by content hash (util.fileHash), the same key the
 *    importer dedupes by. Two devices that imported the same file agree on it
 *    without ever having spoken.
 *  - **Covers** are identified by image hash plus the size they were normalized
 *    to, so a cover already held is never sent again, and a track arriving from
 *    a device with different artwork settings does not silently re-point at a
 *    differently-sized local copy.
 *  - **Records** (albums) are keyed by artist :: album, which both devices
 *    derive from tags. Only the parts a human chose — the name, the artist, a
 *    dragged track order — travel; everything else is recomputed locally.
 *
 *  Nothing here is destructive. A sync only ever adds: tracks the other device
 *  lacks, audio for rows it holds as measurements only, and covers to go with
 *  them. Deletions never propagate — "I removed that album" and "I have not
 *  imported it yet" are indistinguishable from across the wire.
 *
 *  **Edits are the fourth thing that moves.** Fixing an artist's name on the
 *  desktop and then fixing it again on the phone is the whole argument against
 *  a sync that only ever adds files, so a hand-edit travels too: a corrected
 *  title, artist, album, track number, year, genre or cover, and a record's own
 *  name, artist, track order and cover treatment. Only hand-edits — every track
 *  and every record carries `editedAt`, stamped by library.stamp() when a person
 *  changes something and never by a re-measure, an import or an artwork resize.
 *  The newer edit wins; two devices that never touched the same row cannot
 *  disagree, and a row nobody has edited (editedAt 0) never overwrites anything.
 *  A measured value — loudness, quality, duration — is never carried over an
 *  existing one: the receiver measured its own copy and is right about it. */

import * as db from './db.js';
import * as source from './source.js';
import { packLoudness, unpackLoudness } from './pack.js';
import { uid, albumKeyOf, artistsOf } from './util.js';

/** 2 added edit propagation. Purely additive: a v1 device ignores the extra
 *  fields, sends `editedAt: 0` for everything, and so neither offers nor accepts
 *  an edit — it still exchanges tracks exactly as it always did. */
export const SYNC_PROTO = 2;

/* ------------------------------ fingerprints ------------------------------ */

/** Does this device actually hold the bytes for a track? A row restored from a
 *  measurements-only backup, or left behind by a folder that went away, is a
 *  real record of a real track with nothing to play — and is exactly what the
 *  other device may be able to fill in. */
export const holdsAudio = (t) => !!t && !t.needsAudio && !t.needsRelink;

/** One line per track: enough to answer "do you have this, is it whole, and is
 *  what you know about it older than what I know?" and nothing more. A
 *  5000-track library fingerprints to a few hundred KB. */
export const trackFingerprint = (t) => ({
  hash: t.hash,
  id: t.id,
  title: t.title || '',
  album: t.album || '',
  albumKey: t.albumKey || '',
  size: t.size || 0,
  audio: holdsAudio(t),
  analyzed: !!t.analyzed,
  // When a person last corrected this row here. 0 means never, which is why a
  // freshly imported library can never talk an edited one out of its edits.
  editedAt: t.editedAt || 0,
});

/** The tag fields a person edits, and therefore the ones an edit carries. The
 *  measured ones are deliberately absent: the receiver analyzed its own copy of
 *  the file and has no reason to take a second opinion about it. */
export const META_FIELDS = [
  'title', 'artist', 'artists', 'albumArtist', 'album', 'trackNo', 'discNo', 'year', 'genre',
];

/** Covers are matched by picture *and* by the size this device normalized it
 *  to: the same photograph stored at 512 px and at 1024 px are not
 *  interchangeable, and a track should never end up pointing at a smaller
 *  cover than the one it travelled with. */
export const artFingerprint = (a) => ({
  id: a.id,
  hash: a.hash || '',
  size: a.size || 0,
  thumbSize: a.thumbSize || 0,
  quality: a.quality ?? null,
});

export const artKey = (a) => `${a.hash || ''}|${a.size || 0}|${a.thumbSize || 0}|${a.quality ?? ''}`;

/** Everything about a record that somebody chose rather than something the app
 *  measured. library.refreshAlbum hands exactly this list back when it rebuilds
 *  a record from its tracks — the two have to agree, or a rebuild would quietly
 *  drop whatever a beam had just brought in. */
export const ALBUM_CHOICES = ['name', 'artist', 'sortMode', 'coverFilter'];

/** Only what a person decided. The counts, the durations and the album loudness
 *  are recomputed from the tracks by library.refreshAlbum, so sending them
 *  would just be a second opinion about facts the receiver can check itself.
 *
 *  `updatedAt` moves every time a track on the record is re-measured, so it says
 *  nothing about intent; `editedAt` is stamped by hand-edits alone, and is what
 *  decides whose version of a record's name and treatment wins. */
export const albumFingerprint = (a) => ({
  key: a.key,
  name: a.name || '',
  artist: a.artist || '',
  sortMode: a.sortMode || 'folder',
  coverFilter: a.coverFilter || '',
  updatedAt: a.updatedAt || 0,
  editedAt: a.editedAt || 0,
});

/* -------------------------------- settings -------------------------------- */

/** Settings that describe *this device* rather than the user's taste. Volume is
 *  set by whichever room you are in, shuffle and repeat are where playback
 *  happens to be, and the last two are a phone/desktop layout choice — none of
 *  them should follow a beam across. */
export const DEVICE_LOCAL = new Set(['volume', 'shuffle', 'repeat', 'phoneColumns', 'liveMeter']);

/** The settings worth sending: plain values only. The backdrop picture is a
 *  Blob, so it travels as a file of its own and is put back by applySettings. */
export function syncableSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (DEVICE_LOCAL.has(k) || k === 'backdropImage') continue;
    if (v instanceof Blob) continue;
    if (k in db.DEFAULTS) out[k] = v;
  }
  return out;
}

/* ------------------------------- inventory -------------------------------- */

/**
 * Everything this device would be able to answer for, in the smallest form the
 * other side needs to work out what to send.
 */
export async function buildInventory() {
  const [tracks, art, albums] = await Promise.all([
    db.getAll('tracks'), db.getAll('art'), db.getAll('albums'),
  ]);
  return {
    proto: SYNC_PROTO,
    tracks: tracks.map(trackFingerprint),
    art: art.map(artFingerprint),
    albums: albums.map(albumFingerprint),
  };
}

/** An empty inventory, for the moment before the other side has spoken. */
export const emptyInventory = () => ({ proto: SYNC_PROTO, tracks: [], art: [], albums: [] });

/* ------------------------------- the diff --------------------------------- */

/**
 * What I would send you. Pure, so the whole decision can be tested without a
 * browser, a database or a peer.
 *
 * Four kinds of item come out of it:
 *   - **new** — a track whose hash you have never seen.
 *   - **fill** — a track you already hold as measurements only, and I can
 *     complete: the row on your side keeps its edits and gets its audio.
 *   - **meta** — you have the track, whole, but the last time anybody corrected
 *     it was here. The tags and the cover go; not a byte of audio does.
 *   - (skipped) — you have it, and nothing about it has changed. Nothing moves.
 *
 * @param {object} mine   my inventory
 * @param {object} theirs their inventory
 * @param {object} [o]
 * @param {string[]|null} [o.only] track ids to consider — a beam of one record
 *        rather than a sync of everything
 * @param {boolean} [o.fillHollow] send audio for rows they hold empty (default true)
 * @param {boolean} [o.syncEdits] hand over corrections to rows they already
 *        hold (default true)
 */
export function planPush(mine, theirs, { only = null, fillHollow = true, syncEdits = true } = {}) {
  const scope = only ? new Set(only) : null;
  const theirTracks = new Map((theirs?.tracks || []).map((t) => [t.hash, t]));
  const items = [];
  let bytes = 0;
  let fills = 0;
  let metas = 0;
  let skipped = 0;

  for (const t of mine?.tracks || []) {
    if (scope && !scope.has(t.id)) continue;
    const match = theirTracks.get(t.hash);
    if (match) {
      // They have the row. Two things can still be worth sending: the audio it
      // is missing (and only if this device is the one that actually has it),
      // and a correction made here since the last time they saw it.
      const fill = fillHollow && !match.audio && t.audio;
      const edited = syncEdits && (t.editedAt || 0) > (match.editedAt || 0);
      if (!fill && !edited) { skipped++; continue; }
      items.push({ ...t, reason: fill ? 'fill' : 'meta' });
      if (fill) { fills++; if (t.audio) bytes += t.size || 0; } else metas++;
    } else {
      items.push({ ...t, reason: 'new' });
      // A row we cannot play is still worth sending: it carries the analysis,
      // the artwork and the tag edits, and reattaches when the file turns up.
      if (t.audio) bytes += t.size || 0;
    }
  }

  return { items, bytes, fills, metas, added: items.length - fills - metas, skipped };
}

/** Both directions at once, for the summary shown before anything moves. */
export function summarize(mine, theirs, opts = {}) {
  const out = planPush(mine, theirs, opts);
  const back = planPush(theirs, mine, { ...opts, only: null });
  return {
    send: out,
    receive: back,
    shared: (mine?.tracks || []).filter((t) => (theirs?.tracks || []).some((o) => o.hash === t.hash)).length,
  };
}

/** Do they already hold this exact cover at this exact size? */
export function hasArt(theirs, art) {
  if (!art) return false;
  const want = artKey(art);
  return (theirs?.art || []).some((a) => artKey(a) === want);
}

/* ------------------------------ sending side ------------------------------ */

/** The bytes behind one track, pulled only when the sender reaches it.
 *  A linked track's audio is read out of its folder and sent as an ordinary
 *  stored track: the other device cannot reach a folder on this one.
 *  @param {boolean} [o.withAudio] false for an edit they already have the file
 *         for — reading a 60 MB blob to send a corrected artist would be absurd */
export async function readTrackPayload(track, { withAudio = true } = {}) {
  const linked = track.source === 'folder';
  const audio = withAudio && holdsAudio(track)
    ? (linked ? await source.tryBlobFor(track) : (await db.get('blobs', track.id))?.blob || null)
    : null;
  const original = withAudio && track.hasOriginal
    ? (await db.get('blobs', `${track.id}:orig`))?.blob || null : null;
  const art = track.artId ? await db.get('art', track.artId) : null;
  return { audio, original, art };
}

/** The record as it goes on the wire: histograms base64'd, and every trace of
 *  where the file lived on this machine dropped. */
export function packTrack(track) {
  const rec = { ...track, loudness: packLoudness(track.loudness) };
  rec.source = 'blob';
  rec.folderId = null;
  rec.relPath = '';
  rec.linked = null;
  delete rec.needsRelink;
  return rec;
}

/** Album order travels as content hashes, not as track ids: the same track can
 *  be a different row on the other device, and an order full of ids that mean
 *  nothing there is worse than no order at all. */
export async function albumOrderHashes(album, byId = null) {
  if (!album || album.sortMode !== 'custom' || !album.order?.length) return null;
  const ids = album.order;
  const rows = byId || new Map((await db.byIndex('tracks', 'albumKey', album.key)).map((t) => [t.id, t]));
  return ids.map((id) => rows.get(id)?.hash).filter(Boolean);
}

/* ----------------------------- receiving side ----------------------------- */

/**
 * Put an incoming cover in, or find the one already here.
 * @returns {Promise<string|null>} the local art id a track should point at
 */
export async function commitArt(record, { full = null, thumb = null } = {}) {
  if (!record) return null;
  const want = artKey(record);
  for (const local of await db.byIndex('art', 'hash', record.hash || '')) {
    if (artKey(local) === want) return local.id;
  }
  if (!full && !thumb) return null;   // nothing here, and no bytes came with it

  // Keep the sender's id where it is free, so a second sync recognizes it.
  let id = record.id;
  const clash = await db.get('art', id);
  if (clash && clash.hash !== record.hash) id = uid();
  await db.put('art', { ...record, id, full: full || thumb, thumb: thumb || full });
  return id;
}

/**
 * Put an incoming track in.
 *
 * A hash already here is completed (if this device was holding it empty),
 * corrected (if the sender's copy was edited more recently than this one), both,
 * or left exactly as it is. What is never overwritten is a *measurement*: this
 * device analyzed its own bytes and knows their loudness better than a stranger
 * does. And a stale row can never talk a fresh one out of its tags, because the
 * comparison is on when a person last touched each, not on who spoke last.
 *
 * @returns {Promise<'added'|'filled'|'updated'|'skipped'>}
 */
export async function commitTrack(record, { audio = null, original = null, artId = null } = {}) {
  const incoming = { ...record, loudness: unpackLoudness(record.loudness) };
  const local = (await db.byIndex('tracks', 'hash', incoming.hash))[0] || null;

  if (local) {
    const fill = !!audio && !holdsAudio(local);
    const corrected = (incoming.editedAt || 0) > (local.editedAt || 0);
    if (!fill && !corrected) return 'skipped';
    const next = { ...local };

    if (fill) {
      // The row here keeps its title, its artwork and its edits; all it was
      // missing is the file. Measurements are filled in only where it has none.
      await db.put('blobs', { id: local.id, blob: audio });
      if (original) await db.put('blobs', { id: `${local.id}:orig`, blob: original });
      Object.assign(next, {
        source: 'blob',
        folderId: null,
        relPath: '',
        needsAudio: false,
        needsRelink: false,
        size: audio.size || local.size,
        mime: local.mime || incoming.mime,
        duration: local.duration || incoming.duration,
        loudness: local.loudness || incoming.loudness,
        quality: local.quality || incoming.quality,
        analyzed: local.analyzed || incoming.analyzed,
        hasOriginal: !!original || local.hasOriginal,
        artId: local.artId || artId || null,
      });
    }

    if (corrected) {
      for (const k of META_FIELDS) if (incoming[k] !== undefined) next[k] = incoming[k];
      next.artists = artistsOf(next);           // older rows carry only `artist`
      next.albumKey = albumKeyOf(next);         // the names decide the record
      next.editedAt = incoming.editedAt;
      // A cover is part of what was fixed — but only when one actually came with
      // the edit. A sender that could not produce its artwork must not be able
      // to blank the picture that is already here.
      if (artId) next.artId = artId;
    }

    await db.put('tracks', next);
    return fill ? 'filled' : 'updated';
  }

  // A brand new row. Keep the sender's id unless this device is already using
  // it for something else — matching ids make the next sync cheaper to reason
  // about, and make a dragged album order land on the right tracks.
  let id = incoming.id;
  const clash = await db.get('tracks', id);
  if (clash) id = uid();

  const track = {
    ...incoming,
    id,
    artId: artId || null,
    needsAudio: !audio,
    needsRelink: false,
    hasOriginal: !!original,
    addedAt: incoming.addedAt || Date.now(),
  };
  if (audio) {
    await db.put('blobs', { id, blob: audio });
    if (original) await db.put('blobs', { id: `${id}:orig`, blob: original });
  }
  await db.put('tracks', track);
  return 'added';
}

/**
 * Merge an incoming record's human parts: its name, its artist, the order its
 * tracks play in and how its cover is printed.
 *
 * Which side wins is decided by `editedAt` — when a person last configured the
 * record, here against there. A newer configuration replaces this one wholesale,
 * which is the point: fix a record on the desktop and the phone stops arguing.
 *
 * With nothing newer on offer the old, careful merge still applies, because two
 * devices that have both never been touched should not flip a record's settings
 * back and forth every time they meet. A custom order in particular took real
 * work: an order dragged on this device is never thrown away for one that is not
 * demonstrably more recent.
 */
export async function commitAlbum(record, orderHashes = null) {
  const local = await db.get('albums', record.key);
  if (!local) return false;             // nothing here plays from this record yet
  const next = { ...local };
  const newer = (record.editedAt || 0) > (local.editedAt || 0);
  let touched = false;

  if (record.name && record.name !== local.name) { next.name = record.name; touched = true; }
  if (record.artist && record.artist !== local.artist) { next.artist = record.artist; touched = true; }

  if (newer && (record.coverFilter || '') !== (local.coverFilter || '')) {
    next.coverFilter = record.coverFilter || '';
    touched = true;
  }

  // Taking a sort mode from someone who has not configured this record either is
  // only safe while neither of us dragged anything into place by hand.
  if (record.sortMode && record.sortMode !== local.sortMode
      && (newer || (record.sortMode !== 'custom' && local.sortMode !== 'custom'))) {
    next.sortMode = record.sortMode;
    touched = true;
  }

  if (orderHashes?.length && (newer || local.sortMode !== 'custom')) {
    const rows = await db.byIndex('tracks', 'albumKey', record.key);
    const byHash = new Map(rows.map((t) => [t.hash, t.id]));
    const order = orderHashes.map((h) => byHash.get(h)).filter(Boolean);
    if (order.length) {
      // Tracks this device has that the sender's order says nothing about go
      // after it, rather than vanishing from the record.
      const placed = new Set(order);
      next.order = [...order, ...rows.filter((t) => !placed.has(t.id)).map((t) => t.id)];
      next.sortMode = 'custom';
      touched = true;
    }
  }

  if (touched) {
    next.editedAt = Math.max(local.editedAt || 0, record.editedAt || 0);
    next.updatedAt = Date.now();
    await db.put('albums', next);
  }
  return touched;
}

/** Take the other device's preferences. Device-local ones are dropped on the
 *  way out (syncableSettings), so this only ever writes what was offered. */
export async function applySettings(values, backdrop = null) {
  let n = 0;
  for (const [k, v] of Object.entries(values || {})) {
    if (!(k in db.DEFAULTS) || DEVICE_LOCAL.has(k) || k === 'backdropImage') continue;
    await db.setSetting(k, v);
    n++;
  }
  if (backdrop instanceof Blob) { await db.setSetting('backdropImage', backdrop); n++; }
  return n;
}
