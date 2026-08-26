/** The library, in aggregate.
 *
 *  Every file gets decoded once and measured hard — loudness, range, true peak,
 *  bandwidth, clipping, crest, real bitrate — and until now all of that was only
 *  ever readable one track at a time. Nothing here computes anything new: it is
 *  the same numbers already in IndexedDB, added up.
 *
 *  `computeReport` is pure (tracks in, plain data out) so it can be tested
 *  without a browser; `renderReport` turns that into markup and app.js binds the
 *  clicks. */

import { fmtBytes, fmtTime, escapeHtml } from './util.js';

/** Tier order, worst first — how the bars are stacked and the legend is read. */
const TIERS = ['poor', 'low', 'standard', 'high', 'lossless'];

/** Effective-bandwidth buckets, in kHz. The last is open-ended. */
const BW_EDGES = [0, 11, 14, 15.5, 16.5, 18, 19.5, 21];

const round1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * @param {object[]} tracks
 * @param {object[]} albums
 * @param {object} settings
 */
export function computeReport(tracks, albums, settings) {
  const analyzed = tracks.filter((t) => t.analyzed && t.quality);
  const withLufs = tracks.filter((t) => typeof t.loudness?.integratedLufs === 'number');
  const target = settings?.targetLufs ?? -14;

  /* ---- headline ---- */
  const storedBytes = tracks.reduce((a, t) => a + (t.source === 'folder' ? 0 : t.size || 0), 0);
  const linkedBytes = tracks.reduce((a, t) => a + (t.source === 'folder' ? t.size || 0 : 0), 0);

  /* ---- quality tiers ---- */
  const tiers = TIERS.map((tier) => ({
    tier,
    count: analyzed.filter((t) => t.quality.tier === tier).length,
  }));
  const scores = analyzed.map((t) => t.quality.score);

  /* ---- loudness against the target ---- */
  const lufs = withLufs.map((t) => t.loudness.integratedLufs);
  const onTarget = lufs.filter((v) => Math.abs(v - target) <= 1).length;
  const loud = withLufs.filter((t) => t.loudness.integratedLufs > target + 1).length;
  const quiet = withLufs.filter((t) => t.loudness.integratedLufs < target - 1).length;

  /* ---- bandwidth ---- */
  const bandwidth = BW_EDGES.map((lo, i) => {
    const hi = BW_EDGES[i + 1];
    const last = i === BW_EDGES.length - 1;   // "21 kHz and up" has no upper edge
    return {
      lo, hi, last,
      label: last ? `${lo}+ kHz` : i === 0 ? `under ${hi} kHz` : `${lo}–${hi}`,
      count: analyzed.filter((t) => {
        const k = (t.quality.cutoffHz || 0) / 1000;
        return k >= lo && (last ? true : k < hi);
      }).length,
    };
  });

  /* ---- formats ---- */
  const formats = [...analyzed.reduce((m, t) => {
    const key = t.codec || t.container || 'unknown';
    const row = m.get(key) || { codec: key, count: 0, bytes: 0, lossless: 0, kbps: [] };
    row.count++;
    row.bytes += t.size || 0;
    if (t.lossless) row.lossless++;
    if (t.quality.bitrateKbps) row.kbps.push(t.quality.bitrateKbps);
    return m.set(key, row);
  }, new Map()).values()]
    .map((r) => ({ ...r, avgKbps: r.kbps.length ? Math.round(mean(r.kbps)) : null }))
    .sort((a, b) => b.bytes - a.bytes);

  /* ---- what the detector actually complained about ----
     Flags carry their measured numbers ("Encoder cut-off at 15.5 kHz"), so they
     are grouped by the sentence in front of the number. */
  const flags = [...analyzed.reduce((m, t) => {
    for (const flag of t.quality.flags || []) {
      const key = flagKind(flag);
      const row = m.get(key) || { kind: key, count: 0, example: flag };
      row.count++;
      m.set(key, row);
    }
    return m;
  }, new Map()).values()].sort((a, b) => b.count - a.count);

  /* ---- albums that do not hang together ----
     Per-album loudness only sounds right if the record is internally consistent;
     a wide spread is usually a compilation, or tracks from two different rips. */
  const inconsistent = albums.map((album) => {
    const own = withLufs.filter((t) => t.albumKey === album.key).map((t) => t.loudness.integratedLufs);
    if (own.length < 2) return null;
    return {
      key: album.key,
      name: album.name,
      artist: album.artist,
      tracks: own.length,
      spread: round1(Math.max(...own) - Math.min(...own)),
    };
  }).filter((a) => a && a.spread >= 3).sort((a, b) => b.spread - a.spread);

  /* ---- everything that wants a human ---- */
  const attention = {
    unanalyzed: tracks.filter((t) => !t.analyzed && !t.analyzeError).length,
    failed: tracks.filter((t) => t.analyzeError),
    missingAudio: tracks.filter((t) => t.needsAudio).length,
    needsRelink: tracks.filter((t) => t.needsRelink).length,
    clipping: analyzed.filter((t) => (t.quality.clipPct || 0) > 0.05).length,
    fakeLossless: analyzed.filter((t) => t.lossless && t.quality.brickwalled && (t.quality.cutoffHz || 0) < 19500).length,
    squashed: analyzed.filter((t) => t.quality.crestDb && t.quality.crestDb < 7).length,
  };

  const top = (list, key, n = 5) => list.slice().sort((a, b) => key(b) - key(a)).slice(0, n);

  return {
    total: tracks.length,
    albums: albums.length,
    analyzed: analyzed.length,
    linked: tracks.filter((t) => t.source === 'folder').length,
    duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
    bytes: storedBytes + linkedBytes,
    storedBytes,
    linkedBytes,
    target,
    tiers,
    avgScore: scores.length ? Math.round(mean(scores)) : null,
    medianScore: median(scores),
    loudness: {
      onTarget,
      loud,
      quiet,
      measured: withLufs.length,
      avg: lufs.length ? round1(mean(lufs)) : null,
      spread: lufs.length ? round1(Math.max(...lufs) - Math.min(...lufs)) : 0,
      avgLra: round1OrNull(mean(withLufs.map((t) => t.loudness.lra).filter((v) => typeof v === 'number'))),
    },
    bandwidth,
    formats,
    flags,
    inconsistent,
    attention,
    extremes: {
      loudest: top(withLufs, (t) => t.loudness.integratedLufs, 5),
      quietest: top(withLufs, (t) => -t.loudness.integratedLufs, 5),
      clipped: top(analyzed.filter((t) => t.quality.clipPct > 0), (t) => t.quality.clipPct, 5),
      worst: top(analyzed, (t) => -t.quality.score, 5),
      biggest: top(tracks, (t) => t.size || 0, 5),
    },
  };
}

