/** UI + wiring. Everything below the surface lives in library.js / dsp / audio. */

import * as db from './db.js';
import * as lib from './library.js';
import { Player } from './audio/player.js';
import { artUrl } from './image.js';
import { opusAvailable } from './audio/oggopus.js';
import { isZip, expand } from './zip.js';
import {
  $, $$, fmtTime, fmtBytes, fmtDb, escapeHtml, toast, debounce, sortBy,
} from './util.js';

const state = {
  settings: null,
  tracks: [],
  albums: [],
  view: 'tracks',
  filter: 'all',
  sort: 'addedAt',
  q: '',
  album: null,          // open album key
  queue: [],
  qi: -1,
  selected: new Set(),      // quality view selection
  knownOutliers: new Set(), // so re-renders don't re-tick what the user unticked
  selectMode: false,        // tracks view: multi-select for bulk actions
  picked: new Set(),
  lastPicked: null,         // anchor for shift-click ranges
};

const player = new Player();

/* ================================ bootstrap ================================ */

boot().catch((err) => {
  console.error(err);
  toast(`Startup failed: ${err.message}`, 'err');
});

async function boot() {
  state.settings = await db.settings();
  // Without WebCodecs there is no Opus encoder, so the target has to be WAV —
  // otherwise every track would look like it misses a target it can never hit.
  if (!opusAvailable() && state.settings.codec === 'opus') await db.setSetting('codec', 'wav');
  bindUI();
  applySettingsToUI();
  await lib.migrateLibrary();   // rebuild album keys / import positions if needed
  await reload();
  wirePlayer();
  registerSW();
  handleLaunchFiles();
  $('#build-info').textContent =
    `Opus encoder: ${opusAvailable() ? 'available' : 'not available in this browser (WAV fallback)'} · ` +
    `Analysis at 48 kHz · Storage: IndexedDB`;
}

async function reload() {
  state.tracks = await lib.allTracks();
  state.albums = await lib.allAlbums();
  renderAll();
}

function renderAll() {
  renderTracks();
  renderAlbums();
  renderQuality();
  updateStorageInfo();
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Resolved against the document, so this works from any GitHub Pages sub-path.
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
}

/* ================================= layout ================================= */

function bindUI() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

  bindAddMenu();
  $('#btn-add-track').addEventListener('click', () => $('#file-input').click());
  $('#tracks-empty').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'album') openAddMenu(true);
    if (e.target.dataset.act === 'track') $('#file-input').click();
  });
  for (const id of ['#file-input', '#dir-input', '#zip-input']) {
    $(id).addEventListener('change', (e) => importPicked(e.target));
  }

  $('#search').addEventListener('input', debounce((e) => {
    state.q = e.target.value.trim().toLowerCase();
    renderTracks();
  }, 150));

  $('#track-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#track-filters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    state.filter = chip.dataset.filter;
    renderTracks();
  });
  $('#track-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderTracks(); });
  $('#btn-analyze-all').addEventListener('click', analyzePending);
  $('#btn-select').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('#btn-sel-exit').addEventListener('click', () => setSelectMode(false));
  $('#btn-sel-all').addEventListener('click', () => selectAllVisible(true));
  $('#btn-sel-none').addEventListener('click', () => selectAllVisible(false));
  $('#btn-sel-artist').addEventListener('click', openBulkArtistDialog);
  $('#btn-sel-delete').addEventListener('click', deletePicked);

  $('#track-list').addEventListener('click', onTrackListClick);
  $('#quality-list').addEventListener('click', onTrackListClick);
  $('#album-grid').addEventListener('click', onAlbumGridClick);
  $('#album-detail').addEventListener('click', onTrackListClick);
  $('#btn-album-back').addEventListener('click', () => openAlbum(null));
  $('#btn-normalize-quality').addEventListener('click', normalizeSelectedQuality);
  $('#btn-renorm-art').addEventListener('click', renormalizeArt);
  $('#btn-repair-art').addEventListener('click', repairArt);

  bindSettings();
  bindDropZone();

  document.addEventListener('keydown', (e) => {
    // Don't hijack keys meant for a form control, a focused button or a dialog.
    if (e.target.matches('input,select,textarea,button') || $('dialog[open]')) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    if (e.code === 'ArrowRight' && e.shiftKey) playNext(1);
    if (e.code === 'ArrowLeft' && e.shiftKey) playNext(-1);
    if (e.key === 'Escape' && state.selectMode) setSelectMode(false);
    if (e.key === 'Delete' && state.selectMode && state.picked.size) deletePicked();
    if (e.key === 'a' && (e.ctrlKey || e.metaKey) && state.selectMode) {
      e.preventDefault();
      selectAllVisible(true);
    }
  });
}

/** "Add album" offers a folder or a .zip — one <input> cannot do both. */
function bindAddMenu() {
  const btn = $('#btn-add-album');
  const menu = $('#add-album-menu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); openAddMenu(menu.classList.contains('hidden')); });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    openAddMenu(false);
    $(item.dataset.source === 'zip' ? '#zip-input' : '#dir-input').click();
  });
  document.addEventListener('click', () => openAddMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openAddMenu(false); });
}

function openAddMenu(show) {
  const menu = $('#add-album-menu');
  if (!menu) return;
  menu.classList.toggle('hidden', !show);
  $('#btn-add-album').setAttribute('aria-expanded', String(!!show));
  if (show) menu.querySelector('.menu-item')?.focus();
}

function showView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  if (view === 'quality') renderQuality();
  if (view === 'settings') updateStorageInfo();
}

function bindDropZone() {
  let depth = 0;
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.style.outline = '2px dashed var(--accent)'; });
  document.addEventListener('dragleave', () => { if (--depth <= 0) document.body.style.outline = ''; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.style.outline = '';
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) await importFiles(files);
  });
}

/** Dropping a *folder* gives entries, not files — walk them so a dragged album
 *  imports whole, keeping its folder path (which drives the default order). */
async function filesFromDrop(dt) {
  // webkitGetAsEntry has to be called before we await anything: the item list
  // is emptied as soon as the drop event finishes dispatching.
  const entries = [...(dt?.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...(dt?.files || [])];

  const out = [];
  for (const entry of entries) await walkEntry(entry, entry.name, out);
  return out;
}

async function walkEntry(entry, path, out, depth = 0) {
  if (entry.isFile) {
    try {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, 'relPath', { value: path, enumerable: true });
      out.push(file);
    } catch { /* unreadable file, skip */ }
    return;
  }
  if (!entry.isDirectory || depth > 8) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, `${path}/${child.name}`, out, depth + 1);
  }
}

/* ================================= import ================================= */

