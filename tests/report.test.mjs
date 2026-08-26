/** Library report checks. computeReport is pure, so it runs here without a
 *  browser; renderReport is exercised only far enough to prove it produces
 *  balanced markup and escapes what it is given.
 *  Run with:  node tests/report.test.mjs  */

import { computeReport, renderReport } from '../js/report.js';

let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

let n = 0;
/** A track with just enough shape for the report to have something to add up. */
const track = (o = {}) => ({
  id: `t${++n}`,
  title: o.title || `Track ${n}`,
  artist: o.artist || 'Artist',
  album: o.album || 'Album',
  albumKey: o.albumKey || 'artist :: album',
  codec: o.codec || 'MP3',
  container: o.container || 'MPEG',
  lossless: !!o.lossless,
  size: o.size ?? 5_000_000,
  duration: o.duration ?? 200,
  source: o.source || 'blob',
  analyzed: o.analyzed !== false,
  analyzeError: o.analyzeError || null,
  needsAudio: !!o.needsAudio,
  needsRelink: !!o.needsRelink,
  loudness: o.lufs === null ? null : {
    integratedLufs: o.lufs ?? -14,
    lra: o.lra ?? 7,
    truePeakDb: -1,
  },
  quality: o.analyzed === false ? null : {
    score: o.score ?? 70,
    tier: o.tier || 'standard',
    cutoffHz: o.cutoffHz ?? 16000,
    brickwalled: o.brickwalled ?? true,
    clipPct: o.clipPct ?? 0,
    crestDb: o.crestDb ?? 12,
    bitrateKbps: o.kbps ?? 192,
    flags: o.flags || [],
  },
});

const settings = { targetLufs: -14 };

/* ------------------------------- headline -------------------------------- */

{
  const tracks = [
    track({ size: 1000, duration: 60 }),
    track({ size: 2000, duration: 30, source: 'folder' }),
    track({ size: 4000, duration: 10, analyzed: false }),
  ];
  const r = computeReport(tracks, [{ key: 'artist :: album', name: 'Album', artist: 'Artist' }], settings);
  eq('counts every track', r.total, 3);
  eq('counts only analyzed ones as analyzed', r.analyzed, 2);
  eq('sums duration', r.duration, 100);
  eq('separates stored from linked bytes', [r.storedBytes, r.linkedBytes], [5000, 2000]);
  eq('counts linked tracks', r.linked, 1);
  eq('total bytes is both together', r.bytes, 7000);
}

/* -------------------------------- tiers ---------------------------------- */

{
  const tracks = [
    track({ tier: 'lossless', score: 98 }),
    track({ tier: 'high', score: 85 }),
    track({ tier: 'high', score: 81 }),
    track({ tier: 'poor', score: 20 }),
    track({ analyzed: false }),
  ];
  const r = computeReport(tracks, [], settings);
  eq('tiers are counted', r.tiers.find((t) => t.tier === 'high').count, 2);
  eq('an unanalyzed track is in no tier', r.tiers.reduce((a, t) => a + t.count, 0), 4);
  eq('mean score ignores unanalyzed', r.avgScore, Math.round((98 + 85 + 81 + 20) / 4));
  eq('median score', r.medianScore, Math.round((85 + 81) / 2));
}

/* ------------------------------- loudness -------------------------------- */

{
  const tracks = [
    track({ lufs: -14 }), track({ lufs: -14.9 }),   // on target
    track({ lufs: -9 }),                             // loud
    track({ lufs: -23 }), track({ lufs: -20 }),      // quiet
    track({ lufs: null, analyzed: false }),
  ];
  const r = computeReport(tracks, [], settings);
  eq('on-target uses a 1 LU window', r.loudness.onTarget, 2);
  eq('louder than target', r.loudness.loud, 1);
  eq('quieter than target', r.loudness.quiet, 2);
  eq('only measured tracks count', r.loudness.measured, 5);
  eq('spread is end to end', r.loudness.spread, 14);
}

/* ------------------------------ bandwidth -------------------------------- */

{
  const tracks = [
    track({ cutoffHz: 10000 }),   // under 11
    track({ cutoffHz: 15600 }),   // 15.5–16.5
    track({ cutoffHz: 16000 }),   // 15.5–16.5
    track({ cutoffHz: 21500 }),   // 21+, the open-ended bucket
  ];
  const r = computeReport(tracks, [], settings);
  const bucket = (lo) => r.bandwidth.find((b) => b.lo === lo).count;
  eq('under 11 kHz', bucket(0), 1);
  eq('the 15.5 bucket holds both', bucket(15.5), 2);
  eq('the last bucket is open-ended', bucket(21), 1);
  eq('every track lands in exactly one bucket', r.bandwidth.reduce((a, b) => a + b.count, 0), 4);
}

/* ------------------------------- formats --------------------------------- */

{
  const tracks = [
    track({ codec: 'FLAC', lossless: true, size: 30_000_000, kbps: 900 }),
    track({ codec: 'MP3', size: 5_000_000, kbps: 192 }),
    track({ codec: 'MP3', size: 4_000_000, kbps: 256 }),
  ];
  const r = computeReport(tracks, [], settings);
  eq('formats are sorted by size', r.formats.map((f) => f.codec), ['FLAC', 'MP3']);
  eq('a format sums its bytes', r.formats[1].bytes, 9_000_000);
  eq('and averages its real bitrate', r.formats[1].avgKbps, 224);
}

