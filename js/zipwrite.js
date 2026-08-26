/** Minimal streaming ZIP *writer* — the other half of zip.js.
 *
 *  Store only (method 0): a library is almost entirely already-compressed audio
 *  and JPEG, so deflating it would burn CPU to save nothing. What matters here
 *  is that a 40 GB backup never has to fit in memory, so the archive is produced
 *  as an async generator of chunks and pulled by the consumer.
 *
 *  Sizes are known up front (a Blob knows how big it is) but the CRC is not, so
 *  entries carry a data descriptor (general-purpose bit 3) and the real values
 *  land in the central directory. ZIP64 kicks in per field as soon as one
 *  saturates, which for a music library means the *offsets*, not the files.
 *
 *  Everything written here reads back through zip.js. */

const LOCAL_SIG = 0x04034b50;
const DD_SIG = 0x08074b50;
const CDIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;

/** The value a 32-bit field carries when the real one lives in a ZIP64 extra. */
const U32 = 0xffffffff;
const U16 = 0xffff;

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32, resumable across chunks: pass the previous result back in as `seed`. */
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/* MS-DOS packed time: two-second resolution, and years start at 1980. */
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & U16;
const dosDate = (d) => ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & U16;

/**
 * @param {AsyncIterable<{name:string, blob:Blob, date?:Date}>|Iterable<...>} entries
 * @param {object} [o]
 * @param {(done:number, bytes:number, name:string)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* zipChunks(entries, { onProgress, signal } = {}) {
  /** One record per entry, replayed into the central directory at the end. */
  const central = [];
  let offset = 0;   // bytes written so far — also the next entry's local offset
  let count = 0;

  const emit = (u8) => { offset += u8.length; return u8; };

  for await (const entry of entries) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const name = enc.encode(entry.name);
    const blob = entry.blob;
    const size = blob.size;
    const localOffset = offset;
    const date = entry.date instanceof Date && isFinite(entry.date) ? entry.date : new Date();
    // Only the local header's own fields decide this. A big *offset* is the
    // central directory's problem, and it is handled separately below.
    const bigEntry = size >= U32;

    yield emit(localHeader(name, size, date, bigEntry));

    let crc = 0;
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        crc = crc32(chunk, crc);
        yield emit(chunk);
      }
    } finally { reader.releaseLock(); }

    yield emit(dataDescriptor(crc, size, bigEntry));

    central.push({ name, size, crc, localOffset, date });
    count++;
    onProgress?.(count, offset, entry.name);
  }

  /* ---- central directory ---- */
  const cdOffset = offset;
  for (const rec of central) yield emit(centralRecord(rec));
  const cdSize = offset - cdOffset;

  // ZIP64 end record whenever any of the EOCD's own fields would saturate.
  if (central.length > U16 || cdOffset >= U32 || cdSize >= U32) {
    const eocd64At = offset;
    yield emit(eocd64(central.length, cdSize, cdOffset));
    yield emit(eocd64Locator(eocd64At));
  }
  yield emit(eocd(central.length, cdSize, cdOffset));
}

function localHeader(name, size, date, bigEntry) {
  const extraLen = bigEntry ? 20 : 0;
  const buf = new Uint8Array(30 + name.length + extraLen);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, LOCAL_SIG, true);
  dv.setUint16(4, bigEntry ? 45 : 20, true);
  dv.setUint16(6, 0x08 | 0x800, true);   // data descriptor follows; names are UTF-8
  dv.setUint16(8, 0, true);              // stored
  dv.setUint16(10, dosTime(date), true);
  dv.setUint16(12, dosDate(date), true);
  dv.setUint32(14, 0, true);             // CRC is only known once the data is written
  dv.setUint32(18, bigEntry ? U32 : size, true);
  dv.setUint32(22, bigEntry ? U32 : size, true);
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, extraLen, true);
  buf.set(name, 30);
  if (bigEntry) {
    const p = 30 + name.length;
    dv.setUint16(p, 0x0001, true);
    dv.setUint16(p + 2, 16, true);
    dv.setBigUint64(p + 4, BigInt(size), true);
    dv.setBigUint64(p + 12, BigInt(size), true);
  }
  return buf;
}

/** Bit 3's promise: the real CRC and sizes, right after the data. */
function dataDescriptor(crc, size, bigEntry) {
  const buf = new Uint8Array(bigEntry ? 24 : 16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, DD_SIG, true);
  dv.setUint32(4, crc, true);
  if (bigEntry) {
    dv.setBigUint64(8, BigInt(size), true);
    dv.setBigUint64(16, BigInt(size), true);
  } else {
    dv.setUint32(8, size, true);
    dv.setUint32(12, size, true);
  }
  return buf;
}

