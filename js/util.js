/** Small shared helpers. */

/** The one place the app's version is written down. `sw.js` carries its own copy
 *  of the same string (a service worker cannot import from here), and Settings →
 *  Version shows both so a stale cache is visible rather than mysterious. */
export const APP_VERSION = '2.9.0';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const fmtDb = (v, digits = 1) =>
  (v === null || v === undefined || !isFinite(v)) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Stable-ish content id: size + SHA-256 of head/tail slices (cheap for large files). */
export async function fileHash(file) {
  const head = await file.slice(0, 512 * 1024).arrayBuffer();
  const tail = file.size > 1024 * 1024 ? await file.slice(file.size - 256 * 1024).arrayBuffer() : new ArrayBuffer(0);
  const buf = new Uint8Array(head.byteLength + tail.byteLength);
  buf.set(new Uint8Array(head), 0);
  buf.set(new Uint8Array(tail), head.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${file.size.toString(36)}-${hex.slice(0, 32)}`;
}

export function toast(msg, kind = '') {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/** Yield to the event loop so long batch jobs keep the UI responsive. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
export const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 200 }) : setTimeout(r, 0)));

export function sortBy(arr, key, dir = 1) {
  return arr.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x > y ? 1 : -1) * dir;
  });
}

/** Filename-friendly compare: "2 - x" before "10 - y". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

/** Folder a file came from, when the browser gave us a relative path. */
export function folderOf(file) {
  const path = file.relPath || file.webkitRelativePath || '';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

export const pathOf = (file) => file.relPath || file.webkitRelativePath || file.name || '';

/* -------------------------------- artists --------------------------------- */

/**
 * A track's artists as a list. `artists` is the stored truth once a track has
 * been edited; everything imported before that has only the single `artist`
 * string the tags carried, which is the same thing with one entry.
 */
export const artistsOf = (t) =>
  (Array.isArray(t?.artists) && t.artists.length ? t.artists : (t?.artist ? [t.artist] : []));

/** Trim, drop blanks, drop case-insensitive repeats — order is kept. */
export function cleanArtists(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [list])) {
    const name = String(raw ?? '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export const joinArtists = (list) => cleanArtists(list).join(', ');

/**
 * The one artist a track is filed under. A collaboration adds names after the
 * first without moving the track: only the first one — or the album artist,
 * which always wins — decides which record it belongs to.
 */
export const primaryArtistOf = (t) =>
  (String(t?.albumArtist || '').trim() || artistsOf(t)[0] || 'Unknown Artist');

export function albumKeyOf(t) {
  const artist = primaryArtistOf(t).trim().toLowerCase();
  const album = (t.album || 'Unknown Album').trim().toLowerCase();
  return `${artist} :: ${album}`;
}
