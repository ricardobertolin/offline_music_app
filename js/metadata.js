/** Container sniffing + tag reading for the formats browsers can decode.
 *  Everything is best-effort: a parse failure only means fewer tags, never a failed import. */

const dec = {
  utf8: new TextDecoder('utf-8'),
  latin1: new TextDecoder('windows-1252'),
  utf16: new TextDecoder('utf-16'),        // honours BOM
  utf16be: new TextDecoder('utf-16be'),
};

const str = (u8, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
  return s;
};
const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const be24 = (u8, o) => (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];
const be16 = (u8, o) => (u8[o] << 8) | u8[o + 1];
const le32 = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
const le16 = (u8, o) => u8[o] | (u8[o + 1] << 8);
const synch = (u8, o) => ((u8[o] & 0x7f) << 21) | ((u8[o + 1] & 0x7f) << 14) | ((u8[o + 2] & 0x7f) << 7) | (u8[o + 3] & 0x7f);

function blank() {
  return {
    title: '', artist: '', albumArtist: '', album: '', trackNo: 0, discNo: 0, year: '', genre: '',
    container: '', codec: '', lossless: false, vbr: false,
    sampleRate: 0, channels: 0, bits: 0, declaredKbps: 0, totalSamples: 0,
    picture: null, // { bytes: Uint8Array, mime }
  };
}

/** @param {File|Blob} file */
export async function readMetadata(file) {
  const out = blank();
  let u8;
  try {
    // Tags live at the head of every format we read except MP4, whose moov box is
    // often at the end. Reading 8 MB instead of a 300 MB FLAC keeps phones alive.
    const HEAD_LIMIT = 8 * 1024 * 1024;
    let source = file;
    if (file.size > HEAD_LIMIT) {
      const probe = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (str(probe, 4, 4) !== 'ftyp') source = file.slice(0, HEAD_LIMIT);
    }
    u8 = new Uint8Array(await source.arrayBuffer());
  } catch { return out; }

  try {
    let off = 0;
    if (str(u8, 0, 3) === 'ID3' && u8[3] < 5) {
      parseID3(u8, out);
      off = 10 + synch(u8, 6) + (u8[5] & 0x10 ? 10 : 0); // + footer
    }
    if (str(u8, off, 4) === 'fLaC') parseFlac(u8, off, out);
    else if (str(u8, 0, 4) === 'OggS') parseOgg(u8, out);
    else if (str(u8, 0, 4) === 'RIFF' && str(u8, 8, 4) === 'WAVE') parseWav(u8, out);
    else if (str(u8, 4, 4) === 'ftyp') parseMp4(u8, out);
    else if (str(u8, 0, 4) === 'FORM' && str(u8, 8, 3) === 'AIF') parseAiff(u8, out);
    else if (str(u8, 0, 4) === 'wvpk') { out.container = 'WavPack'; out.codec = 'WavPack'; out.lossless = true; }
    else parseMpeg(u8, off, out, file.size);
  } catch { /* keep whatever we already collected */ }

  if (!out.container) {
    const ext = (file.name || '').split('.').pop().toLowerCase();
    out.container = ext ? ext.toUpperCase() : (file.type || 'audio');
    out.codec = out.codec || out.container;
  }
  return out;
}

/* ------------------------------------------------------------------ ID3v2 */

function textFrame(data) {
  if (!data.length) return '';
  const enc = data[0];
  const body = data.subarray(1);
  // Strip the terminator. UTF-16 has to lose whole code units, otherwise the
  // low byte of the last character ("m" = 6D 00) gets eaten with it.
  const cut = (arr, wide) => {
    let end = arr.length;
    if (wide) {
      while (end >= 2 && arr[end - 1] === 0 && arr[end - 2] === 0) end -= 2;
      if (end % 2) end--;
    } else {
      while (end > 0 && arr[end - 1] === 0) end--;
    }
    return arr.subarray(0, end);
  };
  let s;
  if (enc === 1) s = dec.utf16.decode(cut(body, true));
  else if (enc === 2) s = dec.utf16be.decode(cut(body, true));
  else if (enc === 3) s = dec.utf8.decode(cut(body));
  else s = dec.latin1.decode(cut(body));
  return s.split('\u0000')[0].trim(); // multi-value: keep the first
}

