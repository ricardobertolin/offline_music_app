/** Objective audio-quality analysis: effective bandwidth, clipping, dynamics.
 *  The interesting one is the spectral cutoff — a lossy encoder brick-walls the
 *  spectrum, so a "lossless" file that stops dead at 16 kHz was transcoded from MP3. */

const FFT_SIZE = 4096;
const MAX_WINDOWS = 96;

/* ---- iterative radix-2 FFT (in-place, complex interleaved re/im arrays) ---- */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const HANN = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  return w;
})();

/** Average power spectrum over windows spread across the loudest parts of the track. */
function averageSpectrum(channels, sampleRate) {
  const len = channels[0].length;
  if (len < FFT_SIZE * 2) return null;
  const bins = FFT_SIZE / 2;
  const acc = new Float64Array(bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  // Candidate window starts, skipping the first/last 3 % (fade-ins, silence).
  const from = Math.floor(len * 0.03), to = Math.max(from + FFT_SIZE, Math.floor(len * 0.97) - FFT_SIZE);
  const count = Math.min(MAX_WINDOWS, Math.max(4, Math.floor((to - from) / FFT_SIZE)));
  const step = Math.max(FFT_SIZE, Math.floor((to - from) / count));

  let used = 0;
  for (let w = 0; w < count; w++) {
    const start = from + w * step;
    if (start + FFT_SIZE > len) break;
    // downmix to mono, window
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][start + i];
      v /= channels.length;
      rms += v * v;
      re[i] = v * HANN[i];
      im[i] = 0;
    }
    if (Math.sqrt(rms / FFT_SIZE) < 0.001) continue; // near-silence tells us nothing
    fft(re, im);
    for (let b = 0; b < bins; b++) acc[b] += re[b] * re[b] + im[b] * im[b];
    used++;
  }
  if (!used) return null;
  for (let b = 0; b < bins; b++) acc[b] /= used;
  return { power: acc, binHz: sampleRate / FFT_SIZE, used };
}

/** Highest frequency that still carries real signal, plus how abrupt the roll-off is. */
function findCutoff(spec) {
  const { power, binHz } = spec;
  const n = power.length;
  const db = new Float64Array(n);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    db[i] = power[i] > 0 ? 10 * Math.log10(power[i]) : -200;
    if (db[i] > peak) peak = db[i];
  }
  for (let i = 0; i < n; i++) db[i] -= peak;

  // smooth (moving average, ±4 bins)
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) { s += db[k]; c++; }
    sm[i] = s / c;
  }

  // noise floor from the quietest 10 % of bins
  const sorted = Float64Array.from(sm).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const threshold = Math.max(floor + 8, -85);

  let cutoffBin = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (sm[i] >= threshold) { cutoffBin = i; break; }
  }
  const cutoffHz = cutoffBin * binHz;

  // Steepness across ±1 kHz of the cutoff: codecs cut, real instruments fade.
  const kb = Math.max(1, Math.round(1000 / binHz));
  const below = sm[Math.max(0, cutoffBin - kb)];
  const above = sm[Math.min(n - 1, cutoffBin + kb)];
  return { cutoffHz, rolloffDb: below - above, floorDb: floor };
}

/** Clipping detection: runs of samples pinned at (or over) full scale. */
function clippingStats(channels) {
  let clipped = 0, total = 0;
  for (const x of channels) {
    let run = 0;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) >= 0.9921) { run++; } // ≈ -0.07 dBFS, catches 16-bit ceilings
      else { if (run >= 3) clipped += run; run = 0; }
    }
    if (run >= 3) clipped += run;
    total += x.length;
  }
  return { clipPct: total ? (clipped / total) * 100 : 0, clippedSamples: clipped };
}

function crestFactor(channels) {
  let peak = 0, sumSq = 0, n = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
      sumSq += x[i] * x[i];
    }
    n += x.length;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (!peak || !rms) return { crestDb: 0, rmsDb: -120 };
  return {
    crestDb: Math.round((20 * Math.log10(peak / rms)) * 10) / 10,
    rmsDb: Math.round(20 * Math.log10(rms) * 10) / 10,
  };
}

/* --------------------------------- scoring -------------------------------- */