function centralRecord({ name, size, crc, localOffset, date }) {
  // The ZIP64 extra carries exactly the fields that saturated, in this order —
  // which is the order zip.js reads them back in.
  const bigSize = size >= U32;
  const bigOffset = localOffset >= U32;
  const fields = (bigSize ? 2 : 0) + (bigOffset ? 1 : 0);
  const extraLen = fields ? 4 + fields * 8 : 0;
  const buf = new Uint8Array(46 + name.length + extraLen);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, CDIR_SIG, true);
  dv.setUint16(4, extraLen ? 45 : 20, true);   // version made by
  dv.setUint16(6, extraLen ? 45 : 20, true);   // version needed
  dv.setUint16(8, 0x08 | 0x800, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, dosTime(date), true);
  dv.setUint16(14, dosDate(date), true);
  dv.setUint32(16, crc, true);
  dv.setUint32(20, bigSize ? U32 : size, true);
  dv.setUint32(24, bigSize ? U32 : size, true);
  dv.setUint16(28, name.length, true);
  dv.setUint16(30, extraLen, true);
  dv.setUint16(32, 0, true);   // comment
  dv.setUint16(34, 0, true);   // disk
  dv.setUint16(36, 0, true);   // internal attrs
  dv.setUint32(38, 0, true);   // external attrs
  dv.setUint32(42, bigOffset ? U32 : localOffset, true);
  buf.set(name, 46);
  if (extraLen) {
    let p = 46 + name.length;
    dv.setUint16(p, 0x0001, true);
    dv.setUint16(p + 2, fields * 8, true);
    p += 4;
    if (bigSize) {
      dv.setBigUint64(p, BigInt(size), true); p += 8;   // uncompressed
      dv.setBigUint64(p, BigInt(size), true); p += 8;   // compressed
    }
    if (bigOffset) dv.setBigUint64(p, BigInt(localOffset), true);
  }
  return buf;
}

function eocd64(entries, cdSize, cdOffset) {
  const buf = new Uint8Array(56);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, EOCD64_SIG, true);
  dv.setBigUint64(4, 44n, true);   // size of this record from byte 12 on
  dv.setUint16(12, 45, true);
  dv.setUint16(14, 45, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, 0, true);
  dv.setBigUint64(24, BigInt(entries), true);
  dv.setBigUint64(32, BigInt(entries), true);
  dv.setBigUint64(40, BigInt(cdSize), true);
  dv.setBigUint64(48, BigInt(cdOffset), true);
  return buf;
}

function eocd64Locator(at) {
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, EOCD64_LOCATOR_SIG, true);
  dv.setUint32(4, 0, true);
  dv.setBigUint64(8, BigInt(at), true);
  dv.setUint32(16, 1, true);
  return buf;
}

function eocd(entries, cdSize, cdOffset) {
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, EOCD_SIG, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, Math.min(entries, U16), true);
  dv.setUint16(10, Math.min(entries, U16), true);
  dv.setUint32(12, Math.min(cdSize, U32), true);
  dv.setUint32(16, Math.min(cdOffset, U32), true);
  dv.setUint16(20, 0, true);
  return buf;
}

/** Wrap the generator so the consumer's backpressure reaches it: `pull` is only
 *  called when there is room, so exactly one chunk is ever in flight. */
export function zipStream(entries, opts) {
  const gen = zipChunks(entries, opts);
  return new ReadableStream({
    async pull(ctrl) {
      const { value, done } = await gen.next();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel(reason) { gen.return?.(reason); },
  });
}

/**
 * Write a stream to a file the user chooses.
 *
 * With the File System Access API the bytes go straight to disk and nothing is
 * held; without it the stream is collected into a Blob first (browsers back a
 * large one on disk, so this survives more than it looks like it should) and
 * handed to a download link.
 *
 * @returns {Promise<'file'|'download'>} which of the two paths ran
 */
export async function saveStream(stream, filename, { types } = {}) {
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: filename, types });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      handle = null;   // not allowed here (an iframe, say) — fall through
    }
    if (handle) {
      const writable = await handle.createWritable();
      await stream.pipeTo(writable);
      return 'file';
    }
  }
  const blob = await new Response(stream).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'download';
}
