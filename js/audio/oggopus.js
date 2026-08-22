/** Opus encoding via WebCodecs + a small Ogg muxer (RFC 7845).
 *  WebCodecs hands back raw Opus packets; browsers won't wrap them for us, so we
 *  page them into an Ogg stream ourselves. Falls back to WAV upstream when the
 *  browser has no AudioEncoder. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = (((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ buf[i]]) >>> 0;
  return crc >>> 0;
}

export class OggMuxer {
  constructor(serial = (Math.random() * 0xfffffffe) >>> 0) {
    this.serial = serial;
    this.seq = 0;
    this.pages = [];
    this.segments = [];   // lacing values for the current page
    this.payload = [];    // Uint8Array pieces for the current page
    this.granule = 0n;
    this.bytes = 0;
  }

  /** Queue one packet; pages are emitted when full. */
  packet(data, granulePos, { flush = false, bos = false, eos = false } = {}) {
    const lacing = [];
    let n = data.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
    // A packet larger than one page would need continuation pages. Opus packets
    // never get close to this, so refuse rather than emit a malformed stream.
    if (lacing.length > 255) throw new Error(`Packet too large to page (${data.length} bytes)`);
    if (this.segments.length + lacing.length > 255) this.flushPage(false, false);
    this.segments.push(...lacing);
    this.payload.push(data);
    this.granule = BigInt(granulePos);
    if (flush || bos || eos || this.segments.length >= 255) this.flushPage(bos, eos);
  }

  flushPage(bos = false, eos = false) {
    if (!this.segments.length) return;
    const nseg = this.segments.length;
    const body = concat(this.payload);
    const page = new Uint8Array(27 + nseg + body.length);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0);            // "OggS"
    page[4] = 0;                                       // stream structure version
    page[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);     // header type
    dv.setBigUint64(6, this.granule, true);
    dv.setUint32(14, this.serial, true);
    dv.setUint32(18, this.seq++, true);
    dv.setUint32(22, 0, true);                         // CRC placeholder
    page[26] = nseg;
    page.set(this.segments, 27);
    page.set(body, 27 + nseg);
    dv.setUint32(22, crc32(page), true);
    this.pages.push(page);
    this.bytes += page.length;
    this.segments = [];
    this.payload = [];
  }

  finish() {
    this.flushPage(false, true);
    return this.pages;
  }
}

function concat(parts) {
  const n = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

export function opusHead(channels, preSkip) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  b[8] = 1;                       // version
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, 48000, true);  // original input rate
  dv.setInt16(16, 0, true);       // output gain
  b[18] = 0;                      // channel mapping family 0 (mono/stereo)
  return b;
}

export function opusTags(vendor = 'offline-music') {
  const v = new TextEncoder().encode(vendor);
  const b = new Uint8Array(8 + 4 + v.length + 4);
  const dv = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  dv.setUint32(8, v.length, true);
  b.set(v, 12);
  dv.setUint32(12 + v.length, 0, true); // zero user comments
  return b;
}

export function opusAvailable() {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

export async function opusSupported(numberOfChannels = 2, bitrate = 128000) {
  if (!opusAvailable()) return false;
  try {
    const { supported } = await AudioEncoder.isConfigSupported(
      { codec: 'opus', sampleRate: 48000, numberOfChannels, bitrate },
    );
    return !!supported;
  } catch { return false; }
}

/**
 * Encode 48 kHz float PCM to an Ogg Opus blob.
 * @param {Float32Array[]} channels
 * @param {{bitrate?:number, onProgress?:(p:number)=>void, signal?:AbortSignal}} opts
 */
export async function encodeOpus(channels, sampleRate, opts = {}) {
  if (!opusAvailable()) throw new Error('WebCodecs Opus encoder unavailable');
  if (sampleRate !== 48000) throw new Error('Opus encoding expects 48 kHz input');

  const { bitrate = 128000, onProgress, signal } = opts;
  const nCh = channels.length;
  const frames = channels[0].length;
  const config = {
    codec: 'opus', sampleRate: 48000, numberOfChannels: nCh, bitrate,
    opus: { frameDuration: 20000, application: 'audio' },
  };
  const { supported } = await AudioEncoder.isConfigSupported(config);
  if (!supported) throw new Error('Opus configuration not supported');

  const packets = [];
  let description = null;
  let failure = null;

  const encoder = new AudioEncoder({
    output(chunk, meta) {
      const d = meta?.decoderConfig?.description;
      if (d && !description) {
        const u = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        if (u.length >= 19 && String.fromCharCode(...u.subarray(0, 8)) === 'OpusHead') description = u.slice();
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
    },
    error(e) { failure = e; },
  });
  encoder.configure(config);

  const CHUNK = 48000; // 1 s per AudioData
  for (let off = 0; off < frames; off += CHUNK) {
    if (failure) break;
    signal?.throwIfAborted?.();
    const count = Math.min(CHUNK, frames - off);
    const planar = new Float32Array(count * nCh);
    for (let c = 0; c < nCh; c++) planar.set(channels[c].subarray(off, off + count), c * count);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: count,
      numberOfChannels: nCh,
      timestamp: Math.round((off / 48000) * 1e6),
      data: planar,
    });
    encoder.encode(data);
    data.close();
    onProgress?.((off + count) / frames * 0.9);
    if (encoder.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 0));
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!packets.length) throw new Error('Opus encoder produced no data');

  const preSkip = description ? (description[10] | (description[11] << 8)) : 312;
  const head = description || opusHead(nCh, preSkip);

  const mux = new OggMuxer();
  mux.packet(head, 0, { bos: true, flush: true });
  mux.packet(opusTags(), 0, { flush: true });

  const perPacket = 960; // 20 ms at 48 kHz
  const finalGranule = frames + preSkip;
  let granule = 0;
  for (let i = 0; i < packets.length; i++) {
    granule += perPacket;
    const last = i === packets.length - 1;
    mux.packet(packets[i], last ? Math.min(granule, finalGranule) : granule, { eos: last });
    if (i % 50 === 0) onProgress?.(0.9 + (i / packets.length) * 0.1);
  }
  const pages = mux.finish();
  onProgress?.(1);
  return new Blob(pages, { type: 'audio/ogg' });
}