// Effective bandwidth → score. Roughly: 16 kHz ≈ 128 kbps MP3, 19 kHz ≈ 256 kbps.
const BW_TABLE = [
  [8000, 15], [11000, 30], [13000, 45], [15000, 60], [16000, 70],
  [17500, 80], [19000, 88], [20000, 94], [21000, 98], [22000, 100],
];

function bandwidthScore(hz) {
  if (hz <= BW_TABLE[0][0]) return BW_TABLE[0][1];
  for (let i = 1; i < BW_TABLE.length; i++) {
    const [x1, y1] = BW_TABLE[i - 1], [x2, y2] = BW_TABLE[i];
    if (hz <= x2) return y1 + (hz - x1) / (x2 - x1) * (y2 - y1);
  }
  return 100;
}

function tierOf(score, lossless, cutoffHz) {
  if (lossless && cutoffHz >= 19500 && score >= 90) return 'lossless';
  if (score >= 82) return 'high';
  if (score >= 66) return 'standard';
  if (score >= 45) return 'low';
  return 'poor';
}

/**
 * @param {Float32Array[]} channels decoded PCM
 * @param {number} sampleRate rate of the decoded PCM (may differ from the file's)
 * @param {object} info { lossless, codec, nativeSampleRate, bytes, duration, channels }
 */
export function measureQuality(channels, sampleRate, info = {}) {
  const spec = averageSpectrum(channels, sampleRate);
  const cut = spec ? findCutoff(spec) : { cutoffHz: 0, rolloffDb: 0, floorDb: -100 };
  const clip = clippingStats(channels);
  const crest = crestFactor(channels);

  const nyquist = Math.min(sampleRate, info.nativeSampleRate || sampleRate) / 2;
  // Never claim more bandwidth than the source could hold.
  const cutoffHz = Math.min(cut.cutoffHz || 0, nyquist);
  const bitrateKbps = info.bytes && info.duration ? Math.round((info.bytes * 8) / info.duration / 1000) : 0;

  let score = bandwidthScore(cutoffHz);
  const flags = [];

  const brickwalled = cut.rolloffDb >= 20 && cutoffHz > 2000 && cutoffHz < nyquist - 1000;
  if (info.lossless) {
    if (brickwalled && cutoffHz < 19500) {
      flags.push(`Lossless container but the spectrum stops at ${(cutoffHz / 1000).toFixed(1)} kHz — transcoded from a lossy source`);
      score = Math.min(score, 78);
    } else {
      score = Math.max(score, 96);
    }
  } else if (brickwalled) {
    flags.push(`Encoder cut-off at ${(cutoffHz / 1000).toFixed(1)} kHz`);
  }

  const rate = info.nativeSampleRate || sampleRate;
  if (rate < 32000) { score -= 15; flags.push(`Low sample rate (${(rate / 1000).toFixed(1)} kHz)`); }
  else if (rate < 44100) { score -= 6; flags.push(`Sample rate below CD (${(rate / 1000).toFixed(1)} kHz)`); }

  if ((info.channels || channels.length) === 1) flags.push('Mono');

  if (clip.clipPct > 1) { score -= 18; flags.push(`Heavy clipping (${clip.clipPct.toFixed(2)} % of samples)`); }
  else if (clip.clipPct > 0.05) { score -= 8; flags.push(`Clipping detected (${clip.clipPct.toFixed(2)} % of samples)`); }

  if (crest.crestDb && crest.crestDb < 7) { score -= 6; flags.push(`Very compressed dynamics (crest ${crest.crestDb} dB)`); }

  if (bitrateKbps && !info.lossless && bitrateKbps < 96) { score -= 6; flags.push(`Low bitrate (${bitrateKbps} kbps)`); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    cutoffHz: Math.round(cutoffHz),
    rolloffDb: Math.round(cut.rolloffDb * 10) / 10,
    brickwalled,
    clipPct: Math.round(clip.clipPct * 1000) / 1000,
    clippedSamples: clip.clippedSamples,
    crestDb: crest.crestDb,
    rmsDb: crest.rmsDb,
    bitrateKbps,
    score,
    tier: tierOf(score, !!info.lossless, cutoffHz),
    flags,
    windows: spec?.used || 0,
  };
}
