/** Minimal ZIP reader for importing a compressed album.
 *
 *  Reads the central directory, then pulls out only the entries we want and
 *  inflates them with the browser's own DecompressionStream — no library, and
 *  nothing but the current entry is ever held in memory, so a 2 GB archive of
 *  FLACs works the same as a 20 MB one.
 *
 *  Supports store (method 0) and deflate (method 8), plus ZIP64. */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const utf8 = new TextDecoder('utf-8');
const cp437ish = new TextDecoder('windows-1252');

export function isZipName(name = '') {
  return /\.(zip|zipx)$/i.test(name);
}

/** Type sniffing is unreliable for archives, so check the magic bytes too. */
export async function isZip(file) {
  if (isZipName(file.name)) return true;
  if (/zip|compressed/i.test(file.type || '')) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7);
  } catch { return false; }
}

const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

async function readSlice(blob, start, length) {
  const end = Math.min(blob.size, start + length);
  if (start >= end) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** The EOCD sits at the very end, behind a comment of up to 64 KB. */
async function findEocd(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await readSlice(blob, blob.size - tailLen, tailLen);
  const dv = dvOf(tail);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) !== EOCD_SIG) continue;
    const commentLen = dv.getUint16(i + 20, true);
    if (i + 22 + commentLen !== tail.length) continue; // not the real record
    const base = blob.size - tailLen + i;
    let entries = dv.getUint16(i + 10, true);
    let cdSize = dv.getUint32(i + 12, true);
    let cdOffset = dv.getUint32(i + 16, true);

    // ZIP64 marks the 32-bit fields as saturated and puts the real values elsewhere.
    if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const loc = await readSlice(blob, base - 20, 20);
      if (loc.length === 20 && dvOf(loc).getUint32(0, true) === EOCD64_LOCATOR_SIG) {
        const z64Off = Number(dvOf(loc).getBigUint64(8, true));
        const z64 = await readSlice(blob, z64Off, 56);
        const zdv = dvOf(z64);
        if (z64.length >= 56 && zdv.getUint32(0, true) === EOCD64_SIG) {
          entries = Number(zdv.getBigUint64(32, true));
          cdSize = Number(zdv.getBigUint64(40, true));
          cdOffset = Number(zdv.getBigUint64(48, true));
        }
      }
    }
    return { entries, cdSize, cdOffset };
  }
  throw new Error('Not a ZIP archive (no end-of-central-directory record)');
}

/** ZIP64 extra field: only the fields that were saturated are present, in order. */
function readZip64Extra(extra, entry) {
  const dv = dvOf(extra);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = dv.getUint16(p, true);
    const size = dv.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => { const v = Number(dv.getBigUint64(q, true)); q += 8; return v; };
      if (entry.uncompressedSize === 0xffffffff && q + 8 <= p + 4 + size) entry.uncompressedSize = take();
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + size) entry.compressedSize = take();
      if (entry.localOffset === 0xffffffff && q + 8 <= p + 4 + size) entry.localOffset = take();
      return;
    }
    p += 4 + size;
  }
}

/** @returns {Promise<Array<{name,compressedSize,uncompressedSize,method,localOffset}>>} */
export async function listEntries(blob) {
  const { cdOffset, cdSize } = await findEocd(blob);
  const cd = await readSlice(blob, cdOffset, cdSize || (blob.size - cdOffset));
  const dv = dvOf(cd);
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length && dv.getUint32(p, true) === CDIR_SIG) {
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const entry = {
      // Bit 11 promises UTF-8; without it the spec says CP437, but modern
      // archivers write UTF-8 anyway, so try that and fall back on failure.
      name: (flags & 0x800) ? utf8.decode(nameBytes) : decodeName(nameBytes),
      method: dv.getUint16(p + 10, true),
      compressedSize: dv.getUint32(p + 20, true),
      uncompressedSize: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true),
      encrypted: !!(flags & 0x1),
    };
    if (extraLen) readZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
    out.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return cp437ish.decode(bytes);
  }
}

/** Extract one entry to a Blob. */
export async function extract(blob, entry) {
  if (entry.encrypted) throw new Error('encrypted entry');
  // The local header repeats the name/extra with its own lengths, so the data
  // offset can only be computed by reading it — the central directory's copy lies.
  const header = await readSlice(blob, entry.localOffset, 30);
  const hdv = dvOf(header);
  if (header.length < 30 || hdv.getUint32(0, true) !== LOCAL_SIG) throw new Error('bad local header');
  const dataStart = entry.localOffset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
  const raw = blob.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`unsupported compression method ${entry.method}`);
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate ZIP entries');
  const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).blob();
}

const JUNK = /(^|\/)(__MACOSX\/|\.|Thumbs\.db$|desktop\.ini$)/i;

/**
 * Expand an archive into Files, keeping each entry's path so folder ordering and
 * folder-derived album names work exactly as they do for a real folder import.
 *
 * @param {File} file the archive
 * @param {(name:string)=>boolean} keep receives the entry PATH, not a File —
 *        an archive entry has no File object until it has been extracted
 * @returns {Promise<{files:File[], skipped:string[]}>}
 */
export async function expand(file, keep = () => true, { onProgress, signal } = {}) {
  if (typeof keep !== 'function') throw new TypeError('expand(): keep must be a function of the entry name');
  const entries = (await listEntries(file)).filter((e) =>
    !e.name.endsWith('/') && e.uncompressedSize > 0 && !JUNK.test(e.name) && keep(e.name));

  // A flat archive still belongs to an album: use the archive's own name.
  const base = file.name.replace(/\.(zip|zipx)$/i, '') || 'Archive';
  const files = [];
  const skipped = [];

  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) break;
    const entry = entries[i];
    onProgress?.(i, entries.length, entry.name);
    try {
      const data = await extract(file, entry);
      const name = entry.name.split('/').pop();
      const out = new File([data], name, { type: '' });
      const path = entry.name.includes('/') ? entry.name : `${base}/${entry.name}`;
      Object.defineProperty(out, 'relPath', { value: path, enumerable: true });
      files.push(out);
    } catch (err) {
      skipped.push(`${entry.name} (${err.message})`);
    }
  }
  onProgress?.(entries.length, entries.length, '');
  return { files, skipped };
}
