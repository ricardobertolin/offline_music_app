/** Loudness + quality DSP checks, verified against the BS.1770-4 reference values.
 *  Run with:  node tests/dsp.test.mjs  */
import {
  kWeightCoeffs, measureLoudness, integratedFromHistogram, mergeHistograms, normalizationGain,
} from '../js/dsp/loudness.js';
import { measureQuality } from '../js/dsp/quality.js';

let fails = 0;
const near = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${typeof got === 'number' ? got.toFixed(4) : got}, want ${want} ±${tol}`);
};
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${info}`);
};

/* 1 — K-weighting coefficients must match the published BS.1770-4 table at 48 kHz */
const [s1, s2] = kWeightCoeffs(48000);
near('shelf b0', s1.b0, 1.53512485958697, 1e-10);
near('shelf b1', s1.b1, -2.69169618940638, 1e-10);
near('shelf b2', s1.b2, 1.19839281085285, 1e-10);
near('shelf a1', s1.a1, -1.69065929318241, 1e-10);
near('shelf a2', s1.a2, 0.73248077421585, 1e-10);
near('hpf a1', s2.a1, -1.99004745483398, 1e-8);
near('hpf a2', s2.a2, 0.99007225036621, 1e-8);

/* helpers */
const FS = 48000;
function sine(seconds, freq, amp, fs = FS) {
  const n = Math.round(seconds * fs);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / fs);
  return x;
}
const cat = (...arrs) => {
  const out = new Float32Array(arrs.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
};

/* 2 — EBU Tech 3341 calibration: a 1 kHz stereo sine whose peak amplitude is
       −23 dBFS reads −23 LUFS, and a full-scale one reads 0 LUFS. */
const amp = Math.pow(10, -23 / 20); // peak amplitude = −23 dBFS, as in EBU Tech 3341
const l1k = measureLoudness([sine(20, 1000, amp), sine(20, 1000, amp)], FS);
near('1 kHz stereo −23 dBFS → LUFS', l1k.integratedLufs, -23, 0.15);

const lFull = measureLoudness([sine(10, 1000, 1), sine(10, 1000, 1)], FS);
near('full-scale 1 kHz stereo sine → 0 LUFS (BS.1770 calibration)', lFull.integratedLufs, 0, 0.15);

/* 3 — mono of the same signal is 3 dB quieter (one channel of energy) */
const lMono = measureLoudness([sine(20, 1000, amp)], FS);
near('mono is 3.01 LU below stereo', l1k.integratedLufs - lMono.integratedLufs, 3.01, 0.15);

/* 4 — doubling amplitude adds 6.02 LU */
const lLoud = measureLoudness([sine(20, 1000, amp * 2), sine(20, 1000, amp * 2)], FS);
near('+6 dB gain → +6 LU', lLoud.integratedLufs - l1k.integratedLufs, 6.02, 0.1);

/* 5 — absolute gate: trailing silence must not drag the value down */
const withSilence = measureLoudness(
  [cat(sine(20, 1000, amp), new Float32Array(FS * 20)), cat(sine(20, 1000, amp), new Float32Array(FS * 20))], FS);
near('silence is gated out', withSilence.integratedLufs, l1k.integratedLufs, 0.2);

/* 6 — relative gate: material 20 LU quieter must be excluded */
const quiet = amp * Math.pow(10, -20 / 20);
const twoLevel = measureLoudness(
  [cat(sine(20, 1000, amp), sine(20, 1000, quiet)), cat(sine(20, 1000, amp), sine(20, 1000, quiet))], FS);
near('quiet section gated out', twoLevel.integratedLufs, l1k.integratedLufs, 0.3);

/* 7 — LRA: a 10 LU step should read roughly 10 LU of range */
const step = amp * Math.pow(10, -10 / 20);
const lraSig = measureLoudness(
  [cat(sine(30, 1000, amp), sine(30, 1000, step)), cat(sine(30, 1000, amp), sine(30, 1000, step))], FS);
near('LRA of a 10 LU step', lraSig.lra, 10, 1.5);

/* 8 — true peak beats sample peak on an inter-sample peak signal
       (a sine at fs/4 sampled on the zero crossings hides its real peak) */
const n = FS * 2;
const isp = new Float32Array(n);
for (let i = 0; i < n; i++) isp[i] = 0.9 * Math.sin(2 * Math.PI * (FS / 4) * i / FS + Math.PI / 4);
const peaks = measureLoudness([isp, isp], FS);
ok('true peak ≥ sample peak', peaks.truePeakDb >= peaks.samplePeakDb - 0.01,
  `(tp ${peaks.truePeakDb} dB, sp ${peaks.samplePeakDb} dB)`);
near('sample peak misses the real peak', peaks.samplePeakDb, -3.92, 0.1);
near('true peak recovers 0.9 amplitude', peaks.truePeakDb, -0.92, 0.35);

/* 9 — histogram merge reproduces the same integrated value */
near('histogram → integrated', integratedFromHistogram(l1k.hist), l1k.integratedLufs, 0.1);
const merged = mergeHistograms([l1k.hist, lLoud.hist]);
const albumL = integratedFromHistogram(merged);
ok('album loudness sits between the two tracks',
  albumL > l1k.integratedLufs && albumL < lLoud.integratedLufs, `(${albumL.toFixed(2)} LUFS)`);

/* 10 — normalization gain and the peak ceiling */
const g1 = normalizationGain({ integratedLufs: -20, truePeakDb: -6 }, { targetLufs: -14, ceilingDbtp: -1, peakSafe: true });
near('gain to target', g1.gainDb, 5, 0.01);
ok('peak-limited flag', g1.limitedBy === 'peak', `(wanted ${g1.wanted}, applied ${g1.gainDb})`);
const g2 = normalizationGain({ integratedLufs: -20, truePeakDb: -12 }, { targetLufs: -14, ceilingDbtp: -1, peakSafe: true });
near('unrestricted gain', g2.gainDb, 6, 0.01);
ok('no limiting flag', g2.limitedBy === null);

/* 11 — spectral cut-off detection on band-limited noise */
function bandLimitedNoise(seconds, cutHz, fs = FS) {
  const len = Math.round(seconds * fs);
  const x = new Float32Array(len);
  // sum of sines up to cutHz: a spectrum that stops dead, like a lossy codec
  const partials = 400;
  for (let k = 1; k <= partials; k++) {
    const f = (cutHz / partials) * k;
    const ph = Math.random() * Math.PI * 2;
    const a = 0.5 / Math.sqrt(partials);
    for (let i = 0; i < len; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / fs + ph);
  }
  return x;
}
const noise16k = bandLimitedNoise(6, 16000);
const q16 = measureQuality([noise16k, noise16k], FS, { lossless: false, bytes: 6 * 16000, duration: 6, channels: 2, nativeSampleRate: 44100 });
near('16 kHz brick wall detected', q16.cutoffHz / 1000, 16, 0.6);
ok('brick wall flagged', q16.brickwalled === true, `(roll-off ${q16.rolloffDb} dB)`);
ok('score in the lossy band', q16.score > 55 && q16.score < 85, `(score ${q16.score}, tier ${q16.tier})`);

const noise21k = bandLimitedNoise(6, 21000);
const q21 = measureQuality([noise21k, noise21k], FS, { lossless: true, bytes: 6 * 176400, duration: 6, channels: 2, nativeSampleRate: 48000 });
near('21 kHz content detected', q21.cutoffHz / 1000, 21, 0.8);
ok('lossless scores high', q21.score >= 90, `(score ${q21.score}, tier ${q21.tier})`);

/* 12 — clipping detection */
const clipped = new Float32Array(FS * 3);
for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-1, Math.min(1, 1.6 * Math.sin(2 * Math.PI * 200 * i / FS)));
const qc = measureQuality([clipped, clipped], FS, { lossless: true, bytes: 1e6, duration: 3, channels: 2 });
ok('clipping detected', qc.clipPct > 5, `(${qc.clipPct} % of samples)`);

console.log(fails ? `\n${fails} check(s) failed` : '\nall DSP checks passed');
process.exit(fails ? 1 : 0);