async function importPicked(input) {
  const files = [...input.files];
  input.value = '';
  if (files.length) await importFiles(files);
}

async function importFiles(files) {
  const archives = [];
  for (const f of files) if (await isZip(f)) archives.push(f);

  let audio = files.filter((f) => !archives.includes(f)).filter(lib.isAudioFile);
  let unpackFailures = [];

  if (archives.length) {
    const unzip = progressStart(`Unpacking ${archives.length} archive${archives.length > 1 ? 's' : ''}`);
    try {
      for (const archive of archives) {
        if (unzip.signal.aborted) break;
        try {
          const { files: got, skipped } = await expand(archive, lib.isAudioName, {
            signal: unzip.signal,
            onProgress: (d, total, name) => unzip.set(total ? d / total : 1, `${archive.name} — ${d}/${total} ${name}`),
          });
          audio = audio.concat(got);
          unpackFailures = unpackFailures.concat(skipped);
        } catch (err) {
          unpackFailures.push(`${archive.name} (${err.message})`);
        }
      }
    } finally { unzip.done(); }
  }

  if (!audio.length) {
    toast(unpackFailures.length ? `Could not read: ${unpackFailures[0]}` : 'No audio files in that selection', 'err');
    if (unpackFailures.length) console.warn('Archive problems', unpackFailures);
    return;
  }
  if (unpackFailures.length) console.warn('Skipped archive entries', unpackFailures);

  const ctrl = progressStart(`Importing ${audio.length} file${audio.length > 1 ? 's' : ''}`);
  try {
    const res = await lib.importFiles(audio, {
      settings: state.settings,
      signal: ctrl.signal,
      onProgress: (done, total, label) => ctrl.set(done / total, `${Math.min(Math.ceil(done), total)} / ${total} — ${label}`),
    });
    await reload();
    const bits = [`${res.added} added`];
    if (res.skipped) bits.push(`${res.skipped} already in library`);
    if (res.failed.length) bits.push(`${res.failed.length} failed`);
    toast(bits.join(' · '), res.failed.length ? 'err' : '');
    if (res.failed.length) console.warn('Import failures', res.failed);
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'err');
  } finally {
    ctrl.done();
  }
}

/** PWA file handlers + share target. */
function handleLaunchFiles() {
  if ('launchQueue' in window && typeof LaunchParams !== 'undefined' && 'files' in LaunchParams.prototype) {
    launchQueue.setConsumer(async (params) => {
      const files = [];
      for (const handle of params.files || []) {
        try { files.push(await handle.getFile()); } catch { /* permission denied */ }
      }
      if (files.length) importFiles(files);
    });
  }
  if (new URLSearchParams(location.search).has('shared')) {
    history.replaceState(null, '', location.pathname);
    readSharedFiles().then((files) => { if (files.length) importFiles(files); });
  }
}

async function readSharedFiles() {
  try {
    const cache = await caches.open('share-inbox');
    const keys = await cache.keys();
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(req.url.split('/').pop().replace(/^\d+-\d+-/, ''));
      files.push(new File([blob], name, { type: blob.type }));
      await cache.delete(req);
    }
    return files;
  } catch { return []; }
}

/* ============================== track rendering ============================ */

function visibleTracks() {
  let list = state.tracks;
  if (state.q) {
    const q = state.q;
    list = list.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().includes(q));
  }
  const s = state.settings;
  if (state.filter === 'unanalyzed') list = list.filter((t) => !t.analyzed);
  else if (state.filter === 'loud') list = list.filter((t) => t.analyzed && Math.abs((t.loudness?.integratedLufs ?? s.targetLufs) - s.targetLufs) > 1);
  else if (state.filter === 'lowq') list = list.filter((t) => lib.needsQualityNormalization(t, s));

  const key = {
    addedAt: (t) => -t.addedAt,
    title: (t) => t.title.toLowerCase(),
    artist: (t) => `${t.artist} ${t.album} ${String(t.trackNo).padStart(3, '0')}`.toLowerCase(),
    album: (t) => `${t.album} ${String(t.discNo)} ${String(t.trackNo).padStart(3, '0')}`.toLowerCase(),
    lufs: (t) => t.loudness?.integratedLufs ?? 999,
    score: (t) => -(t.quality?.score ?? -1),
  }[state.sort];
  return sortBy(list, key);
}

function trackRow(t, { compact = false, checkbox = false, draggable = false, picked = false } = {}) {
  const g = lib.gainFor(t, state.settings, albumOf(t));
  const q = t.quality;
  const lufs = t.loudness?.integratedLufs;
  const badge = !t.analyzed
    ? (t.analyzeError
      ? `<span class="badge poor" title="${escapeHtml(t.analyzeError)}">not analyzed</span>`
      : '<span class="badge pending">analyzing…</span>')
    : `<span class="badge ${q?.tier || 'pending'}" title="${escapeHtml((q?.flags || []).join(' · ') || 'No issues found')}">${q?.tier || '—'} ${q?.score ?? ''}</span>`;

  const right = compact
    ? `<div class="num">${q?.bitrateKbps ? `${q.bitrateKbps} kbps` : '—'}</div>
       <div class="t3">${escapeHtml(t.codec || t.container)} ${t.sampleRate ? `· ${(t.sampleRate / 1000).toFixed(1)} kHz` : ''}</div>`
    : `<div class="t3">${escapeHtml(t.album || '')}</div>
       <div class="num">${fmtTime(t.duration)}</div>
       <div class="num lufs" title="Integrated loudness · gain applied ${fmtDb(g.gainDb)} dB">${lufs != null ? `${lufs.toFixed(1)}` : '—'} <span class="muted">LUFS</span></div>`;

  const cls = [
    'track',
    player.track?.id === t.id ? 'is-playing' : '',
    draggable ? 'draggable' : '',
    checkbox ? 'selectable' : '',
    checkbox && picked ? 'is-picked' : '',
  ].filter(Boolean).join(' ');

  return `<div class="${cls}" data-id="${t.id}"${draggable ? ' draggable="true"' : ''}>
    ${checkbox ? `<input type="checkbox" class="sel" data-id="${t.id}"${picked ? ' checked' : ''} aria-label="Select ${escapeHtml(t.title)}">`
              : `<img class="art" data-art="${t.artId || ''}" alt="" title="Click to set artwork">`}
    <div class="col">
      <div class="t1">${escapeHtml(t.title)}</div>
      <div class="t2">${escapeHtml(t.artist)}${t.transcode ? ' · <span class="muted">normalized</span>' : ''}</div>
    </div>
    ${right}
    <div>${badge}</div>
    <button class="kebab" data-menu="${t.id}" title="Details">⋮</button>
  </div>`;
}