/** Strip the measured number so "cut-off at 15.5 kHz" and "at 16.2 kHz" group. */
function flagKind(flag) {
  return String(flag)
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s*\(#[^)]*\)/g, '')
    .replace(/\s+at #.*$/, '')
    .replace(/#\s*(kHz|kbps|dB|%)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[—-]\s*$/, '')
    .trim();
}

const round1OrNull = (v) => (v === null || !isFinite(v) ? null : round1(v));

function median(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/* -------------------------------- rendering ------------------------------- */

const pct = (n, total) => (total ? (n / total) * 100 : 0);

/** A proportional bar. Nothing is drawn for a zero — `min-width` on the fill
 *  keeps a tiny share visible, which would otherwise make "0" look like "1". */
const bar = (n, total, cls = '') =>
  `<span class="rep-track">${n > 0 ? `<i class="${cls}" style="width:${pct(n, total).toFixed(1)}%"></i>` : ''}</span>`;

const stat = (v, k, title = '') =>
  `<div class="stat"${title ? ` title="${escapeHtml(title)}"` : ''}><div class="v">${v}</div><div class="k">${escapeHtml(k)}</div></div>`;

/** @param {ReturnType<typeof computeReport>} r */
export function renderReport(r) {
  if (!r.total) {
    return '<p class="muted">Nothing in the library yet — the report is built entirely from what the import pass measures.</p>';
  }
  return [
    headline(r),
    tierPanel(r),
    loudnessPanel(r),
    bandwidthPanel(r),
    formatPanel(r),
    flagPanel(r),
    consistencyPanel(r),
    attentionPanel(r),
    extremesPanel(r),
  ].filter(Boolean).join('');
}

function headline(r) {
  return `<div class="quality-summary">
    ${stat(r.total, 'tracks')}
    ${stat(r.albums, 'records')}
    ${stat(fmtTime(r.duration), 'playing time')}
    ${stat(fmtBytes(r.storedBytes), 'stored here', r.linked ? `${fmtBytes(r.linkedBytes)} more is linked, not copied` : '')}
    ${stat(r.analyzed === r.total ? 'all' : `${r.analyzed}/${r.total}`, 'analyzed')}
    ${stat(r.avgScore ?? '—', 'average quality')}
  </div>`;
}

function tierPanel(r) {
  const total = r.tiers.reduce((a, t) => a + t.count, 0);
  if (!total) return '';
  return panel('Quality tiers', `
    <div class="rep-bar" role="img" aria-label="Quality tiers across the library">
      ${r.tiers.filter((t) => t.count).map((t) =>
    `<i class="tier-${t.tier}" style="flex:${t.count}"
        title="${t.count} ${t.tier} — ${pct(t.count, total).toFixed(0)}%"></i>`).join('')}
    </div>
    <div class="rep-legend">
      ${r.tiers.map((t) => `<span class="rep-key"><i class="tier-${t.tier}"></i>${t.tier}
        <b>${t.count}</b></span>`).join('')}
    </div>
    <p class="hint">Median score ${r.medianScore ?? '—'}, mean ${r.avgScore ?? '—'}. The tier is
    read off the effective bandwidth and then penalised for clipping, low sample rate and
    squashed dynamics.</p>`);
}

function loudnessPanel(r) {
  const l = r.loudness;
  if (!l.measured) return '';
  const rows = [
    ['within 1 LU of target', l.onTarget, 'on'],
    ['louder than target', l.loud, 'loud'],
    ['quieter than target', l.quiet, 'quiet'],
  ];
  return panel(`Loudness against ${r.target} LUFS`, `
    <div class="rep-rows">
      ${rows.map(([label, n, cls]) => `<div class="rep-row">
        <span class="rep-label">${label}</span>
        ${bar(n, l.measured, cls)}
        <b>${n}</b>
      </div>`).join('')}
    </div>
    <p class="hint">Average ${l.avg ?? '—'} LUFS across ${l.measured} measured track${l.measured === 1 ? '' : 's'},
    spanning ${l.spread} LU end to end${l.avgLra != null ? `, average loudness range ${l.avgLra} LU` : ''}.
    Playback gain already corrects all of this — the spread only says how much correcting it is doing.</p>`);
}

function bandwidthPanel(r) {
  const total = r.bandwidth.reduce((a, b) => a + b.count, 0);
  if (!total) return '';
  const peak = Math.max(1, ...r.bandwidth.map((b) => b.count));
  return panel('Effective bandwidth', `
    <div class="chart chart-wrap rep-hist">
      ${r.bandwidth.map((b) => `<div class="b${b.last ? ' on-target' : ''}"
        style="height:${(b.count / peak) * 100}%"
        title="${b.count} track(s), ${b.label}"><span>${b.last ? `${b.lo}+` : b.hi}</span></div>`).join('')}
    </div>
    <p class="hint">Where each file's spectrum actually stops, in kHz. A CD-sourced lossless
    track reaches past 20; anything bunched at 15–16 was encoded by a lossy codec at some
    point, whatever the container says.</p>`);
}

function formatPanel(r) {
  if (!r.formats.length) return '';
  const total = r.formats.reduce((a, f) => a + f.bytes, 0);
  return panel('Where the space goes', `
    <div class="rep-rows">
      ${r.formats.map((f) => `<div class="rep-row">
        <span class="rep-label">${escapeHtml(f.codec)} <em>${f.count}</em></span>
        ${bar(f.bytes, total)}
        <b>${fmtBytes(f.bytes)}</b>
      </div>`).join('')}
    </div>
    <p class="hint">${r.formats.map((f) =>
    `${escapeHtml(f.codec)}${f.avgKbps ? ` averages ${f.avgKbps} kbps` : ''}`).join(' · ')}</p>`);
}

function flagPanel(r) {
  if (!r.flags.length) return '';
  return panel('What the detector flagged', `
    <div class="rep-rows">
      ${r.flags.map((f) => `<div class="rep-row">
        <span class="rep-label">${escapeHtml(f.kind)}</span>
        ${bar(f.count, r.analyzed, 'warn')}
        <b>${f.count}</b>
      </div>`).join('')}
    </div>
    <p class="hint">Counted across ${r.analyzed} analyzed track${r.analyzed === 1 ? '' : 's'}.
    A flag is an observation, not a verdict — mono is a flag, and so is a deliberately loud master.</p>`);
}

function consistencyPanel(r) {
  if (!r.inconsistent.length) return '';
  return panel('Records that do not hang together', `
    <p class="hint">Per-album normalization keeps a record's internal dynamics, which only
    works if the record is internally consistent. These span more than 3 LU end to end —
    usually a compilation, or tracks that came from two different sources.</p>
    <div class="rep-list">
      ${r.inconsistent.slice(0, 12).map((a) => `<button class="rep-item" data-report-act="album"
        data-key="${escapeHtml(a.key)}">
        <span class="rep-item-main"><b>${escapeHtml(a.name)}</b><em>${escapeHtml(a.artist)}</em></span>
        <span class="rep-item-val">${a.spread} LU<i>${a.tracks} tracks</i></span>
      </button>`).join('')}
    </div>`);
}

function attentionPanel(r) {
  const a = r.attention;
  const items = [
    [a.unanalyzed, 'never analyzed', 'unanalyzed'],
    [a.failed.length, 'could not be decoded', null],
    [a.missingAudio, 'restored without their audio', null],
    [a.needsRelink, 'waiting for a folder to be linked again', null],
    [a.clipping, 'clipping', 'lowq'],
    [a.fakeLossless, 'lossless containers holding lossy audio', 'lowq'],
    [a.squashed, 'with a crest factor under 7 dB', null],
  ].filter(([n]) => n > 0);
  if (!items.length) {
    return panel('Wants a look', '<p class="muted">Nothing is flagged. Every track is analyzed, decodable and holds the audio it claims to.</p>');
  }
  return panel('Wants a look', `
    <div class="rep-chips">
      ${items.map(([n, label, filter]) => `<${filter ? 'button' : 'span'} class="rep-chip"
        ${filter ? `data-report-act="filter" data-filter="${filter}"` : ''}>
        <b>${n}</b> ${escapeHtml(label)}</${filter ? 'button' : 'span'}>`).join('')}
    </div>
    ${a.failed.length ? `<p class="hint">Failed: ${a.failed.slice(0, 4).map((t) => escapeHtml(t.title)).join(', ')}${a.failed.length > 4 ? ` and ${a.failed.length - 4} more` : ''}.</p>` : ''}`);
}

function extremesPanel(r) {
  const e = r.extremes;
  const groups = [
    ['Loudest', e.loudest, (t) => `${t.loudness.integratedLufs} LUFS`],
    ['Quietest', e.quietest, (t) => `${t.loudness.integratedLufs} LUFS`],
    ['Most clipped', e.clipped, (t) => `${t.quality.clipPct}%`],
    ['Lowest score', e.worst, (t) => `${t.quality.score}`],
    ['Largest files', e.biggest, (t) => fmtBytes(t.size)],
  ].filter(([, list]) => list.length);
  if (!groups.length) return '';
  return panel('Extremes', `<div class="rep-grid">
    ${groups.map(([title, list, value]) => `<div class="rep-col">
      <h4>${title}</h4>
      ${list.map((t) => `<button class="rep-item" data-report-act="track" data-id="${t.id}">
        <span class="rep-item-main"><b>${escapeHtml(t.title)}</b><em>${escapeHtml(t.artist)}</em></span>
        <span class="rep-item-val">${escapeHtml(String(value(t)))}</span>
      </button>`).join('')}
    </div>`).join('')}
  </div>`);
}

const panel = (title, body) => `<div class="panel"><h3>${escapeHtml(title)}</h3>${body}</div>`;
