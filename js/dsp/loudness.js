/** ITU-R BS.1770-4 / EBU R128 loudness measurement.
 *  Pure math on Float32Array channels — no DOM, safe to run inside a worker.
 *
 *  Produces integrated loudness (LUFS), loudness range (LRA), momentary/short-term
 *  peaks and a 0.1 LU histogram of the gated blocks. The histogram is what makes
 *  correct *album* loudness possible later: album gain is not an average of track
 *  values, it is the gated mean over the blocks of every track in the album.
 */

export const HIST_MIN = -70;   // LUFS, absolute gate
export const HIST_STEP = 0.1;  // LU per bin
export const HIST_BINS = 900;  // -70 … +20 LUFS

/** Channel weights G_i from BS.1770 (surround channels get +1.5 dB, LFE is ignored). */
function channelWeights(n) {
  switch (n) {
    case 1: return [1];
    case 2: return [1, 1];
    case 3: return [1, 1, 1];
    case 4: return [1, 1, 1.41, 1.41];               // L R Ls Rs
    case 5: return [1, 1, 1, 1.41, 1.41];            // L R C Ls Rs
    case 6: return [1, 1, 1, 0, 1.41, 1.41];         // L R C LFE Ls Rs
    default: return new Array(n).fill(1);
  }
}

/** The two K-weighting stages, designed for an arbitrary sample rate. */
export function kWeightCoeffs(fs) {
  // Stage 1: high-shelf (+4 dB above ~1.5 kHz)
  const f0 = 1681.9744509555319, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const d = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + Vb * K / Q + K * K) / d,
    b1: 2 * (K * K - Vh) / d,
    b2: (Vh - Vb * K / Q + K * K) / d,
    a1: 2 * (K * K - 1) / d,
    a2: (1 - K / Q + K * K) / d,
  };
  // Stage 2: RLB high-pass
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  const K2 = Math.tan(Math.PI * f2 / fs);
  const d2 = 1 + K2 / Q2 + K2 * K2;
  const s2 = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (K2 * K2 - 1) / d2,
    a2: (1 - K2 / Q2 + K2 * K2) / d2,
  };
  return [s1, s2];
}

/** Direct-form I biquad, out-of-place (input is left untouched). */
function biquad(x, c, out) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