function renderTracks() {
  const list = visibleTracks();
  const box = $('#track-list');
  $('#tracks-empty').classList.toggle('hidden', state.tracks.length > 0);
  box.innerHTML = list.map((t) =>
    trackRow(t, { checkbox: state.selectMode, picked: state.picked.has(t.id) })).join('');
  if (!state.selectMode) hydrateArt(box);
  updateSelectionBar();
}

function setSelectMode(on) {
  state.selectMode = !!on;
  if (!on) { state.picked.clear(); state.lastPicked = null; }
  $('#btn-select').classList.toggle('primary', state.selectMode);
  $('#btn-select').setAttribute('aria-pressed', String(state.selectMode));
  $('#selection-bar').classList.toggle('hidden', !state.selectMode);
  renderTracks();
}

function updateSelectionBar() {
  if (!state.selectMode) return;
  const n = state.picked.size;
  const bytes = state.tracks.filter((t) => state.picked.has(t.id)).reduce((a, t) => a + (t.size || 0), 0);
  $('#sel-count').textContent = n ? `${n} selected · ${fmtBytes(bytes)}` : 'Nothing selected';
  $('#btn-sel-delete').disabled = !n;
  $('#btn-sel-artist').disabled = !n;
}

function selectAllVisible(on) {
  for (const t of visibleTracks()) markPicked(t.id, on);
  state.lastPicked = null;
  updateSelectionBar();
}

/** Toggle one row in place — re-rendering the whole list on every click would
 *  throw away scroll position and detach the row the user is interacting with. */
function markPicked(id, on) {
  if (on) state.picked.add(id); else state.picked.delete(id);
  const row = $(`#track-list .track[data-id="${id}"]`);
  if (!row) return;
  row.classList.toggle('is-picked', on);
  const box = row.querySelector('input.sel');
  if (box) box.checked = on;
}

/** Shift-click selects everything between the anchor and this row. */
function pickRange(id) {
  const ids = visibleTracks().map((t) => t.id);
  const from = ids.indexOf(state.lastPicked);
  const to = ids.indexOf(id);
  if (from < 0 || to < 0) { markPicked(id, true); return; }
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) markPicked(ids[i], true);
}

async function hydrateArt(root) {
  for (const img of $$('img[data-art]', root)) {
    const id = img.dataset.art;
    if (!id) { img.src = placeholderArt(); continue; }
    const url = await artUrl(id, 'thumb');
    img.src = url || placeholderArt();
  }
}

let placeholder = null;
function placeholderArt() {
  if (placeholder) return placeholder;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1b2029"/><path fill="#39435a" d="M38 16v18.6A8 8 0 1 0 42 42V24h6v-8z"/></svg>`;
  placeholder = `data:image/svg+xml;base64,${btoa(svg)}`;
  return placeholder;
}

function onTrackListClick(e) {
  // The Quality tab keeps its own selection (what to re-encode); the Tracks tab's
  // selection is for bulk actions. Same row markup, different sets.
  const inQuality = !!e.target.closest('#quality-list');
  const check = e.target.closest('input.sel');
  if (check) {
    const set = inQuality ? state.selected : state.picked;
    if (check.checked) set.add(check.dataset.id); else set.delete(check.dataset.id);
    if (!inQuality) {
      state.lastPicked = check.dataset.id;
      check.closest('.track')?.classList.toggle('is-picked', check.checked);
      updateSelectionBar();
    }
    return;
  }
  const menu = e.target.closest('[data-menu]');
  if (menu) { openTrackDialog(menu.dataset.menu); return; }
  const row = e.target.closest('.track');
  if (!row) return;

  if (state.selectMode && !inQuality) {
    const id = row.dataset.id;
    if (e.shiftKey && state.lastPicked) pickRange(id);
    else markPicked(id, !state.picked.has(id));
    state.lastPicked = id;
    updateSelectionBar();
    return;
  }
  if (e.target.closest('img.art')) { pickArtFor({ trackId: row.dataset.id }); return; }
  playTrack(row.dataset.id, visibleContextFor(row));
}

function visibleContextFor(row) {
  const container = row.parentElement;
  return [...container.querySelectorAll('.track')].map((el) => el.dataset.id);
}

/* ================================= albums ================================= */

function albumOf(t) {
  return state.albums.find((a) => a.key === t.albumKey) || null;
}

function renderAlbums() {
  const grid = $('#album-grid');
  const detail = $('#album-detail');
  const back = $('#btn-album-back');
  if (state.album) {
    grid.classList.add('hidden');
    detail.classList.remove('hidden');
    back.classList.remove('hidden');
    renderAlbumDetail(state.album);
    return;
  }
  grid.classList.remove('hidden');
  detail.classList.add('hidden');
  back.classList.add('hidden');
  const albums = sortBy(state.albums, (a) => `${a.artist} ${a.year} ${a.name}`.toLowerCase());
  grid.innerHTML = albums.map((a) => `
    <div class="album" data-key="${escapeHtml(a.key)}">
      <img data-art="${a.artId || ''}" alt="">
      <div class="a1">${escapeHtml(a.name)}</div>
      <div class="a2">${escapeHtml(a.artist)} · ${a.trackCount} track${a.trackCount > 1 ? 's' : ''}${a.integratedLufs != null ? ` · ${a.integratedLufs} LUFS` : ''}</div>
    </div>`).join('') || '<p class="muted">No albums yet.</p>';
  hydrateArt(grid);
}

function onAlbumGridClick(e) {
  const card = e.target.closest('.album');
  if (card) openAlbum(card.dataset.key);
}

function openAlbum(key) {
  state.album = key;
  renderAlbums();
}

