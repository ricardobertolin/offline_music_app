/** Runs the heavy DSP off the main thread.
 *  Decoding stays on the main thread (it is native and off-thread anyway); the
 *  PCM buffers are transferred here, so nothing is copied. */

import { measureLoudness } from './loudness.js';
import { measureQuality } from './quality.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate, info } = e.data;
  try {
    const chans = channels.map((b) => new Float32Array(b));
    const loudness = measureLoudness(chans, sampleRate, (p) => {
      self.postMessage({ id, type: 'progress', p: p * 0.7 });
    });
    self.postMessage({ id, type: 'progress', p: 0.75 });
    const quality = measureQuality(chans, sampleRate, info || {});
    self.postMessage({ id, type: 'progress', p: 1 });
    self.postMessage({ id, type: 'done', loudness, quality }, [loudness.hist.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