function parseID3(u8, out) {
  const ver = u8[3];
  const flags = u8[5];
  const size = synch(u8, 6);
  let p = 10;
  const end = Math.min(10 + size, u8.length);
  if (flags & 0x40) p += ver === 4 ? synch(u8, p) : be32(u8, p) + 4; // extended header
  const idLen = ver >= 3 ? 4 : 3;
  const hdrLen = ver >= 3 ? 10 : 6;

  while (p + hdrLen <= end) {
    const id = str(u8, p, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fsize;
    if (ver === 4) {
      fsize = synch(u8, p + 4);
      // Some taggers write plain 32-bit sizes in v2.4 frames; detect and fix.
      const plain = be32(u8, p + 4);
      if (fsize !== plain && p + 10 + plain <= end && (plain > fsize)) {
        const nextId = str(u8, p + 10 + plain, 4);
        if (/^[A-Z0-9]{4}$/.test(nextId)) fsize = plain;
      }
    } else if (ver === 3) fsize = be32(u8, p + 4);
    else fsize = be24(u8, p + 3);
    if (fsize <= 0 || p + hdrLen + fsize > end) break;

    const data = u8.subarray(p + hdrLen, p + hdrLen + fsize);
    id3Frame(id, data, out);
    p += hdrLen + fsize;
  }
}

function id3Frame(id, data, out) {
  switch (id) {
    case 'TIT2': case 'TT2': out.title = textFrame(data); break;
    case 'TPE1': case 'TP1': out.artist = textFrame(data); break;
    case 'TPE2': case 'TP2': out.albumArtist = textFrame(data); break;
    case 'TALB': case 'TAL': out.album = textFrame(data); break;
    case 'TCON': case 'TCO': out.genre = textFrame(data).replace(/^\((\d+)\)/, ''); break;
    case 'TRCK': case 'TRK': out.trackNo = parseInt(textFrame(data), 10) || 0; break;
    case 'TPOS': case 'TPA': out.discNo = parseInt(textFrame(data), 10) || 0; break;
    case 'TDRC': case 'TYER': case 'TYE': case 'TDAT':
      out.year = out.year || (textFrame(data).match(/\d{4}/)?.[0] ?? ''); break;
    case 'APIC': case 'PIC': {
      if (out.picture) break;
      const enc = data[0];
      let p = 1, mime;
      if (id === 'PIC') { mime = { PNG: 'image/png', JPG: 'image/jpeg' }[str(data, 1, 3).toUpperCase()] || 'image/jpeg'; p = 4; }
      else { let e = p; while (e < data.length && data[e] !== 0) e++; mime = dec.latin1.decode(data.subarray(p, e)) || 'image/jpeg'; p = e + 1; }
      p += 1; // picture type
      // description, terminated by NUL (or double-NUL for UTF-16)
      if (enc === 1 || enc === 2) { while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < data.length && data[p] !== 0) p++; p += 1; }
      if (p < data.length) out.picture = { bytes: data.subarray(p), mime: mime.startsWith('image/') ? mime : `image/${mime}` };
      break;
    }
  }
}

/* -------------------------------------------------------------------- MPEG */