function renderAlbumDetail(key) {
  const album = state.albums.find((a) => a.key === key);
  if (!album) { openAlbum(null); return; }
  const tracks = lib.sortAlbumTracks(state.tracks.filter((t) => t.albumKey === key), album);
  const gain = state.settings.mode === 'album' && album.integratedLufs != null
    ? state.settings.targetLufs - album.integratedLufs : null;

  const el = $('#album-detail');
  el.innerHTML = `
    <div class="head">
      <img data-art="${album.artId || ''}" alt="">
      <div>
        <h2>${escapeHtml(album.name)}</h2>
        <div class="muted">${escapeHtml(album.artist)}${album.year ? ` · ${escapeHtml(album.year)}` : ''} · ${album.trackCount} tracks · ${fmtTime(album.duration)} · ${fmtBytes(album.bytes)}</div>
        <div class="muted small" style="margin-top:8px">
          Album loudness: <b>${album.integratedLufs != null ? `${album.integratedLufs} LUFS` : '—'}</b>
          ${gain != null ? ` · album gain ${fmtDb(gain)} dB` : ''}
          ${album.truePeakDb != null ? ` · peak ${fmtDb(album.truePeakDb)} dBTP` : ''}
          ${album.analyzedTracks < album.trackCount ? ` · ${album.trackCount - album.analyzedTracks} not analyzed` : ''}
        </div>
        <div class="row">
          <button class="btn primary" data-album-act="play">Play album</button>
          <button class="btn" data-album-act="rename">Edit album…</button>
          <button class="btn" data-album-act="art">Set album cover</button>
          <button class="btn" data-album-act="normalize">Normalize album quality</button>
          <button class="btn danger" data-album-act="delete">Delete album</button>
        </div>
      </div>
    </div>
    <div class="order-row">
      <label class="sort">Track order
        <select id="album-sort">
          ${Object.entries(lib.ALBUM_SORTS).map(([v, label]) =>
    `<option value="${v}"${album.sortMode === v ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </label>
      <span class="muted small">Drag a row to place it — that switches the album to a custom order.</span>
    </div>
    <div class="track-list" id="album-tracks">${tracks.map((t) => trackRow(t, { draggable: true })).join('')}</div>`;
  hydrateArt(el);

  el.querySelectorAll('[data-album-act]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = btn.dataset.albumAct;
    if (act === 'play' && tracks.length) playTrack(tracks[0].id, tracks.map((t) => t.id));
    if (act === 'rename') openAlbumEditDialog(album);
    if (act === 'art') pickArtFor({ albumKey: key });
    if (act === 'normalize') normalizeTracks(tracks.filter((t) => lib.needsQualityNormalization(t, state.settings)));
    if (act === 'delete') deleteAlbumByKey(key);
  }));

  $('#album-sort').addEventListener('change', async (e) => {
    await lib.setAlbumSort(key, e.target.value);
    await reload();
  });

  enableDragOrder($('#album-tracks'), async (ids) => {
    await lib.setAlbumOrder(key, ids);
    await reload();
    toast('Album order saved');
  });
}

/** Drag rows to reorder: the row moves under the cursor, and the resulting
 *  order is committed on drop. */
function enableDragOrder(list, onCommit) {
  let dragging = null;
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.track');
    if (!row) return;
    dragging = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id);
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.track');
    if (!over || over === dragging) return;
    const box = over.getBoundingClientRect();
    const below = e.clientY - box.top > box.height / 2;
    list.insertBefore(dragging, below ? over.nextSibling : over);
  });
  list.addEventListener('drop', (e) => e.preventDefault());
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    onCommit([...list.querySelectorAll('.track')].map((r) => r.dataset.id));
  });
}

/**
 * Small reusable edit form.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.hint]
 * @param {Array<{key,label,value,type?,hint?,span?}>} o.fields
 * @param {(values:object)=>Promise<void>} o.onSave
 */
function formDialog({ title, hint, fields, saveLabel = 'Save', onSave }) {
  const dlg = $('#dlg');
  const inputId = (f) => `f-${f.key}`;

  dlg.innerHTML = `<div class="dlg-body">
    <h3>${escapeHtml(title)}</h3>
    ${hint ? `<p class="muted small">${hint}</p>` : ''}
    <div class="form-grid">
      ${fields.map((f) => (f.type === 'checkbox'
    ? `<label class="switch span2"><input id="${inputId(f)}" type="checkbox"${f.value ? ' checked' : ''}>
         <span>${escapeHtml(f.label)}</span></label>`
    : `<div class="field${f.span ? ' span2' : ''}">
         <label for="${inputId(f)}">${escapeHtml(f.label)}</label>
         <input id="${inputId(f)}" class="text" type="${f.type || 'text'}"
                value="${escapeHtml(f.value ?? '')}" autocomplete="off" spellcheck="false">
         ${f.hint ? `<p class="hint">${escapeHtml(f.hint)}</p>` : ''}
       </div>`)).join('')}
    </div>
    <div class="actions">
      <button class="btn primary" data-act="save">${escapeHtml(saveLabel)}</button>
      <div class="grow"></div>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>
  </div>`;

  const read = () => Object.fromEntries(fields.map((f) => {
    const el = $(`#${inputId(f)}`);
    return [f.key, f.type === 'checkbox' ? el.checked : el.value];
  }));

  const save = async () => {
    const values = read();
    dlg.close();
    try { await onSave(values); } catch (err) { toast(err.message, 'err'); }
  };

  dlg.onclick = (e) => {
    if (e.target.dataset?.act === 'save') save();
    if (e.target.dataset?.act === 'cancel') dlg.close();
  };
  dlg.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      save();
    }
  };
  dlg.showModal();
  const first = dlg.querySelector('input.text');
  first?.select();
  return dlg;
}

function openAlbumEditDialog(album) {
  formDialog({
    title: 'Edit album',
    hint: `Applies to all ${album.trackCount} track${album.trackCount === 1 ? '' : 's'} in this album.`,
    fields: [
      { key: 'name', label: 'Album name', value: album.name, span: true },
      { key: 'artist', label: 'Album artist', value: album.artist, span: true },
      {
        key: 'applyToTrackArtists',
        label: 'Also set every track\'s own artist to this',
        type: 'checkbox',
        value: false,
      },
    ],
    async onSave({ name, artist, applyToTrackArtists }) {
      if (!name.trim()) { toast('An album needs a name', 'err'); return; }
      const ctrl = progressStart('Updating album');
      try {
        state.album = await lib.renameAlbum(album.key, { name, artist, applyToTrackArtists });
        await reload();
        toast('Album updated');
      } finally { ctrl.done(); }
    },
  });
}

function openTrackEditDialog(track) {
  formDialog({
    title: 'Edit track details',
    hint: 'Changing the album or album artist moves this track to that album.',
    fields: [
      { key: 'title', label: 'Title', value: track.title, span: true },
      { key: 'artist', label: 'Artist', value: track.artist, span: true },
      { key: 'album', label: 'Album', value: track.album },
      { key: 'albumArtist', label: 'Album artist', value: track.albumArtist, hint: 'Leave empty to use the artist' },
      { key: 'trackNo', label: 'Track no.', value: track.trackNo || '', type: 'number' },
      { key: 'discNo', label: 'Disc no.', value: track.discNo || '', type: 'number' },
      { key: 'year', label: 'Year', value: track.year },
      { key: 'genre', label: 'Genre', value: track.genre },
    ],
    async onSave(values) {
      await lib.updateTrack(track.id, values);
      await reload();
      if (player.track?.id === track.id) {
        const fresh = state.tracks.find((t) => t.id === track.id);
        if (fresh) updatePlayerUI(fresh, lib.gainFor(fresh, state.settings, albumOf(fresh)));
      }
      toast('Track updated');
    },
  });
}

