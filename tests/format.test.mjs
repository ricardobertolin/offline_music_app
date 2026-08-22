/** Container/muxer tests that can run outside a browser: Ogg paging, the WAV
 *  writer, and the tag parsers. Run with:  node tests/format.test.mjs  */

import { OggMuxer, opusHead, opusTags, crc32 } from '../js/audio/oggopus.js';
import { encodeWav } from '../js/audio/wav.js';
import { readMetadata } from '../js/metadata.js';

let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` ${info}` : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

/* --------------------------- Ogg CRC reference ---------------------------- */

function crc32Reference(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    crc >>>= 0;
  }
  return crc >>> 0;
}

{
  const sample = new Uint8Array(1000).map(() => Math.floor(Math.random() * 256));
  ok('Ogg CRC table matches a bitwise reference', crc32(sample) === crc32Reference(sample));
  eq('Ogg CRC of "OggS"', crc32(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), crc32Reference(new Uint8Array([0x4f, 0x67, 0x67, 0x53])));
}

/* ------------------------------ Ogg round trip ---------------------------- */

const rnd = (n) => new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);

{
  const mux = new OggMuxer(0x12345678);
  const head = opusHead(2, 312);
  const tags = opusTags();
  mux.packet(head, 0, { bos: true, flush: true });
  mux.packet(tags, 0, { flush: true });

  // Deliberately awkward lengths: below, at and above the 255-byte lacing unit.
  const lens = [1, 254, 255, 256, 510, 700, 40, 39, 255, 120];
  const audio = lens.map(rnd);
  let granule = 0;
  audio.forEach((p, i) => {
    granule += 960;
    mux.packet(p, granule, { eos: i === audio.length - 1 });
  });
  const pages = mux.finish();
  const stream = new Uint8Array(pages.reduce((a, p) => a + p.length, 0));
  { let o = 0; for (const p of pages) { stream.set(p, o); o += p.length; } }

  // --- independent demuxer ---
  const packets = [];
  let p = 0, seq = 0, bosSeen = 0, eosSeen = 0, crcOk = true, cur = [];
  while (p < stream.length) {
    ok.magic = String.fromCharCode(...stream.subarray(p, p + 4)) === 'OggS';
    if (!ok.magic) break;
    const dv = new DataView(stream.buffer, p);
    const type = stream[p + 5];
    if (type & 0x02) bosSeen++;
    if (type & 0x04) eosSeen++;
    if (dv.getUint32(18, true) !== seq++) crcOk = false;
    const nseg = stream[p + 26];
    const table = stream.subarray(p + 27, p + 27 + nseg);
    // verify CRC with the field zeroed
    const pageLen = 27 + nseg + table.reduce((a, b) => a + b, 0);
    const copy = stream.slice(p, p + pageLen);
    const stored = new DataView(copy.buffer).getUint32(22, true);
    new DataView(copy.buffer).setUint32(22, 0, true);
    if (crc32Reference(copy) !== stored) crcOk = false;

    let d = p + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      cur.push(stream.subarray(d, d + table[i]));
      d += table[i];
      if (table[i] < 255) {
        const total = cur.reduce((a, b) => a + b.length, 0);
        const joined = new Uint8Array(total);
        let o = 0;
        for (const c of cur) { joined.set(c, o); o += c.length; }
        packets.push(joined);
        cur = [];
      }
    }
    p = d;
  }

  ok('every page carries the OggS magic', ok.magic === true);
  ok('page sequence numbers are contiguous and CRCs verify', crcOk);
  eq('exactly one begin-of-stream page', bosSeen, 1);
  eq('exactly one end-of-stream page', eosSeen, 1);
  eq('packet count survives paging', packets.length, audio.length + 2);
  ok('OpusHead is the first packet', String.fromCharCode(...packets[0].subarray(0, 8)) === 'OpusHead');
  ok('OpusTags is the second packet', String.fromCharCode(...packets[1].subarray(0, 8)) === 'OpusTags');
  const same = audio.every((want, i) => {
    const got = packets[i + 2];
    return got.length === want.length && got.every((b, j) => b === want[j]);
  });
  ok('packet bytes round-trip exactly (including 255-byte multiples)', same);

  // ...and the app's own Ogg reader agrees about what this file is
  const meta = await readMetadata(new Blob([stream], { type: 'audio/ogg' }));
  eq('parsed container', meta.container, 'Ogg');
  eq('parsed codec', meta.codec, 'Opus');
  eq('parsed channels', meta.channels, 2);
  eq('parsed sample rate', meta.sampleRate, 48000);
}

