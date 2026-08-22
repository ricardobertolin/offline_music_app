/** ZIP reader checks. Archives are built here with Node's zlib (raw deflate),
 *  byte-for-byte in the real format, then read back by js/zip.js.
 *  Run with:  node tests/zip.test.mjs  */

import { deflateRawSync, crc32 } from 'node:zlib';
import { listEntries, extract, expand, isZip, isZipName } from '../js/zip.js';

let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const enc = new TextEncoder();
const u16 = (n) => [n & 255, (n >> 8) & 255];
const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/**
 * Build a ZIP. `store` forces method 0; `utf8Flag` sets the language bit.
 * @param {Array<{name:string, data:Uint8Array, store?:boolean}>} entries
 */
function makeZip(entries, { utf8Flag = true } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const raw = Buffer.from(e.data);
    const deflated = e.store ? raw : deflateRawSync(raw);
    const method = e.store ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    const flags = utf8Flag ? 0x800 : 0;

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method),
      ...u16(0), ...u16(0), ...u32(crc),
      ...u32(deflated.length), ...u32(raw.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ];
    parts.push(Buffer.from(local), deflated);

    central.push(Buffer.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method),
      ...u16(0), ...u16(0), ...u32(crc),
      ...u32(deflated.length), ...u32(raw.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    offset += local.length + deflated.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(cd.length), ...u32(offset), ...u16(0),
  ]);
  return new File([Buffer.concat([...parts, cd, eocd])], 'album.zip', { type: 'application/zip' });
}

const text = (s) => enc.encode(s);
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const decode = async (blob) => new TextDecoder().decode(await bytesOf(blob));

/* ------------------------------- detection -------------------------------- */

ok('isZipName accepts .zip', isZipName('Album.zip') && isZipName('x.ZIPX'));
ok('isZipName rejects audio', !isZipName('song.mp3'));

/* ------------------------- listing and extraction ------------------------- */
{
  const big = 'A'.repeat(50000) + 'END';   // compresses well, exercises deflate
  const zip = makeZip([
    { name: 'Album/01 first.mp3', data: text('first-track-data') },
    { name: 'Album/02 second.mp3', data: text(big) },
    { name: 'Album/cover.jpg', data: text('not audio') },
    { name: 'Album/03 stored.flac', data: text('stored-entry'), store: true },
    { name: 'Album/', data: new Uint8Array(0) },
    { name: '__MACOSX/Album/._01 first.mp3', data: text('junk') },
  ]);

  ok('isZip detects the archive by magic bytes', await isZip(zip));

  const entries = await listEntries(zip);
  eq('every entry is listed', entries.length, 6);
  eq('names round-trip', entries[0].name, 'Album/01 first.mp3');
  eq('deflate is method 8', entries[1].method, 8);
  eq('stored entry is method 0', entries[3].method, 0);
  ok('deflate actually compressed', entries[1].compressedSize < entries[1].uncompressedSize,
    `${entries[1].compressedSize} < ${entries[1].uncompressedSize}`);

  eq('extract inflates a deflated entry', await decode(await extract(zip, entries[0])), 'first-track-data');
  eq('extract handles a large deflated entry', (await decode(await extract(zip, entries[1]))).length, big.length);
  eq('extract reads a stored entry', await decode(await extract(zip, entries[3])), 'stored-entry');

  // expand() filters, skips junk and directories, and keeps paths
  const { files } = await expand(zip, (n) => /\.(mp3|flac)$/i.test(n));
  eq('expand keeps only the wanted entries', files.map((f) => f.name),
    ['01 first.mp3', '02 second.mp3', '03 stored.flac']);
  eq('expand preserves the folder path', files[0].relPath, 'Album/01 first.mp3');
  eq('expand skips __MACOSX junk', files.some((f) => f.name.startsWith('._')), false);
  eq('expanded file content is intact', await decode(files[0]), 'first-track-data');
  eq('expanded sizes are the uncompressed sizes', files[1].size, big.length);
}

/* ---------------------------- flat archive path --------------------------- */
{
  const zip = makeZip([
    { name: 'track1.mp3', data: text('a') },
    { name: 'track2.mp3', data: text('b') },
  ]);
  const { files } = await expand(zip, () => true);
  eq('a flat archive is filed under the archive name',
    files.map((f) => f.relPath), ['album/track1.mp3', 'album/track2.mp3']);
}

/* ------------------------------ unicode names ----------------------------- */
{
  const zip = makeZip([{ name: 'Ålbum/01 – Émile Ström.mp3', data: text('x') }]);
  const entries = await listEntries(zip);
  eq('UTF-8 entry names decode', entries[0].name, 'Ålbum/01 – Émile Ström.mp3');
}

/* -------------------------- archive with a comment ------------------------ */
{
  // The EOCD scan must not stop at a signature that appears inside the comment.
  const base = makeZip([{ name: 'Album/01.mp3', data: text('hello') }]);
  const raw = Buffer.from(await base.arrayBuffer());
  const comment = Buffer.from([...u32(0x06054b50), ...Buffer.from('decoy comment')]);
  const withComment = Buffer.concat([raw, comment]);
  withComment.writeUInt16LE(comment.length, withComment.length - comment.length - 2);
  const zip = new File([withComment], 'commented.zip', { type: 'application/zip' });

  const entries = await listEntries(zip);
  eq('a trailing comment does not break the EOCD scan', entries.length, 1);
  eq('and the entry still extracts', await decode(await extract(zip, entries[0])), 'hello');
}

/* --------------------------------- errors --------------------------------- */
{
  const notZip = new File([text('this is not a zip at all')], 'nope.txt', { type: 'text/plain' });
  ok('a non-archive is not detected as one', !(await isZip(notZip)));
  let threw = false;
  try { await listEntries(notZip); } catch { threw = true; }
  ok('listing a non-archive throws', threw);

  // An unsupported method is skipped, not fatal.
  const zip = makeZip([{ name: 'Album/a.mp3', data: text('ok') }, { name: 'Album/b.mp3', data: text('bad') }]);
  const buf = Buffer.from(await zip.arrayBuffer());
  const sig = Buffer.from(u32(0x02014b50));
  const first = buf.indexOf(sig);
  const second = buf.indexOf(sig, first + 4);
  ok('test setup found both central directory entries', first > 0 && second > first);
  buf.writeUInt16LE(99, second + 10); // bogus compression method on entry 2
  const { files, skipped } = await expand(new File([buf], 'x.zip'), () => true);
  eq('a broken entry is skipped, the rest still import', files.length, 1);
  ok('the skipped entry is reported', skipped.length === 1, skipped[0]);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall zip checks passed');
process.exit(fails ? 1 : 0);