/** Bulk-set the artist on the current selection. */
function openBulkArtistDialog() {
  const ids = [...state.picked];
  if (!ids.length) { toast('Select some tracks first'); return; }
  const picked = state.tracks.filter((t) => ids.includes(t.id));
  const artists = [...new Set(picked.map((t) => t.artist))];

  formDialog({
    title: `Set artist on ${ids.length} track${ids.length === 1 ? '' : 's'}`,
    hint: artists.length === 1
      ? `All ${ids.length} currently have “${escapeHtml(artists[0])}”.`
      : `The selection currently spans ${artists.length} different artists.`,
    saveLabel: 'Apply',
    fields: [
      { key: 'artist', label: 'Artist', value: artists.length === 1 ? artists[0] : '', span: true },
      { key: 'albumArtist', label: 'Also set album artist to the same', type: 'checkbox', value: false },
    ],
    async onSave({ artist, albumArtist }) {
      if (!artist.trim()) { toast('Enter an artist name', 'err'); return; }
      const ctrl = progressStart(`Updating ${ids.length} track${ids.length === 1 ? '' : 's'}`);
      try {
        const fields = { artist };
        if (albumArtist) fields.albumArtist = artist;
        const n = await lib.updateTracks(ids, fields, {
          signal: ctrl.signal,
          onProgress: (d, total, label) => ctrl.set(d / total, `${d} / ${total} — ${label}`),
        });
        await reload();
        setSelectMode(false);
        toast(`Updated ${n} track${n === 1 ? '' : 's'}`);
      } finally { ctrl.done(); }
    },
  });
}

/* ================================ artwork ================================= */

function pickArtFor(target) {
  const input = $('#img-input');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const ctrl = progressStart('Normalizing artwork');
    try {
      if (target.albumKey) await lib.setAlbumArt(target.albumKey, file, state.settings);
      else await lib.setTrackArt(target.trackId, file, state.settings);
      await reload();
      toast('Artwork normalized and saved');
    } catch (err) {
      toast(`Artwork failed: ${err.message}`, 'err');
    } finally { ctrl.done(); }
  };
  input.click();
}

async function repairArt() {
  const ctrl = progressStart('Repairing covers');
  try {
    const res = await lib.repairArtwork(
      state.settings,
      (d, total, label) => ctrl.set(total ? d / total : 1, `${d} / ${total} ${label}`),
      ctrl.signal,
    );
    await reload();
    toast(res.fixed
      ? `Fixed ${res.fixed} of ${res.checked} track${res.checked === 1 ? '' : 's'}`
      : `All ${res.checked} covers were already correct`);
  } catch (err) {
    toast(`Repair failed: ${err.message}`, 'err');
  } finally { ctrl.done(); }
}

async function renormalizeArt() {
  const ctrl = progressStart('Re-normalizing artwork');
  try {
    const n = await lib.renormalizeArtwork(state.settings, (d, total, label) => ctrl.set(total ? d / total : 1, `${d} / ${total} ${label}`));
    await reload();
    toast(`${n} cover${n === 1 ? '' : 's'} re-normalized`);
  } catch (err) {
    toast(`Failed: ${err.message}`, 'err');
  } finally { ctrl.done(); }
}

/* ================================ analysis ================================ */

async function analyzePending() {
  const pending = state.tracks.filter((t) => !t.analyzed);
  if (!pending.length) { toast('Everything is analyzed'); return; }
  const ctrl = progressStart(`Analyzing ${pending.length} track${pending.length > 1 ? 's' : ''}`);
  let done = 0, failed = 0;
  try {
    for (const t of pending) {
      if (ctrl.signal.aborted) break;
      ctrl.set(done / pending.length, t.title);
      try { await lib.analyzeTrack(t, { onProgress: (p) => ctrl.set((done + p) / pending.length, t.title) }); }
      catch (err) {
        failed++;
        t.analyzeError = String(err.message || err);
        await db.put('tracks', t);
        console.warn('Analysis failed', t.fileName, err);
      }
      done++;
    }
    await lib.refreshAllAlbums();
    await reload();
    const okCount = done - failed;
    toast(failed
      ? `${okCount} analyzed, ${failed} could not be decoded`
      : `Analyzed ${done} track${done === 1 ? '' : 's'}`, failed ? 'err' : '');
  } finally { ctrl.done(); }
}

/* ============================ quality normalize =========================== */

function renderQuality() {
  const s = state.settings;
  $('#q-target-lufs').textContent = s.targetLufs;

  lib.stats(s).then((st) => {
    $('#quality-summary').innerHTML = `
      ${stat(st.tracks, 'tracks')}
      ${stat(st.analyzed === st.tracks ? 'all' : `${st.analyzed}/${st.tracks}`, 'analyzed')}
      ${stat(st.avgLufs != null ? `${st.avgLufs}` : '—', 'average LUFS')}
      ${stat(`${st.spreadLu} LU`, 'loudness spread')}
      ${stat(st.avgScore ?? '—', 'average quality')}
      ${stat(fmtBytes(st.bytes), 'stored')}`;
  });

  const analyzed = state.tracks.filter((t) => t.analyzed && t.loudness?.integratedLufs != null);
  renderLufsChart(analyzed);

  const outliers = sortBy(state.tracks.filter((t) => lib.needsQualityNormalization(t, s)), (t) => t.quality?.score ?? 0);
  const box = $('#quality-list');
  if (!outliers.length) {
    box.innerHTML = '<p class="muted">Every analyzed track already matches the encoding target.</p>';
    $('#btn-normalize-quality').disabled = true;
    return;
  }
  $('#btn-normalize-quality').disabled = false;
  // New outliers start selected; anything the user unticked stays unticked.
  for (const t of outliers) {
    if (!state.knownOutliers.has(t.id)) { state.knownOutliers.add(t.id); state.selected.add(t.id); }
  }
  box.innerHTML = outliers.map((t) => trackRow(t, { compact: true, checkbox: true })).join('');
}

const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;

function renderLufsChart(tracks) {
  const s = state.settings;
  const min = -30, max = -4, step = 1;
  const bins = new Array(Math.ceil((max - min) / step)).fill(0);
  for (const t of tracks) {
    const v = t.loudness.integratedLufs;
    const i = Math.max(0, Math.min(bins.length - 1, Math.floor((v - min) / step)));
    bins[i]++;
  }
  const peak = Math.max(1, ...bins);
  $('#lufs-chart').innerHTML = bins.map((n, i) => {
    const lufs = min + i * step;
    const onTarget = Math.abs(lufs + 0.5 - s.targetLufs) <= 1;
    const label = lufs % 5 === 0 ? `<span>${lufs}</span>` : '';
    return `<div class="b${onTarget ? ' on-target' : ''}" style="height:${(n / peak) * 100}%" title="${n} track(s) near ${lufs} LUFS">${label}</div>`;
  }).join('');
  $('#lufs-chart').classList.add('chart-wrap');
}