const MPEG_RATE = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];
const BR_V1 = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const BR_V2 = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function parseMpeg(u8, off, out) {
  // find the first valid frame sync within a reasonable window
  let p = -1;
  for (let i = off; i < Math.min(u8.length - 4, off + 200000); i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
      const verBits = (u8[i + 1] >> 3) & 3, layerBits = (u8[i + 1] >> 1) & 3;
      const brIdx = u8[i + 2] >> 4, srIdx = (u8[i + 2] >> 2) & 3;
      if (verBits !== 1 && layerBits !== 0 && brIdx !== 0 && brIdx !== 15 && srIdx !== 3) { p = i; break; }
    }
  }
  if (p < 0) return;
  const verBits = (u8[p + 1] >> 3) & 3;
  const layer = 4 - ((u8[p + 1] >> 1) & 3);
  const brIdx = u8[p + 2] >> 4, srIdx = (u8[p + 2] >> 2) & 3;
  const mode = (u8[p + 3] >> 6) & 3;

  out.container = 'MPEG';
  out.codec = layer === 3 ? 'MP3' : `MPEG Layer ${layer}`;
  out.sampleRate = MPEG_RATE[verBits]?.[srIdx] || 0;
  out.channels = mode === 3 ? 1 : 2;
  out.declaredKbps = (verBits === 3 ? BR_V1 : BR_V2)[layer]?.[brIdx] || 0;
  // Xing/Info/VBRI header ⇒ variable bitrate
  const side = verBits === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
  const tag = str(u8, p + 4 + side, 4);
  out.vbr = tag === 'Xing' || tag === 'VBRI' || str(u8, p + 36, 4) === 'VBRI';
  if (tag === 'Info') out.vbr = false;
}

/* -------------------------------------------------------------------- FLAC */

function parseFlac(u8, off, out) {
  out.container = 'FLAC'; out.codec = 'FLAC'; out.lossless = true;
  let p = off + 4, last = false;
  while (!last && p + 4 <= u8.length) {
    const header = u8[p];
    last = !!(header & 0x80);
    const type = header & 0x7f;
    const len = be24(u8, p + 1);
    const body = u8.subarray(p + 4, p + 4 + len);
    if (type === 0 && len >= 34) {
      out.sampleRate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4);
      out.channels = ((body[12] >> 1) & 7) + 1;
      out.bits = (((body[12] & 1) << 4) | (body[13] >> 4)) + 1;
      out.totalSamples = ((body[13] & 0x0f) * 2 ** 32) + be32(body, 14);
    } else if (type === 4) {
      parseVorbisComments(body, 0, out);
    } else if (type === 6 && !out.picture) {
      readFlacPicture(body, out);
    }
    p += 4 + len;
  }
}

function readFlacPicture(b, out) {
  try {
    let p = 4;
    const mimeLen = be32(b, p); p += 4;
    const mime = dec.latin1.decode(b.subarray(p, p + mimeLen)); p += mimeLen;
    const descLen = be32(b, p); p += 4 + descLen;
    p += 16; // w,h,depth,colors
    const dataLen = be32(b, p); p += 4;
    out.picture = { bytes: b.subarray(p, p + dataLen), mime: mime || 'image/jpeg' };
  } catch { /* ignore */ }
}

/** Vorbis comment block: LE lengths, "KEY=value" in UTF-8. */
function parseVorbisComments(b, start, out) {
  let p = start;
  const vlen = le32(b, p); p += 4 + vlen;
  const n = le32(b, p); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = le32(b, p); p += 4;
    const kv = dec.utf8.decode(b.subarray(p, p + len)); p += len;
    const eq = kv.indexOf('=');
    if (eq < 1) continue;
    const key = kv.slice(0, eq).toUpperCase(), val = kv.slice(eq + 1).trim();
    if (!val) continue;
    switch (key) {
      case 'TITLE': out.title ||= val; break;
      case 'ARTIST': out.artist ||= val; break;
      case 'ALBUMARTIST': case 'ALBUM ARTIST': out.albumArtist ||= val; break;
      case 'ALBUM': out.album ||= val; break;
      case 'GENRE': out.genre ||= val; break;
      case 'DATE': case 'YEAR': out.year ||= (val.match(/\d{4}/)?.[0] ?? ''); break;
      case 'TRACKNUMBER': out.trackNo ||= parseInt(val, 10) || 0; break;
      case 'DISCNUMBER': out.discNo ||= parseInt(val, 10) || 0; break;
      case 'METADATA_BLOCK_PICTURE':
        if (!out.picture) {
          try {
            const bin = atob(val);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            readFlacPicture(bytes, out);
          } catch { /* ignore */ }
        }
        break;
    }
  }
}

