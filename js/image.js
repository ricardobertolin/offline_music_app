/** Artwork normalization: every cover becomes the same square size, format and
 *  quality, with a matching thumbnail — so lists stay fast and covers stop being
 *  4000×4000 PNGs stored inside every single track. */

import { uid } from './util.js';
import { put, get, byIndex } from './db.js';

const WEBP = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch { return false; }
})();

export const ART_MIME = WEBP ? 'image/webp' : 'image/jpeg';

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas encode failed'))), type, quality));
}

/** Center-crop to a square and resize, in two steps for a cleaner downscale. */
async function square(bitmap, size, quality) {
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2, sy = (bitmap.height - side) / 2;

  let src = bitmap, srcSide = side, sxx = sx, syy = sy;
  // Halving pass avoids the aliasing you get jumping 3000px → 128px in one draw.
  while (srcSide > size * 2) {
    const half = Math.max(size, Math.round(srcSide / 2));
    const c = makeCanvas(half, half);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sxx, syy, srcSide, srcSide, 0, 0, half, half);
    if (src !== bitmap && src.close) src.close();
    src = c; srcSide = half; sxx = 0; syy = 0;
  }

  const out = makeCanvas(size, size);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sxx, syy, srcSide, srcSide, 0, 0, size, size);
  if (src !== bitmap && src.close) src.close();
  const blob = await toBlob(out, ART_MIME, quality);
  return { blob, canvas: out };
}

/** Average colour, used as the UI accent for that album. */
function averageColor(canvas) {
  try {
    const c = makeCanvas(8, 8);
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return `#${[r, gr, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('')}`;
  } catch { return '#2a3140'; }
}

/** SHA-256 of the source image, so identical covers are stored once and
 *  different covers can never be mistaken for each other. */
export async function imageHash(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

const toBlobSource = (source) => (source instanceof Blob
  ? source
  : new Blob([source.bytes.slice ? source.bytes.slice() : source.bytes], { type: source.mime || 'image/jpeg' }));

/**
 * Normalize any image into the stored art record.
 * @param {Blob|File|{bytes:Uint8Array, mime:string}} source
 * @param {{size:number, thumbSize:number, artQuality:number}} settings
 */
export async function normalizeArtwork(source, settings) {
  const blob = toBlobSource(source);
  const hash = await imageHash(blob);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob); // older Safari has no options bag
  }

  const size = settings.artSize || 512;
  const thumbSize = settings.thumbSize || 128;
  const q = settings.artQuality ?? 0.82;

  const full = await square(bitmap, size, q);
  const thumb = await square(bitmap, thumbSize, Math.min(0.9, q + 0.05));
  const color = averageColor(full.canvas);
  const originalW = bitmap.width, originalH = bitmap.height;
  bitmap.close?.();

  return {
    id: uid(),
    hash,
    full: full.blob,
    thumb: thumb.blob,
    mime: ART_MIME,
    size,
    thumbSize,
    quality: q,
    color,
    originalW,
    originalH,
    originalBytes: blob.size,
    bytes: full.blob.size + thumb.blob.size,
    at: Date.now(),
  };
}

/**
 * Normalize + store, returning the art record to hang on a track/album.
 *
 * Dedupe is by image *content*, never by which album asked for it: a whole album
 * embedding the same cover stores one record, while two albums with different
 * covers can never end up sharing one — however similar their tags are.
 */
export async function saveArtwork(source, settings) {
  const blob = toBlobSource(source);
  const hash = await imageHash(blob);
  const existing = await byIndex('art', 'hash', hash);
  const match = existing.find((a) =>
    a.size === (settings.artSize || 512)
    && a.thumbSize === (settings.thumbSize || 128)
    && a.quality === (settings.artQuality ?? 0.82));
  if (match) return match;

  const art = await normalizeArtwork(blob, settings);
  await put('art', art);
  return art;
}

/* -------------------------------- URL cache ------------------------------- */

const urls = new Map(); // `${id}:${kind}` → objectURL

export async function artUrl(id, kind = 'thumb') {
  if (!id) return null;
  const key = `${id}:${kind}`;
  if (urls.has(key)) return urls.get(key);
  const rec = await get('art', id);
  const blob = rec && (kind === 'full' ? rec.full : rec.thumb);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

export function forgetArtUrl(id) {
  for (const kind of ['thumb', 'full']) {
    const key = `${id}:${kind}`;
    if (urls.has(key)) { URL.revokeObjectURL(urls.get(key)); urls.delete(key); }
  }
}