function normalizeSelectedQuality() {
  const picked = state.tracks.filter((t) => state.selected.has(t.id) && lib.needsQualityNormalization(t, state.settings));
  normalizeTracks(picked);
}

async function normalizeTracks(tracks) {
  if (!tracks.length) { toast('Nothing to normalize'); return; }
  const ctrl = progressStart(`Normalizing ${tracks.length} file${tracks.length > 1 ? 's' : ''}`);
  let done = 0, failed = 0;
  try {
    for (const t of tracks) {
      if (ctrl.signal.aborted) break;
      ctrl.set(done / tracks.length, t.title);
      try {
        await lib.normalizeQuality(t, state.settings, {
          signal: ctrl.signal,
          onProgress: (p) => ctrl.set((done + p) / tracks.length, t.title),
        });
      } catch (err) {
        failed++;
        console.warn('Normalize failed', t.fileName, err);
      }
      done++;
    }
    await reload();
    toast(failed ? `${done - failed} normalized, ${failed} failed` : `${done} file${done === 1 ? '' : 's'} normalized`, failed ? 'err' : '');
  } finally { ctrl.done(); }
}

/* ================================ deletion ================================ */

/**
 * Shared delete path for one track, a selection, or a whole album.
 * @param {string[]} ids
 * @param {string} what human description used in the confirmation
 */
async function deleteTrackIds(ids, what) {
  if (!ids.length) return false;
  const picked = state.tracks.filter((t) => ids.includes(t.id));
  const bytes = picked.reduce((a, t) => a + (t.size || 0), 0);
  if (!confirm(`Delete ${what}?\n\n${picked.length} file${picked.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} will be removed from this device. This cannot be undone.`)) {
    return false;
  }

  const ctrl = progressStart(`Deleting ${picked.length} track${picked.length === 1 ? '' : 's'}`);
  try {
    // Stop first if we are about to delete what is playing.
    if (player.track && ids.includes(player.track.id)) player.stop();
    const res = await lib.deleteTracks(ids, {
      signal: ctrl.signal,
      onProgress: (done, total, label) => ctrl.set(done / total, `${done} / ${total} — ${label}`),
    });

    const gone = new Set(ids);
    state.queue = state.queue.filter((id) => !gone.has(id));
    state.qi = Math.min(state.qi, state.queue.length - 1);
    for (const id of ids) { state.picked.delete(id); state.selected.delete(id); state.knownOutliers.delete(id); }

    await reload();
    toast(`Deleted ${res.deleted} track${res.deleted === 1 ? '' : 's'} · ${fmtBytes(res.bytes)} freed`);
    return true;
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'err');
    return false;
  } finally { ctrl.done(); }
}

async function deletePicked() {
  const ids = [...state.picked];
  if (!ids.length) { toast('Select some tracks first'); return; }
  const done = await deleteTrackIds(ids, `${ids.length} selected track${ids.length === 1 ? '' : 's'}`);
  if (done) setSelectMode(false);
}

async function deleteAlbumByKey(key) {
  const album = state.albums.find((a) => a.key === key);
  if (!album) return;
  const ids = state.tracks.filter((t) => t.albumKey === key).map((t) => t.id);
  const done = await deleteTrackIds(ids, `the album "${album.name}" by ${album.artist}`);
  if (done) openAlbum(null);
}

/* ================================ playback ================================ */

async function playTrack(id, queueIds) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  state.queue = queueIds?.length ? [...queueIds] : [id];
  state.qi = Math.max(0, state.queue.indexOf(id));
  if (state.settings.shuffle) shuffleQueue();
  await loadCurrent();
}

async function loadCurrent() {
  const id = state.queue[state.qi];
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  const blob = await lib.getBlob(id);
  if (!blob) { toast('Audio data missing', 'err'); return; }
  const g = lib.gainFor(track, state.settings, albumOf(track));
  await player.load(track, blob, { gainDb: g.gainDb });
  updatePlayerUI(track, g);
  renderTracks();
  if (state.album) renderAlbums();
}

/** @param {boolean} auto true when a track ended by itself — only then does
 *  "repeat one" hold on the same track; the Next button always advances. */
function playNext(dir, auto = false) {
  if (!state.queue.length) return;
  if (auto && state.settings.repeat === 'one') { player.seek(0); player.play(); return; }
  let i = state.qi + dir;
  if (i >= state.queue.length) {
    if (state.settings.repeat !== 'all') { player.pause(); return; }
    i = 0;
  }
  if (i < 0) i = state.queue.length - 1;
  state.qi = i;
  loadCurrent();
}

function shuffleQueue() {
  const cur = state.queue[state.qi];
  const rest = state.queue.filter((id) => id !== cur);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.queue = cur ? [cur, ...rest] : rest;
  state.qi = 0;
}

function wirePlayer() {
  const bar = $('#player');
  player.setVolume(state.settings.volume);
  player.setLimiter(state.settings.limiter);
  $('#p-vol').value = state.settings.volume;
  $('#p-shuffle').classList.toggle('is-on', state.settings.shuffle);
  $('#p-repeat').classList.toggle('is-on', state.settings.repeat !== 'off');

  $('#p-play').addEventListener('click', () => player.toggle());
  $('#p-next').addEventListener('click', () => playNext(1));
  $('#p-prev').addEventListener('click', () => (player.position > 3 ? player.seek(0) : playNext(-1)));
  $('#p-vol').addEventListener('input', (e) => {
    player.setVolume(+e.target.value);
    db.setSetting('volume', +e.target.value);
  });
  $('#p-range').addEventListener('input', (e) => {
    const d = player.duration;
    if (d) player.seek((+e.target.value / 1000) * d);
  });
  $('#p-shuffle').addEventListener('click', async () => {
    const on = !state.settings.shuffle;
    await db.setSetting('shuffle', on);
    $('#p-shuffle').classList.toggle('is-on', on);
    if (on) shuffleQueue();
  });
  $('#p-repeat').addEventListener('click', async () => {
    const next = { off: 'all', all: 'one', one: 'off' }[state.settings.repeat];
    await db.setSetting('repeat', next);
    $('#p-repeat').classList.toggle('is-on', next !== 'off');
    $('#p-repeat').textContent = next === 'one' ? '🔂' : '🔁';
  });

  player.on('track', () => { bar.hidden = false; });
  player.on('play', () => { $('#p-play').textContent = '⏸'; });
  player.on('pause', () => { $('#p-play').textContent = '▶'; });
  player.on('ended', () => playNext(1, true));
  player.on('error', () => toast('Playback error — the file may be corrupt', 'err'));
  player.on('timeupdate', () => {
    const d = player.duration, p = player.position;
    $('#p-cur').textContent = fmtTime(p);
    $('#p-dur').textContent = fmtTime(d);
    if (d) $('#p-range').value = Math.round((p / d) * 1000);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d) }); } catch { /* ignore */ }
    }
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => player.play());
    navigator.mediaSession.setActionHandler('pause', () => player.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => playNext(-1));
    navigator.mediaSession.setActionHandler('seekto', (d) => player.seek(d.seekTime));
  }
}