/* --------------------------------------------------------------------- Ogg */

function parseOgg(u8, out) {
  out.container = 'Ogg';
  const packets = [];
  let p = 0, cur = [];
  while (p + 27 <= u8.length && packets.length < 3) {
    if (str(u8, p, 4) !== 'OggS') break;
    const nseg = u8[p + 26];
    const table = u8.subarray(p + 27, p + 27 + nseg);
    let d = p + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      const len = table[i];
      cur.push(u8.subarray(d, d + len));
      d += len;
      if (len < 255) { packets.push(concat(cur)); cur = []; }
    }
    p = d;
  }
  const first = packets[0];
  if (!first) return;
  if (str(first, 0, 8) === 'OpusHead') {
    out.codec = 'Opus';
    out.channels = first[9];
    out.sampleRate = 48000;              // Opus always decodes at 48 kHz
    out.vbr = true;
    if (packets[1] && str(packets[1], 0, 8) === 'OpusTags') parseVorbisComments(packets[1], 8, out);
  } else if (str(first, 1, 6) === 'vorbis') {
    out.codec = 'Vorbis';
    out.channels = first[11];
    out.sampleRate = le32(first, 12);
    out.declaredKbps = Math.round(le32(first, 20) / 1000) || 0;
    out.vbr = true;
    if (packets[1] && str(packets[1], 1, 6) === 'vorbis') parseVorbisComments(packets[1], 7, out);
  } else if (str(first, 0, 5) === '\x7fFLAC') {
    out.codec = 'FLAC'; out.lossless = true;
    if (first.length > 13) parseFlac(first, 9, out);
  }
}

function concat(parts) {
  const n = parts.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const b of parts) { o.set(b, p); p += b.length; }
  return o;
}

/* --------------------------------------------------------------------- WAV */

function parseWav(u8, out) {
  out.container = 'WAV';
  let p = 12, dataLen = 0;
  while (p + 8 <= u8.length) {
    const id = str(u8, p, 4);
    const len = le32(u8, p + 4);
    const body = u8.subarray(p + 8, p + 8 + len);
    if (id === 'fmt ') {
      const fmt = le16(body, 0);
      out.channels = le16(body, 2);
      out.sampleRate = le32(body, 4);
      out.bits = le16(body, 14);
      out.codec = fmt === 1 ? `PCM ${out.bits}-bit` : fmt === 3 ? 'PCM float' : `WAV fmt ${fmt}`;
      out.lossless = fmt === 1 || fmt === 3 || fmt === 0xfffe;
    } else if (id === 'data') {
      dataLen = len;
    } else if (id === 'LIST' && str(body, 0, 4) === 'INFO') {
      let q = 4;
      while (q + 8 <= body.length) {
        const k = str(body, q, 4), l = le32(body, q + 4);
        const v = dec.latin1.decode(body.subarray(q + 8, q + 8 + l)).replace(/\0+$/, '').trim();
        if (k === 'INAM') out.title ||= v;
        if (k === 'IART') out.artist ||= v;
        if (k === 'IPRD') out.album ||= v;
        if (k === 'ICRD') out.year ||= (v.match(/\d{4}/)?.[0] ?? '');
        if (k === 'IGNR') out.genre ||= v;
        q += 8 + l + (l & 1);
      }
    }
    p += 8 + len + (len & 1);
  }
  if (dataLen && out.channels && out.bits) out.totalSamples = dataLen / (out.channels * (out.bits / 8));
}

/* -------------------------------------------------------------------- AIFF */

