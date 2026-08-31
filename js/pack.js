/** Typed arrays in JSON.
 *
 *  The loudness histogram (Int32Array, 900 bins) and the scrubber envelope
 *  (Uint8Array) are what make album gain and the waveform work, and JSON turns a
 *  typed array into {"0":…,"1":…} — which round-trips as an object, not an
 *  array, and quietly breaks both. Pack them as base64 instead.
 *
 *  Both ways a track can leave this device — a ZIP archive (archive.js) and a
 *  beam to another device (sync.js) — put it through here, so a track that
 *  travelled by one route is byte-identical to the same track travelling by the
 *  other. */

const B64_CHUNK = 0x8000;

export function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

export function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const packArray = (arr, type) => {
  if (!arr) return null;
  const view = arr instanceof Int32Array || arr instanceof Uint8Array ? arr
    : type === 'i32' ? Int32Array.from(arr) : Uint8Array.from(arr);
  return { t: type, d: toB64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
};

export function unpackArray(v, type) {
  if (!v) return null;
  // Tolerate a hand-edited manifest that put a plain array back.
  if (Array.isArray(v)) return type === 'i32' ? Int32Array.from(v) : Uint8Array.from(v);
  if (typeof v !== 'object' || typeof v.d !== 'string') return null;
  const bytes = fromB64(v.d);
  return type === 'i32'
    ? new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
    : bytes;
}

export const packLoudness = (l) =>
  (l ? { ...l, hist: packArray(l.hist, 'i32'), envelope: packArray(l.envelope, 'u8') } : null);

export const unpackLoudness = (l) =>
  (l ? { ...l, hist: unpackArray(l.hist, 'i32'), envelope: unpackArray(l.envelope, 'u8') } : null);