async function updatePlayerUI(track, gain) {
  $('#player').hidden = false;
  $('#p-title').textContent = track.title;
  $('#p-sub').textContent = `${track.artist} — ${track.album}`;
  $('#p-gain').textContent = `${fmtDb(gain.gainDb)} dB`;
  $('#p-gain').title = gain.basis === 'off'
    ? 'Normalization is off'
    : `${gain.basis} normalization · wanted ${fmtDb(gain.wanted)} dB${gain.limitedBy === 'peak' ? ' · reduced to stay under the true-peak ceiling' : ''}`;
  const url = await artUrl(track.artId, 'full') || placeholderArt();
  $('#p-art').src = url;

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: url.startsWith('blob:') ? [{ src: url, sizes: `${state.settings.artSize}x${state.settings.artSize}` }] : [],
    });
  }
}

/* ============================== track dialog ============================== */

async function openTrackDialog(id) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  const dlg = $('#dlg');
  const g = lib.gainFor(t, state.settings, albumOf(t));
  const q = t.quality || {};
  const l = t.loudness || {};
  const art = await artUrl(t.artId, 'full');

  dlg.innerHTML = `<div class="dlg-body">
    <div class="dlg-art">
      ${art ? `<img src="${art}" alt="">` : '<div class="ph"></div>'}
      <div>
        <h3 style="margin:0 0 4px">${escapeHtml(t.title)}</h3>
        <div class="muted">${escapeHtml(t.artist)}</div>
        <div class="muted small">${escapeHtml(t.album)}${t.year ? ` · ${escapeHtml(t.year)}` : ''}</div>
        <div style="margin-top:10px">
          <span class="badge ${q.tier || 'pending'}">${q.tier || 'not analyzed'} ${q.score ?? ''}</span>
          <div class="meter" style="width:150px"><i style="width:${q.score || 0}%"></i></div>
        </div>
      </div>
    </div>

    <div class="kv">
      <div>File</div><div>${escapeHtml(t.fileName)} · ${fmtBytes(t.size)}</div>
      <div>Format</div><div>${escapeHtml(t.codec || '—')} in ${escapeHtml(t.container || '—')}${t.vbr ? ' (VBR)' : ''}</div>
      <div>Audio</div><div>${t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '—'} · ${t.channels || '?'} ch${t.bits ? ` · ${t.bits}-bit` : ''} · ${q.bitrateKbps ? `${q.bitrateKbps} kbps` : '—'}</div>
      <div>Duration</div><div>${fmtTime(t.duration)}</div>
      <div>Loudness</div><div>${l.integratedLufs != null ? `${l.integratedLufs} LUFS` : '—'} integrated${l.lra != null ? ` · LRA ${l.lra} LU` : ''}${l.shortTermMaxLufs != null ? ` · short-term max ${l.shortTermMaxLufs}` : ''}</div>
      <div>Peak</div><div>${l.truePeakDb != null ? `${fmtDb(l.truePeakDb)} dBTP true peak` : '—'}${l.samplePeakDb != null ? ` · ${fmtDb(l.samplePeakDb)} dBFS sample` : ''}</div>
      <div>Playback gain</div><div>${fmtDb(g.gainDb)} dB (${g.basis}${g.limitedBy === 'peak' ? ', capped by peak ceiling' : ''})</div>
      <div>Bandwidth</div><div>${q.cutoffHz ? `${(q.cutoffHz / 1000).toFixed(1)} kHz effective${q.brickwalled ? ' · brick-wall cut-off' : ''}` : '—'}</div>
      <div>Dynamics</div><div>${q.crestDb ? `crest ${q.crestDb} dB` : '—'}${q.clipPct ? ` · clipping ${q.clipPct}%` : ''}</div>
      ${t.transcode ? `<div>Normalized</div><div>${escapeHtml(t.transcode.profile)}${t.transcode.bakedGainDb ? ` · baked ${fmtDb(t.transcode.bakedGainDb)} dB` : ''}<br><span class="muted small">was ${escapeHtml(t.transcode.from.codec)} ${fmtBytes(t.transcode.from.size)}</span></div>` : ''}
      ${t.analyzeError ? `<div>Error</div><div class="muted">${escapeHtml(t.analyzeError)}</div>` : ''}
    </div>

    ${(q.flags || []).length ? `<p class="muted small">⚠ ${q.flags.map(escapeHtml).join('<br>⚠ ')}</p>` : ''}

    <div class="actions">
      <button class="btn primary" data-act="play">Play</button>
      <button class="btn" data-act="edit">Edit details</button>
      <button class="btn" data-act="art">Set artwork</button>
      <button class="btn" data-act="analyze">Re-analyze</button>
      <button class="btn" data-act="normalize">Normalize quality</button>
      ${t.hasOriginal ? '<button class="btn" data-act="restore">Restore original</button>' : ''}
      <button class="btn" data-act="download">Export file</button>
      <button class="btn danger" data-act="delete">Delete</button>
      <div class="grow"></div>
      <button class="btn" data-act="close">Close</button>
    </div>
  </div>`;

  dlg.onclick = async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'play') { dlg.close(); playTrack(t.id, visibleTracks().map((x) => x.id)); return; }
    if (act === 'edit') { dlg.close(); openTrackEditDialog(t); return; }
    if (act === 'art') { dlg.close(); pickArtFor({ trackId: t.id }); return; }
    if (act === 'analyze') {
      dlg.close();
      const ctrl = progressStart('Analyzing');
      try { await lib.analyzeTrack(t, { onProgress: (p) => ctrl.set(p, t.title) }); await lib.refreshAlbum(t.albumKey); await reload(); }
      catch (err) { toast(err.message, 'err'); }
      finally { ctrl.done(); }
      return;
    }
    if (act === 'normalize') { dlg.close(); normalizeTracks([t]); return; }
    if (act === 'restore') {
      dlg.close();
      const ctrl = progressStart('Restoring original');
      try { await lib.restoreOriginal(t); await reload(); toast('Original restored'); }
      catch (err) { toast(err.message, 'err'); }
      finally { ctrl.done(); }
      return;
    }
    if (act === 'download') {
      const blob = await lib.getBlob(t.id);
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = t.fileName.replace(/\.[^.]+$/, '') + (t.container === 'Ogg' ? '.opus' : t.container === 'WAV' ? '.wav' : t.fileName.match(/\.[^.]+$/)?.[0] || '');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return;
    }
    if (act === 'delete') {
      dlg.close();
      await deleteTrackIds([t.id], `"${t.title}"`);
    }
  };
  dlg.showModal();
}