function parseAiff(u8, out) {
  out.container = 'AIFF'; out.codec = 'PCM'; out.lossless = true;
  let p = 12;
  while (p + 8 <= u8.length) {
    const id = str(u8, p, 4), len = be32(u8, p + 4);
    const body = u8.subarray(p + 8, p + 8 + len);
    if (id === 'COMM' && len >= 18) {
      out.channels = be16(body, 0);
      out.totalSamples = be32(body, 2);
      out.bits = be16(body, 6);
      out.sampleRate = extended80(body, 8);
      out.codec = `PCM ${out.bits}-bit`;
    } else if (id === 'NAME') out.title ||= dec.latin1.decode(body).trim();
    else if (id === 'AUTH') out.artist ||= dec.latin1.decode(body).trim();
    p += 8 + len + (len & 1);
  }
}

function extended80(b, o) {
  const expon = ((b[o] & 0x7f) << 8) | b[o + 1];
  let hi = be32(b, o + 2), lo = be32(b, o + 6);
  const v = (hi * 2 ** 32 + lo) * 2 ** (expon - 16383 - 63);
  return Math.round(b[o] & 0x80 ? -v : v);
}

/* --------------------------------------------------------------------- MP4 */

const MP4_CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia', 'minf', 'stbl']);

function parseMp4(u8, out) {
  out.container = 'MP4';
  walkMp4(u8, 0, u8.length, out);
  if (!out.codec) out.codec = 'AAC';
}

function walkMp4(u8, start, end, out, depth = 0) {
  let p = start;
  while (p + 8 <= end && depth < 8) {
    let size = be32(u8, p);
    const type = str(u8, p + 4, 4);
    let head = 8;
    if (size === 1) { // 64-bit size
      size = be32(u8, p + 8) * 2 ** 32 + be32(u8, p + 12);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head || p + size > end) break;

    if (MP4_CONTAINERS.has(type)) {
      // 'meta' carries a 4-byte version/flags before its children
      walkMp4(u8, p + head + (type === 'meta' ? 4 : 0), p + size, out, depth + 1);
    } else if (type === 'stsd') {
      const fourcc = str(u8, p + head + 12, 4);
      out.codec = { mp4a: 'AAC', alac: 'ALAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC' }[fourcc] || fourcc;
      out.lossless = fourcc === 'alac' || fourcc === 'fLaC';
      out.channels ||= be16(u8, p + head + 32);
      out.bits ||= be16(u8, p + head + 34);
      out.sampleRate ||= be16(u8, p + head + 40); // 16.16 fixed → integer part
    } else if (type === 'mdhd') {
      const ver = u8[p + head];
      const o = p + head + (ver === 1 ? 20 : 12);
      out.sampleRate = be32(u8, o) || out.sampleRate;
      const dur = ver === 1 ? be32(u8, o + 4) * 2 ** 32 + be32(u8, o + 8) : be32(u8, o + 4);
      out.totalSamples ||= dur;
    } else if (depth >= 1 && type.length === 4 && /[©a-zA-Z]/.test(type[0])) {
      mp4Item(type, u8, p + head, p + size, out);
    }
    p += size;
  }
}

function mp4Item(type, u8, start, end, out) {
  if (str(u8, start + 4, 4) !== 'data') return;
  const flags = be32(u8, start + 8) & 0xffffff;
  const body = u8.subarray(start + 16, end);
  const text = () => dec.utf8.decode(body).trim();
  switch (type) {
    case '\xa9nam': out.title ||= text(); break;
    case '\xa9ART': out.artist ||= text(); break;
    case 'aART': out.albumArtist ||= text(); break;
    case '\xa9alb': out.album ||= text(); break;
    case '\xa9gen': case 'gnre': out.genre ||= flags === 1 ? text() : out.genre; break;
    case '\xa9day': out.year ||= (text().match(/\d{4}/)?.[0] ?? ''); break;
    case 'trkn': out.trackNo ||= be16(body, 2); break;
    case 'disk': out.discNo ||= be16(body, 2); break;
    case 'covr':
      if (!out.picture && body.length) {
        out.picture = { bytes: body, mime: flags === 14 ? 'image/png' : 'image/jpeg' };
      }
      break;
  }
}