const energyToLufs = (e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
const lufsToEnergy = (l) => Math.pow(10, (l + 0.691) / 10);

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {(p:number)=>void} [onProgress]
 */
export function measureLoudness(channels, sampleRate, onProgress) {
  const nCh = channels.length;
  const len = channels[0]?.length || 0;
  const weights = channelWeights(nCh);
  const hop = Math.round(sampleRate * 0.1);          // 100 ms
  const blockHops = 4;                               // 400 ms block, 75 % overlap
  const nHops = Math.floor(len / hop);
  const coeffs = kWeightCoeffs(sampleRate);

  // Per-hop mean square of the K-weighted signal, summed with channel weights.
  const hopSum = new Float64Array(Math.max(nHops, 0));
  const scratch = new Float32Array(len);
  const scratch2 = new Float32Array(len);

  for (let c = 0; c < nCh; c++) {
    if (weights[c] === 0) continue;
    biquad(channels[c], coeffs[0], scratch);
    biquad(scratch, coeffs[1], scratch2);
    const w = weights[c];
    for (let h = 0; h < nHops; h++) {
      let s = 0;
      const start = h * hop, end = start + hop;
      for (let i = start; i < end; i++) { const v = scratch2[i]; s += v * v; }
      hopSum[h] += w * s;
    }
    onProgress?.((c + 1) / nCh * 0.6);
  }

  // 400 ms block energies (mean square over the block).
  const nBlocks = Math.max(0, nHops - blockHops + 1);
  const blockE = new Float64Array(nBlocks);
  const blockLen = hop * blockHops;
  let running = 0;
  for (let h = 0; h < nHops; h++) {
    running += hopSum[h];
    if (h >= blockHops) running -= hopSum[h - blockHops];
    if (h >= blockHops - 1) blockE[h - blockHops + 1] = running / blockLen;
  }

  // Histogram of block loudness (used for album gating later).
  const hist = new Int32Array(HIST_BINS);
  let momentaryMax = -Infinity;
  for (let i = 0; i < nBlocks; i++) {
    const l = energyToLufs(blockE[i]);
    if (l > momentaryMax) momentaryMax = l;
    if (l >= HIST_MIN) {
      const bin = Math.min(HIST_BINS - 1, Math.floor((l - HIST_MIN) / HIST_STEP));
      hist[bin]++;
    }
  }
  onProgress?.(0.75);

  const integrated = integratedFromHistogram(hist);

  // Short-term (3 s / 1 s hop) for LRA.
  const stHops = 30, stStep = 10;
  const shortTerm = [];
  let stMax = -Infinity;
  if (nHops >= stHops) {
    let sum = 0;
    for (let h = 0; h < stHops; h++) sum += hopSum[h];
    for (let start = 0; start + stHops <= nHops; start += stStep) {
      if (start > 0) for (let k = start - stStep; k < start; k++) sum += hopSum[k + stHops] - hopSum[k];
      const l = energyToLufs(sum / (hop * stHops));
      if (l > stMax) stMax = l;
      if (l >= HIST_MIN) shortTerm.push(l);
    }
  }
  const lra = loudnessRange(shortTerm);

  const peaks = peakMeasure(channels, weights);
  onProgress?.(1);

  return {
    integratedLufs: isFinite(integrated) ? round1(integrated) : null,
    lra: lra === null ? null : round1(lra),
    momentaryMaxLufs: isFinite(momentaryMax) ? round1(momentaryMax) : null,
    shortTermMaxLufs: isFinite(stMax) ? round1(stMax) : null,
    samplePeakDb: peaks.samplePeakDb,
    truePeakDb: peaks.truePeakDb,
    hist,
    blocks: nBlocks,
    duration: len / sampleRate,
    sampleRate,
    channels: nCh,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** Two-pass gating (absolute -70 LUFS, then relative -10 LU) over a block histogram. */
export function integratedFromHistogram(hist) {
  const mean = (fromBin) => {
    let sum = 0, n = 0;
    for (let i = fromBin; i < hist.length; i++) {
      const c = hist[i];
      if (!c) continue;
      sum += c * lufsToEnergy(HIST_MIN + (i + 0.5) * HIST_STEP);
      n += c;
    }
    return n ? sum / n : 0;
  };
  const absMean = mean(0);
  if (!absMean) return -Infinity;
  const relGate = energyToLufs(absMean) - 10;
  const relBin = Math.ceil((relGate - HIST_MIN) / HIST_STEP);
  const gated = mean(Math.max(0, relBin));
  return gated ? energyToLufs(gated) : -Infinity;
}

/** Sum histograms (e.g. every track of an album) — album loudness, done properly. */
export function mergeHistograms(hists) {
  const out = new Int32Array(HIST_BINS);
  for (const h of hists) {
    if (!h) continue;
    const a = h instanceof Int32Array ? h : new Int32Array(h);
    for (let i = 0; i < HIST_BINS && i < a.length; i++) out[i] += a[i];
  }
  return out;
}

/** EBU Tech 3342 loudness range: 10th–95th percentile of short-term loudness,
 *  after gating 20 LU below the mean of the ungated-above-(-70) values. */
function loudnessRange(st) {
  if (st.length < 3) return null;
  const meanE = st.reduce((a, l) => a + lufsToEnergy(l), 0) / st.length;
  const gate = energyToLufs(meanE) - 20;
  const kept = st.filter((l) => l >= gate).sort((a, b) => a - b);
  if (kept.length < 2) return null;
  const at = (p) => kept[Math.min(kept.length - 1, Math.max(0, Math.round(p * (kept.length - 1))))];
  return at(0.95) - at(0.10);
}

/* ------------------------------------------------------- true peak (4× FIR) */

const TAPS = 12; // per side
const PHASES = (() => {
  const phases = [];
  for (let p = 1; p < 4; p++) {
    const off = p / 4;
    const h = new Float64Array(TAPS * 2);
    let sum = 0;
    for (let k = -TAPS + 1; k <= TAPS; k++) {
      const t = k - off;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 * (1 + Math.cos(Math.PI * t / TAPS)); // Hann over ±TAPS
      const v = Math.abs(t) < TAPS ? sinc * w : 0;
      h[k + TAPS - 1] = v;
      sum += v;
    }
    for (let i = 0; i < h.length; i++) h[i] /= sum; // unity DC gain
    phases.push(h);
  }
  return phases;
})();

/** Sample peak plus 4× oversampled true peak, evaluated only around loud samples. */
function peakMeasure(channels, weights) {
  let samplePeak = 0, truePeak = 0;
  for (let c = 0; c < channels.length; c++) {
    if (weights[c] === 0) continue;
    const x = channels[c];
    let p = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
    if (p > samplePeak) samplePeak = p;
    if (p === 0) continue;
    const trigger = p * 0.7; // only interpolate near the loud parts
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) < trigger) continue;
      for (const h of PHASES) {
        let y = 0;
        for (let k = 0; k < h.length; k++) {
          const idx = i - TAPS + 1 + k;
          if (idx >= 0 && idx < x.length) y += x[idx] * h[k];
        }
        const a = Math.abs(y);
        if (a > truePeak) truePeak = a;
      }
    }
  }
  truePeak = Math.max(truePeak, samplePeak);
  const toDb = (v) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);
  return {
    samplePeakDb: isFinite(toDb(samplePeak)) ? toDb(samplePeak) : -120,
    truePeakDb: isFinite(toDb(truePeak)) ? toDb(truePeak) : -120,
  };
}

/**
 * Gain to reach a target loudness without exceeding a true-peak ceiling.
 * @returns {{gainDb:number, wanted:number, limitedBy:'peak'|null}}
 */
export function normalizationGain({ integratedLufs, truePeakDb }, { targetLufs, ceilingDbtp, peakSafe }) {
  if (integratedLufs === null || integratedLufs === undefined || !isFinite(integratedLufs)) {
    return { gainDb: 0, wanted: 0, limitedBy: null };
  }
  const wanted = targetLufs - integratedLufs;
  let gainDb = wanted;
  let limitedBy = null;
  if (peakSafe && isFinite(truePeakDb)) {
    const headroom = ceilingDbtp - truePeakDb;
    if (gainDb > headroom) { gainDb = headroom; limitedBy = 'peak'; }
  }
  return { gainDb: Math.round(gainDb * 10) / 10, wanted: Math.round(wanted * 10) / 10, limitedBy };
}
