/** IndexedDB layer. Audio blobs live in their own store so listing tracks stays cheap. */

const NAME = 'offline-music';
const VERSION = 3;
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('albumKey', 'albumKey');
        s.createIndex('addedAt', 'addedAt');
        s.createIndex('hash', 'hash', { unique: false });
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      const art = db.objectStoreNames.contains('art')
        ? e.target.transaction.objectStore('art')
        : db.createObjectStore('art', { keyPath: 'id' });
      // v2: content hash, so identical covers dedupe and different ones never collide
      if (!art.indexNames.contains('hash')) art.createIndex('hash', 'hash');
      if (!db.objectStoreNames.contains('albums')) db.createObjectStore('albums', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'k' });
      // v3: linked folders. Holds a FileSystemDirectoryHandle, which structured
      // clone can store but only Chromium can produce — see source.js.
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another tab of this app.'));
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let out;
    const res = fn(tx.objectStore(store), tx);
    if (res && typeof res.then === 'function') res.then((v) => { out = v; });
    else if (res instanceof IDBRequest) res.onsuccess = () => { out = res.result; };
    else out = res;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  }));
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const get = (store, key) => run(store, 'readonly', (s) => wrap(s.get(key)));
export const getAll = (store) => run(store, 'readonly', (s) => wrap(s.getAll()));
export const put = (store, value) => run(store, 'readwrite', (s) => wrap(s.put(value)));
export const del = (store, key) => run(store, 'readwrite', (s) => wrap(s.delete(key)));
export const count = (store) => run(store, 'readonly', (s) => wrap(s.count()));
export const clear = (store) => run(store, 'readwrite', (s) => wrap(s.clear()));

export const putMany = (store, values) =>
  run(store, 'readwrite', (s) => Promise.all(values.map((v) => wrap(s.put(v)))));

export const getMany = (store, keys) =>
  run(store, 'readonly', (s) => Promise.all(keys.map((k) => wrap(s.get(k)))));

/** getAll(undefined) means "everything" in IndexedDB, which is never what a
 *  lookup wants — an undefined key here would silently match every record. */
export const byIndex = (store, index, value) =>
  (value === undefined || value === null
    ? Promise.resolve([])
    : run(store, 'readonly', (s) => wrap(s.index(index).getAll(value))));

/** Everything except settings — what a restore replaces, and what "Delete
 *  everything" removes. Dropping `folders` only forgets the link; the files in
 *  a linked folder are the user's and are never touched. */
export async function wipe() {
  for (const s of ['tracks', 'blobs', 'art', 'albums', 'folders']) await clear(s);
}

/* ---- settings ---- */

export const DEFAULTS = {
  mode: 'track',            // track | album | off
  targetLufs: -14,
  ceilingDbtp: -1,
  peakSafe: true,
  limiter: true,
  codec: 'opus',            // opus | wav
  bitrate: 128,             // kbps, opus only
  rate: 48000,              // 0 = keep original
  channels: 2,              // 0 = keep original
  bakeGain: false,
  keepOriginal: false,
  reencodeBetter: false,
  artSize: 512,
  thumbSize: 128,
  artQuality: 0.82,
  volume: 1,
  shuffle: false,
  repeat: 'off',            // off | all | one
  accent: '#ffffff',        // appearance — see ACCENTS
  haze: 0.08,               // grain opacity over covers and record heroes
  tintedCovers: true,       // colour records that have no cover art
  coverFilter: 'none',      // print treatment over every cover — see COVER_FILTERS
  spinDisc: true,           // rotate the press on the transport while playing
  discCover: true,          // ...and cut the cover itself to the record's face
  phoneColumns: false,      // phones show title only; true brings quality + time back
  backdrop: 'none',         // none | grooves | halftone | sleeve | image — see BACKDROPS
  backdropMono: true,       // drain the colour out of an image backdrop
  backdropDim: 0.35,        // scrim over an image backdrop, so text stays readable
  backdropImage: null,      // Blob: the user's own backdrop, downscaled on save
  liveMeter: true,          // animated output meter on the record hero while playing
};

/** The press-shop palette. Anything else the user picks still round-trips. */
export const ACCENTS = [
  { label: 'Blank', hex: '#ffffff' },
  { label: 'Rust', hex: '#e2542c' },
  { label: 'Acid', hex: '#c8ea3a' },
  { label: 'Sodium', hex: '#f0a52b' },
  { label: 'Ultra', hex: '#5b5bf5' },
  { label: 'Bleach', hex: '#e8e6e1' },
  { label: 'Rave', hex: '#f23c8c' },
];

/**
 * How covers are printed. Display only — the stored image is never touched, so
 * switching back is free and a backup still carries the original picture.
 * `mono` and `sepia` are plain CSS filters; the last three are SVG filters
 * defined in index.html, because CSS cannot posterize, dither or duotone.
 */
export const COVER_FILTERS = [
  { key: 'none', label: 'Off' },
  { key: 'mono', label: 'B&W' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'duotone', label: 'Duotone' },
  { key: 'posterize', label: 'Posterize' },
  { key: 'dither', label: 'Dither' },
];

/** Window backdrops. The first four are drawn in CSS off the accent; "image"
 *  renders whatever the user dropped into Settings → Appearance. */
export const BACKDROPS = [
  { key: 'none', label: 'Off' },
  { key: 'grooves', label: 'Grooves' },
  { key: 'halftone', label: 'Halftone' },
  { key: 'sleeve', label: 'Sleeve' },
  { key: 'image', label: 'Image' },
];

let cache = null;

export async function settings() {
  if (cache) return cache;
  const rows = await getAll('settings');
  cache = { ...DEFAULTS };
  for (const r of rows) if (r.k in DEFAULTS) cache[r.k] = r.v;
  return cache;
}

export async function setSetting(k, v) {
  const s = await settings();
  s[k] = v;
  await put('settings', { k, v });
  return s;
}