/* -------------------------------- WAV writer ------------------------------ */

{
  const n = 4800;
  const ch = new Float32Array(n).map((_, i) => Math.sin(i / 20) * 0.5);
  const blob = encodeWav([ch, ch], 44100, 16);
  eq('WAV blob size', blob.size, 44 + n * 2 * 2);
  const meta = await readMetadata(blob);
  eq('WAV container', meta.container, 'WAV');
  eq('WAV sample rate', meta.sampleRate, 44100);
  eq('WAV channels', meta.channels, 2);
  eq('WAV bit depth', meta.bits, 16);
  eq('WAV frame count', meta.totalSamples, n);
  ok('WAV is flagged lossless', meta.lossless === true);
}

/* ------------------------------- ID3v2 + MP3 ------------------------------ */

function synchsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}
function id3Frame(id, payload) {
  const out = [];
  for (const c of id) out.push(c.charCodeAt(0));
  out.push((payload.length >> 24) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff);
  out.push(0, 0);
  out.push(...payload);
  return out;
}
const latin1 = (s) => [0, ...[...s].map((c) => c.charCodeAt(0))];
const utf16 = (s) => {
  const out = [1, 0xff, 0xfe];
  for (const c of s) { const v = c.charCodeAt(0); out.push(v & 0xff, v >> 8); }
  return out;
};

{
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];
  const apic = [0, ...[...'image/jpeg'].map((c) => c.charCodeAt(0)), 0, 3, 0, ...jpeg];
  const frames = [
    ...id3Frame('TIT2', latin1('Nightdrive')),
    ...id3Frame('TPE1', utf16('Émile Ström')),
    ...id3Frame('TALB', latin1('After Hours')),
    ...id3Frame('TRCK', latin1('5/12')),
    ...id3Frame('TYER', latin1('1998')),
    ...id3Frame('APIC', apic),
  ];
  const mp3Frame = [0xff, 0xfb, 0x90, 0x00]; // MPEG1 Layer III, 128 kbps, 44.1 kHz, stereo
  const bytes = new Uint8Array([
    0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(frames.length),
    ...frames,
    ...mp3Frame, ...new Array(400).fill(0),
  ]);
  const meta = await readMetadata(new File([bytes], 'test.mp3', { type: 'audio/mpeg' }));
  eq('ID3 title', meta.title, 'Nightdrive');
  eq('ID3 artist (UTF-16)', meta.artist, 'Émile Ström');
  eq('ID3 album', meta.album, 'After Hours');
  eq('ID3 track number', meta.trackNo, 5);
  eq('ID3 year', meta.year, '1998');
  eq('MP3 codec', meta.codec, 'MP3');
  eq('MP3 sample rate', meta.sampleRate, 44100);
  eq('MP3 channels', meta.channels, 2);
  eq('MP3 declared bitrate', meta.declaredKbps, 128);
  ok('APIC picture extracted', !!meta.picture && meta.picture.mime === 'image/jpeg');
  ok('APIC bytes are the JPEG payload',
    meta.picture && meta.picture.bytes.length === jpeg.length && meta.picture.bytes[0] === 0xff && meta.picture.bytes[1] === 0xd8,
    `(${meta.picture?.bytes.length} bytes)`);
}

/* ---------------------------------- FLAC ---------------------------------- */

