/** Quality normalization: bring a file to one common encoding target.
 *  Decode → resample → channel-map → optional loudness bake-in → encode. */

import { encodeWav } from './wav.js';
import { encodeOpus, opusSupported } from './oggopus.js';
import { dbToGain } from '../util.js';

/** Decode straight to the target rate so we only ever resample once. */
async function decodeAt(blob, rate) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, rate);
  return ctx.decodeAudioData(buf);
}

/** Re-render through Web Audio to change channel count and/or apply gain. */
async function render(audio, channels, rate, gain) {
  const ctx = new OfflineAudioContext(channels, Math.max(1, audio.length), rate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function channelsOf(audio) {
  const out = [];
  for (let c = 0; c < audio.numberOfChannels; c++) out.push(audio.getChannelData(c));
  return out;
}

/** True peak of the rendered PCM, so a baked-in gain never clips the file. */
function peakOf(chs) {
  let p = 0;
  for (const x of chs) for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

/**
 * @param {Blob} blob source audio
 * @param {object} opts
 * @param {number} opts.rate         target sample rate (0 = keep source)
 * @param {number} opts.channels     target channel count (0 = keep source)
 * @param {'opus'|'wav'} opts.codec
 * @param {number} opts.bitrate      kbps, Opus only
 * @param {number} opts.gainDb       loudness gain to bake in (0 = none)
 * @param {number} opts.sourceRate   native rate of the source, used when rate = 0
 */
export async function transcode(blob, opts = {}) {
  const { codec = 'opus', bitrate = 128, gainDb = 0, onProgress, signal } = opts;
  const useOpus = codec === 'opus' && await opusSupported(opts.channels || 2, bitrate * 1000);
  // Opus always runs at 48 kHz internally; asking for anything else just adds a resample.
  const rate = useOpus ? 48000 : (opts.rate || opts.sourceRate || 48000);

  onProgress?.(0.05);
  let audio = await decodeAt(blob, rate);
  const targetCh = opts.channels || audio.numberOfChannels;
  onProgress?.(0.25);

  let gain = gainDb ? dbToGain(gainDb) : 1;
  if (targetCh !== audio.numberOfChannels || gain !== 1) {
    audio = await render(audio, targetCh, rate, gain);
  }
  let chs = channelsOf(audio);

  // Bake-in must not clip: pull the gain back if it would.
  const peak = peakOf(chs);
  if (peak > 0.9885) { // -0.1 dBFS
    const fix = 0.9885 / peak;
    for (const x of chs) for (let i = 0; i < x.length; i++) x[i] *= fix;
  }
  onProgress?.(0.4);

  let out, format;
  if (useOpus) {
    try {
      out = await encodeOpus(chs, rate, {
        bitrate: bitrate * 1000, signal,
        onProgress: (p) => onProgress?.(0.4 + p * 0.5),
      });
      format = { codec: 'Opus', container: 'Ogg', mime: 'audio/ogg', ext: 'opus', lossless: false, bitrate };
      await verify(out); // a muxing bug must never cost the user their track
    } catch (err) {
      out = null;
      if (signal?.aborted) throw err;
      console.warn('Opus encode failed, falling back to WAV:', err);
    }
  }
  if (!out) {
    out = encodeWav(chs, rate, 16);
    format = { codec: 'PCM 16-bit', container: 'WAV', mime: 'audio/wav', ext: 'wav', lossless: true, bitrate: Math.round(rate * targetCh * 16 / 1000) };
    onProgress?.(0.9);
  }

  onProgress?.(1);
  return {
    blob: out,
    format,
    sampleRate: rate,
    channels: targetCh,
    duration: audio.duration,
    peakAfter: peak,
  };
}

/** Decode the result once: proves the file we are about to store is playable. */
async function verify(blob) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const decoded = await ctx.decodeAudioData(await blob.slice(0).arrayBuffer());
  if (!decoded || decoded.length < 1) throw new Error('Encoded file did not decode');
  return true;
}

/** Does this track already match the target profile? */
export function matchesTarget(track, settings) {
  const wantCodec = settings.codec === 'opus' ? 'Opus' : 'PCM 16-bit';
  const rateOk = !settings.rate || track.sampleRate === (settings.codec === 'opus' ? 48000 : settings.rate);
  const chOk = !settings.channels || track.channels === settings.channels;
  return track.codec === wantCodec && rateOk && chOk;
}
