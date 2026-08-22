/** Decoding + the bridge to the analysis worker.
 *
 *  Everything is decoded at a fixed 48 kHz so measurements are identical on every
 *  device (an AudioContext would otherwise resample to whatever the hardware runs at).
 *  The file's native sample rate comes from the container metadata instead. */

export const ANALYSIS_RATE = 48000;

let ctx = null;
function decodeCtx() {
  if (!ctx) ctx = new OfflineAudioContext(2, 1, ANALYSIS_RATE);
  return ctx;
}

/** @returns {Promise<AudioBuffer>} */
export async function decodeBlob(blob) {
  const buf = await blob.arrayBuffer();
  try {
    return await decodeCtx().decodeAudioData(buf);
  } catch (err) {
    throw new Error(`This browser cannot decode that file (${err?.message || 'unsupported format'})`);
  }
}

/** Copies of the channel data, detachable for transfer to the worker. */
export function channelsOf(audioBuffer) {
  const out = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    out.push(new Float32Array(audioBuffer.getChannelData(c)));
  }
  return out;
}

/* ------------------------------- worker pool ------------------------------ */

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../dsp/analyzer-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    if (e.data.type === 'progress') job.onProgress?.(e.data.p);
    else if (e.data.type === 'done') { pending.delete(e.data.id); job.resolve(e.data); }
    else if (e.data.type === 'error') { pending.delete(e.data.id); job.reject(new Error(e.data.message)); }
  };
  worker.onerror = (e) => {
    for (const [, job] of pending) job.reject(new Error(e.message || 'Analyzer worker crashed'));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/** Run loudness + quality analysis on already-decoded channels. */
export function analyzeChannels(channels, sampleRate, info, onProgress) {
  const id = ++seq;
  const buffers = channels.map((c) => c.buffer);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, channels: buffers, sampleRate, info }, buffers);
  });
}

/** Decode a stored file and analyze it. */
export async function analyzeBlob(blob, info = {}, onProgress) {
  let audio = await decodeBlob(blob);
  onProgress?.(0.15);
  // Keep the scalars, then drop the AudioBuffer: the channel copies are about to be
  // transferred to the worker and a long track is hundreds of megabytes either way.
  const duration = audio.duration;
  const decodedRate = audio.sampleRate;
  const decodedChannels = audio.numberOfChannels;
  const channels = channelsOf(audio);
  audio = null;

  const res = await analyzeChannels(channels, decodedRate, {
    ...info,
    bytes: blob.size,
    duration,
    channels: decodedChannels,
  }, (p) => onProgress?.(0.15 + p * 0.85));
  return { ...res, duration, decodedRate, decodedChannels };
}