{
  const sr = 44100, chans = 2, bps = 16, total = 132300;
  const si = new Uint8Array(34);
  si[10] = (sr >> 12) & 0xff;
  si[11] = (sr >> 4) & 0xff;
  si[12] = ((sr & 0xf) << 4) | ((chans - 1) << 1) | (((bps - 1) >> 4) & 1);
  si[13] = (((bps - 1) & 0xf) << 4) | ((total / 2 ** 32) & 0xf);
  new DataView(si.buffer).setUint32(14, total >>> 0);

  const enc = new TextEncoder();
  const comments = ['TITLE=Glass Fields', 'ARTIST=Vela', 'ALBUM=Signals', 'TRACKNUMBER=3', 'DATE=2021-04-02'];
  const vendor = enc.encode('reference libFLAC');
  const parts = [];
  const u32le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  parts.push(u32le(vendor.length), vendor, u32le(comments.length));
  for (const c of comments) { const b = enc.encode(c); parts.push(u32le(b.length), b); }
  const vcLen = parts.reduce((a, b) => a + b.length, 0);
  const vc = new Uint8Array(vcLen);
  { let o = 0; for (const b of parts) { vc.set(b, o); o += b.length; } }

  const file = new Uint8Array(4 + 4 + si.length + 4 + vc.length);
  file.set(enc.encode('fLaC'), 0);
  file[4] = 0; file[5] = 0; file[6] = 0; file[7] = 34;       // STREAMINFO, 34 bytes
  file.set(si, 8);
  const vcOff = 8 + si.length;
  file[vcOff] = 0x80 | 4;                                     // last block, VORBIS_COMMENT
  file[vcOff + 1] = (vc.length >> 16) & 0xff;
  file[vcOff + 2] = (vc.length >> 8) & 0xff;
  file[vcOff + 3] = vc.length & 0xff;
  file.set(vc, vcOff + 4);

  const meta = await readMetadata(new File([file], 'test.flac', { type: 'audio/flac' }));
  eq('FLAC codec', meta.codec, 'FLAC');
  ok('FLAC is lossless', meta.lossless === true);
  eq('FLAC sample rate', meta.sampleRate, 44100);
  eq('FLAC channels', meta.channels, 2);
  eq('FLAC bit depth', meta.bits, 16);
  eq('FLAC total samples', meta.totalSamples, total);
  eq('Vorbis TITLE', meta.title, 'Glass Fields');
  eq('Vorbis ARTIST', meta.artist, 'Vela');
  eq('Vorbis ALBUM', meta.album, 'Signals');
  eq('Vorbis TRACKNUMBER', meta.trackNo, 3);
  eq('Vorbis DATE → year', meta.year, '2021');
}

/* ----------------------------------- MP4 ---------------------------------- */

function box(type, ...bodies) {
  const body = bodies.flatMap((b) => (typeof b === 'number' ? [b] : [...b]));
  const size = 8 + body.length;
  return [(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)), ...body];
}
const be32b = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16b = (n) => [(n >> 8) & 0xff, n & 0xff];
const dataBox = (payload, flags = 1) => box('data', ...be32b(flags), ...be32b(0), ...payload);
const textBox = (type, s) => box(type, ...dataBox([...new TextEncoder().encode(s)]));

{
  const stsdEntry = [
    ...be32b(36), ...[...'mp4a'].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0, 0, 0,           // reserved
    ...be16b(1),                // data reference index
    ...be16b(0), ...be16b(0),   // version, revision
    ...be32b(0),                // vendor
    ...be16b(2),                // channels
    ...be16b(16),               // sample size
    ...be16b(0), ...be16b(0),   // compression id, packet size
    ...be16b(44100), ...be16b(0), // 16.16 sample rate
  ];
  const file = new Uint8Array([
    ...box('ftyp', ...[...'M4A '].map((c) => c.charCodeAt(0)), ...be32b(0), ...[...'M4A mp42isom'].map((c) => c.charCodeAt(0))),
    ...box('moov',
      box('trak', box('mdia', box('minf', box('stbl', box('stsd', ...be32b(0), ...be32b(1), ...stsdEntry))))),
      box('udta', box('meta', ...be32b(0), box('ilst',
        textBox('\xa9nam', 'Parallel'),
        textBox('\xa9ART', 'Kite Machine'),
        textBox('aART', 'Kite Machine'),
        textBox('\xa9alb', 'Analog Hours'),
        textBox('\xa9day', '2019-11-01'),
        box('trkn', ...dataBox([0, 0, 0, 7, 0, 12, 0, 0], 0)),
      ))),
    ),
  ].flat());

  const meta = await readMetadata(new File([file], 'test.m4a', { type: 'audio/mp4' }));
  eq('MP4 container', meta.container, 'MP4');
  eq('MP4 codec', meta.codec, 'AAC');
  eq('MP4 sample rate', meta.sampleRate, 44100);
  eq('MP4 channels', meta.channels, 2);
  eq('MP4 title', meta.title, 'Parallel');
  eq('MP4 artist', meta.artist, 'Kite Machine');
  eq('MP4 album artist', meta.albumArtist, 'Kite Machine');
  eq('MP4 album', meta.album, 'Analog Hours');
  eq('MP4 year', meta.year, '2019');
  eq('MP4 track number', meta.trackNo, 7);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall format checks passed');
process.exit(fails ? 1 : 0);
