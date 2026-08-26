/** ZIP writer checks: everything zipwrite.js produces has to read back through
 *  zip.js, and its CRCs have to agree with a second implementation (Node's).
 *  Run with:  node tests/zipwrite.test.mjs  */

import { crc32 as nodeCrc } from 'node:zlib';
import { zipChunks, crc32 } from '../js/zipwrite.js';
import { listEntries, extract } from '../js/zip.js';

let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};

const enc = new TextEncoder();
/** Deterministic filler that is not compressible enough to be interesting. */
const fill = (n, seed) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * seed + 7) & 255;
  return a;
};
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------- crc32 ---------------------------------- */

const sample = fill(100000, 13);
ok('crc32 agrees with node:zlib', crc32(sample) === nodeCrc(Buffer.from(sample)));
ok('crc32 is resumable across chunks',
  crc32(sample.subarray(40000), crc32(sample.subarray(0, 40000))) === crc32(sample));
ok('crc32 of nothing is 0', crc32(new Uint8Array(0)) === 0);

/* ---------------------------- round trip -------------------------------- */

const entries = [
  { name: 'manifest.json', blob: new Blob([enc.encode(JSON.stringify({ hello: 'wörld', n: 1 }))]) },
  { name: 'audio/one.wav', blob: new Blob([fill(300000, 3)]) },
  { name: 'art/cover ünï.jpg', blob: new Blob([fill(9, 5)]) },
  { name: 'empty.bin', blob: new Blob([]) },
];

const collect = async (iter, opts) => {
  const parts = [];
  for await (const chunk of zipChunks(iter, opts)) parts.push(chunk);
  return new Blob(parts);
};

const zip = await collect(entries);
const listed = await listEntries(zip);

ok('every entry is in the central directory', listed.length === entries.length,
  listed.map((e) => e.name).join(' | '));
ok('names survive as UTF-8', listed[2]?.name === 'art/cover ünï.jpg', listed[2]?.name);
ok('entries are stored, not deflated', listed.every((e) => e.method === 0));

for (let i = 0; i < entries.length; i++) {
  const want = await bytesOf(entries[i].blob);
  const got = await bytesOf(await extract(zip, listed[i]));
  ok(`round-trips ${entries[i].name}`, same(got, want), `${got.length} of ${want.length} bytes`);
  ok(`declares the size of ${entries[i].name}`, listed[i].uncompressedSize === want.length);
}

/* The CRCs in the central directory are what a real unzip validates against —
   a data descriptor is only trustworthy if these match. */
for (let i = 0; i < entries.length; i++) {
  const want = nodeCrc(Buffer.from(await bytesOf(entries[i].blob)));
  ok(`central CRC matches for ${entries[i].name}`, await crcOfEntry(zip, listed[i]) === want);
}

/** Pull the CRC straight back out of the central directory. */
async function crcOfEntry(blob, entry) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const nameBytes = enc.encode(entry.name);
  for (let p = 0; p + 46 <= buf.length; p++) {
    if (dv.getUint32(p, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(p + 28, true);
    if (nameLen !== nameBytes.length) continue;
    if (!nameBytes.every((b, i) => buf[p + 46 + i] === b)) continue;
    return dv.getUint32(p + 16, true);
  }
  return -1;
}

/* --------------------------- async sources ------------------------------ */

/** The real exporter feeds an async generator so one blob is loaded at a time. */
async function* lazy() {
  for (const e of entries) yield e;
}
const lazyZip = await collect(lazy());
ok('an async iterable produces the same archive', lazyZip.size === zip.size);

/* ------------------------------ progress -------------------------------- */

const seen = [];
await collect(entries, { onProgress: (done, bytes, name) => seen.push([done, name]) });
ok('progress reports every entry in order',
  JSON.stringify(seen.map((s) => s[0])) === '[1,2,3,4]'
  && seen[1][1] === 'audio/one.wav');

/* ------------------------------- cancel --------------------------------- */

const ctrl = new AbortController();
ctrl.abort();
let aborted = false;
try { await collect(entries, { signal: ctrl.signal }); }
catch (err) { aborted = err?.name === 'AbortError'; }
ok('an aborted signal stops the export', aborted);

/* -------------------------- many small entries -------------------------- */

/* Exercises the central directory across a lot of records — a real library
   backup is thousands of entries, not four. */
const many = Array.from({ length: 300 }, (_, i) => ({
  name: `audio/track-${i}.bin`,
  blob: new Blob([fill(64 + i, i + 1)]),
}));
const manyZip = await collect(many);
const manyList = await listEntries(manyZip);
ok('300 entries all land', manyList.length === 300);
const midWant = await bytesOf(many[157].blob);
const midGot = await bytesOf(await extract(manyZip, manyList[157]));
ok('an entry deep in the archive still extracts', same(midGot, midWant));

console.log(fails ? `\n${fails} FAILED` : '\nAll zip writer checks passed');
process.exit(fails ? 1 : 0);