/* --------------------------------- flags --------------------------------- */

{
  const tracks = [
    track({ flags: ['Encoder cut-off at 15.5 kHz'] }),
    track({ flags: ['Encoder cut-off at 16.2 kHz', 'Mono'] }),
    track({ flags: ['Clipping detected (0.30 % of samples)'] }),
    track({ flags: ['Clipping detected (1.10 % of samples)'] }),
  ];
  const r = computeReport(tracks, [], settings);
  const kinds = Object.fromEntries(r.flags.map((f) => [f.kind, f.count]));
  eq('the same flag with different numbers groups', kinds['Encoder cut-off'], 2);
  eq('so does a parenthesised measurement', kinds['Clipping detected'], 2);
  eq('a flag with no number is left alone', kinds.Mono, 1);
  eq('flags are sorted by how common they are', r.flags[0].count, 2);
}

/* ---------------------------- album consistency --------------------------- */

{
  const tracks = [
    track({ albumKey: 'a :: tight', lufs: -14 }),
    track({ albumKey: 'a :: tight', lufs: -14.5 }),
    track({ albumKey: 'b :: mixed', lufs: -8 }),
    track({ albumKey: 'b :: mixed', lufs: -19 }),
    track({ albumKey: 'c :: single', lufs: -30 }),
  ];
  const albums = [
    { key: 'a :: tight', name: 'Tight', artist: 'A' },
    { key: 'b :: mixed', name: 'Mixed', artist: 'B' },
    { key: 'c :: single', name: 'Single', artist: 'C' },
  ];
  const r = computeReport(tracks, albums, settings);
  eq('only the wide album is reported', r.inconsistent.map((a) => a.name), ['Mixed']);
  eq('with its spread', r.inconsistent[0].spread, 11);
  ok('a one-track album is never inconsistent', !r.inconsistent.some((a) => a.name === 'Single'));
}

/* ------------------------------- attention -------------------------------- */

{
  const tracks = [
    track({ analyzed: false }),
    track({ analyzed: false }),
    track({ analyzeError: 'could not decode' }),
    track({ needsAudio: true }),
    track({ needsRelink: true }),
    track({ clipPct: 1.4 }),
    track({ lossless: true, brickwalled: true, cutoffHz: 15800 }),
    track({ crestDb: 5.2 }),
  ];
  const r = computeReport(tracks, [], settings);
  eq('unanalyzed excludes the ones that errored', r.attention.unanalyzed, 2);
  eq('failures are listed', r.attention.failed.length, 1);
  eq('rows waiting for audio', r.attention.missingAudio, 1);
  eq('rows waiting for a folder', r.attention.needsRelink, 1);
  eq('clipping over the noise threshold', r.attention.clipping, 1);
  eq('lossless containers holding lossy audio', r.attention.fakeLossless, 1);
  eq('squashed dynamics', r.attention.squashed, 1);
}

/* -------------------------------- extremes -------------------------------- */

{
  const tracks = [
    track({ title: 'Loud', lufs: -5 }),
    track({ title: 'Quiet', lufs: -28 }),
    track({ title: 'Mid', lufs: -14 }),
    track({ title: 'Huge', size: 90_000_000 }),
    track({ title: 'Bad', score: 11 }),
  ];
  const r = computeReport(tracks, [], settings);
  eq('loudest first', r.extremes.loudest[0].title, 'Loud');
  eq('quietest first', r.extremes.quietest[0].title, 'Quiet');
  eq('largest file first', r.extremes.biggest[0].title, 'Huge');
  eq('worst score first', r.extremes.worst[0].title, 'Bad');
  ok('each list is capped at five', r.extremes.loudest.length <= 5);
}

/* ------------------------------- rendering -------------------------------- */

{
  eq('an empty library renders a sentence, not panels',
    renderReport(computeReport([], [], settings)).includes('<div class="panel"'), false);

  const tracks = [
    track({ title: '<script>x</script>', artist: 'A & B', flags: ['Mono'], clipPct: 0.4 }),
    track({ albumKey: 'z :: wide', lufs: -6 }),
    track({ albumKey: 'z :: wide', lufs: -20 }),
  ];
  const html = renderReport(computeReport(tracks, [{ key: 'z :: wide', name: 'W & W', artist: 'Z' }], settings));
  ok('a title cannot inject markup', !html.includes('<script>'), html.slice(0, 80));
  ok('ampersands are escaped', html.includes('A &amp; B'));
  ok('tags balance', (html.match(/<div/g) || []).length === (html.match(/<\/div>/g) || []).length,
    `${(html.match(/<div/g) || []).length} open vs ${(html.match(/<\/div>/g) || []).length} close`);
  ok('spans balance', (html.match(/<span/g) || []).length === (html.match(/<\/span>/g) || []).length,
    `${(html.match(/<span/g) || []).length} open vs ${(html.match(/<\/span>/g) || []).length} close`);
  ok('buttons balance', (html.match(/<button/g) || []).length === (html.match(/<\/button>/g) || []).length);
  ok('the inconsistent album is offered as a drill-down', html.includes('data-report-act="album"'));
  ok('extremes drill down to a track', html.includes('data-report-act="track"'));
}

console.log(fails ? `\n${fails} FAILED` : '\nAll report checks passed');
process.exit(fails ? 1 : 0);