/* ================================ settings ================================ */

function bindSettings() {
  const s = () => state.settings;

  const bindRange = (id, key, fmt, after) => {
    const el = $(id);
    const out = $(`${id}-val`);
    const show = () => { if (out) out.textContent = fmt(s()[key]); };
    el.addEventListener('input', () => { s()[key] = +el.value; show(); });
    el.addEventListener('change', async () => { await db.setSetting(key, +el.value); after?.(); });
    show();
  };

  bindRange('#set-target', 'targetLufs', (v) => `${v} LUFS`, onLoudnessSettingChange);
  bindRange('#set-ceiling', 'ceilingDbtp', (v) => `${v} dBTP`, onLoudnessSettingChange);
  bindRange('#set-bitrate', 'bitrate', (v) => `${v} kbps`, renderQuality);
  bindRange('#set-art', 'artSize', (v) => `${v} px`);
  bindRange('#set-thumb', 'thumbSize', (v) => `${v} px`);
  bindRange('#set-artq', 'artQuality', (v) => `${Math.round(v * 100)} %`);

  $('#set-mode').addEventListener('change', async (e) => { await db.setSetting('mode', e.target.value); onLoudnessSettingChange(); });
  $('#set-codec').addEventListener('change', async (e) => { await db.setSetting('codec', e.target.value); renderQuality(); });
  $('#set-rate').addEventListener('change', async (e) => { await db.setSetting('rate', +e.target.value); renderQuality(); });
  $('#set-channels').addEventListener('change', async (e) => { await db.setSetting('channels', +e.target.value); renderQuality(); });

  const bindCheck = (id, key, after) => $(id).addEventListener('change', async (e) => {
    await db.setSetting(key, e.target.checked);
    after?.();
  });
  bindCheck('#set-peaksafe', 'peakSafe', onLoudnessSettingChange);
  bindCheck('#set-limiter', 'limiter', () => player.setLimiter(state.settings.limiter));
  bindCheck('#set-bake', 'bakeGain');
  bindCheck('#set-keep', 'keepOriginal');
  bindCheck('#set-upscale', 'reencodeBetter', renderQuality);

  $('#btn-persist').addEventListener('click', async () => {
    if (!navigator.storage?.persist) { toast('Not supported in this browser', 'err'); return; }
    const ok = await navigator.storage.persist();
    toast(ok ? 'Storage is now persistent' : 'The browser declined persistent storage', ok ? '' : 'err');
    updateStorageInfo();
  });

  $('#btn-export').addEventListener('click', async () => {
    const tracks = (await lib.allTracks()).map(({ loudness, ...t }) => ({
      ...t,
      loudness: loudness ? { ...loudness, hist: undefined } : null,
    }));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings: state.settings, tracks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'offline-music-library.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  $('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Delete every track, cover and setting stored by this app?')) return;
    player.stop();
    await db.wipe();
    state.selected.clear();
    await reload();
    toast('Library deleted');
  });
}

function applySettingsToUI() {
  const s = state.settings;
  $('#set-mode').value = s.mode;
  $('#set-target').value = s.targetLufs;
  $('#set-ceiling').value = s.ceilingDbtp;
  $('#set-peaksafe').checked = s.peakSafe;
  $('#set-limiter').checked = s.limiter;
  $('#set-codec').value = opusAvailable() ? s.codec : 'wav';
  $('#set-bitrate').value = s.bitrate;
  $('#set-rate').value = String(s.rate);
  $('#set-channels').value = String(s.channels);
  $('#set-bake').checked = s.bakeGain;
  $('#set-keep').checked = s.keepOriginal;
  $('#set-upscale').checked = s.reencodeBetter;
  $('#set-art').value = s.artSize;
  $('#set-thumb').value = s.thumbSize;
  $('#set-artq').value = s.artQuality;
  $('#set-target-val').textContent = `${s.targetLufs} LUFS`;
  $('#set-ceiling-val').textContent = `${s.ceilingDbtp} dBTP`;
  $('#set-bitrate-val').textContent = `${s.bitrate} kbps`;
  $('#set-art-val').textContent = `${s.artSize} px`;
  $('#set-thumb-val').textContent = `${s.thumbSize} px`;
  $('#set-artq-val').textContent = `${Math.round(s.artQuality * 100)} %`;
  $('#p-repeat').textContent = s.repeat === 'one' ? '🔂' : '🔁';
  if (!opusAvailable()) {
    $('#set-codec').querySelector('option[value=opus]').disabled = true;
  }
}

/** Loudness settings affect what is playing right now, so re-resolve the gain. */
function onLoudnessSettingChange() {
  if (player.track) {
    const t = state.tracks.find((x) => x.id === player.track.id) || player.track;
    const g = lib.gainFor(t, state.settings, albumOf(t));
    player.setGainDb(g.gainDb);
    updatePlayerUI(t, g);
  }
  renderTracks();
  renderQuality();
}

async function updateStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  const parts = [];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) parts.push(`${fmtBytes(est.usage || 0)} used of ${fmtBytes(est.quota || 0)} available`);
    if (navigator.storage?.persisted) parts.push(await navigator.storage.persisted() ? 'persistent' : 'not persistent (the browser may evict data)');
  } catch { /* not supported */ }
  parts.push(`${state.tracks.length} tracks · ${state.albums.length} albums`);
  el.textContent = parts.join(' · ');
}

/* ================================ progress ================================ */

function progressStart(label) {
  const box = $('#progress');
  const ctrl = new AbortController();
  box.classList.remove('hidden');
  $('#progress-label').textContent = label;
  $('#progress-bar').style.width = '0%';
  $('#progress-sub').textContent = '';
  $('#progress-cancel').onclick = () => { ctrl.abort(); $('#progress-sub').textContent = 'Cancelling…'; };
  return {
    signal: ctrl.signal,
    set(fraction, sub = '') {
      $('#progress-bar').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      if (sub) $('#progress-sub').textContent = sub;
    },
    done() { box.classList.add('hidden'); },
  };
}
