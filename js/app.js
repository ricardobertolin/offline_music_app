/** UI + wiring. Everything below the surface lives in library.js / dsp / audio. */

import * as db from './db.js';
import * as lib from './library.js';
import * as source from './source.js';
import * as archive from './archive.js';
import { Player } from './audio/player.js';
import { artUrl, normalizeBackdrop } from './image.js';
import { opusAvailable } from './audio/oggopus.js';
import { isZip, expand } from './zip.js';
import { saveStream } from './zipwrite.js';
import { computeReport, renderReport } from './report.js';
import {
  $, $$, APP_VERSION, fmtTime, fmtBytes, fmtDb, escapeHtml, toast, debounce, sortBy,
} from './util.js';

const state = {
  settings: null,
  tracks: [],
  albums: [],
  folders: [],          // linked folders — empty everywhere but desktop Chromium
  backupScope: 'full',  // full | meta
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

/* ================================== theme ================================== */

/** Perceived luminance decides the ink that sits on the accent — "Bleach" is
 *  nearly white and would be unreadable with the dark default. */
function inkFor(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!isFinite(n)) return '#0a0a0b';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0a0a0b' : '#ffffff';
}

function applyTheme() {
  const s = state.settings;
  const el = document.documentElement;
  el.style.setProperty('--accent', s.accent);
  el.style.setProperty('--accent-ink', inkFor(s.accent));
  el.style.setProperty('--haze', String(s.haze));
  el.style.setProperty('--backdrop-dim', String(s.backdropDim));
  // The pattern backdrops and every pane's translucency key off these, so the
  // whole switch is one attribute rather than a pile of inline styles.
  el.dataset.backdrop = s.backdrop || 'none';
  el.dataset.backdropMono = s.backdropMono ? 'on' : 'off';
  // Phones default to the title alone; the columns are one attribute away.
  el.dataset.cols = s.phoneColumns ? 'all' : 'name';
  setSpin(player.playing);
}

/** The object URL for the stored backdrop, revoked whenever it is replaced. */
let backdropUrl = null;

/** Point the backdrop <img> at whatever blob is in settings (or nothing). */
function applyBackdropImage() {
  const blob = state.settings.backdropImage;
  if (backdropUrl) { URL.revokeObjectURL(backdropUrl); backdropUrl = null; }
  if (blob instanceof Blob) backdropUrl = URL.createObjectURL(blob);
  for (const img of [$('#backdrop-img'), $('#backdrop-thumb')]) {
    if (!img) continue;
    if (backdropUrl) { img.src = backdropUrl; img.classList.remove('is-empty'); }
    else { img.removeAttribute('src'); img.classList.add('is-empty'); }
  }
}

/** Stable hue per record, so one without a cover still has a colour of its own. */
function hueOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/** Inline custom properties for a record's printed base and its hero wash. */
function tintOf(key) {
  const tinted = state.settings?.tintedCovers ?? true;
  const hue = tinted ? hueOf(String(key || '')) : 30;
  const sat = tinted ? '14%' : '5%';
  return {
    cover: `linear-gradient(158deg, hsl(${hue} ${sat} 30%) 0%, hsl(${hue} ${sat} 14%) 58%, #0b0b0d 100%)`,
    wash: `radial-gradient(90% 120% at 20% 0%, hsl(${hue} ${sat} 26%) 0%, hsl(${hue} ${sat} 12%) 45%, #0a0a0b 100%)`,
  };
}

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
  applyTheme();
  applyBackdropImage();
  bindUI();
  setContext(VIEW_CTX[state.view]);
  applySettingsToUI();
  await lib.migrateLibrary();   // rebuild album keys / import positions if needed
  await reload();
  wirePlayer();
  registerSW();
  handleLaunchFiles();
  bindVersion();
  updateBackupEstimate();
  warnStaleFolders();
  $('#build-info').textContent =
    `Opus encoder: ${opusAvailable() ? 'available' : 'not available in this browser (WAV fallback)'} · ` +
    `Analysis at 48 kHz · Storage: IndexedDB · ` +
    `Folder links: ${source.canLink() ? 'supported' : 'not available in this browser'}`;
}

async function reload() {
  state.tracks = await lib.allTracks();
  state.albums = await lib.allAlbums();
  state.folders = source.canLink() ? await source.allFolders() : [];
  renderAll();
}

function renderAll() {
  renderTracks();
  renderAlbums();
  renderQuality();
  renderReportView();
  renderRail();
  renderFolders();
  updateStorageInfo();
}

/** The rail's counts and the two readouts under them. */
function renderRail() {
  const s = state.settings;
  const outliers = state.tracks.filter((t) => lib.needsQualityNormalization(t, s)).length;
  $('#n-albums').textContent = state.albums.length;
  $('#n-tracks').textContent = state.tracks.length;
  $('#n-quality').textContent = outliers;
  // The Report tab's count is what wants a human, not how many tracks there are.
  $('#n-report').textContent = state.tracks.filter((t) =>
    !t.analyzed || t.analyzeError || t.needsAudio || t.needsRelink).length;
  const bytes = state.tracks.reduce((a, t) => a + (t.size || 0), 0);
  $('#rail-cached').textContent = state.tracks.length ? `${state.tracks.length} trk · ${fmtBytes(bytes)}` : 'empty';
  $('#rail-out').textContent = s.codec === 'wav'
    ? `WAV · ${s.rate ? `${s.rate / 1000} k` : 'native'}`
    : `Opus ${s.bitrate} · ${s.rate ? `${s.rate / 1000} k` : 'native'}`;
}

/** The registration, kept so Settings → Version can update and activate it. */
let swReg = null;

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Resolved against the document, so this works from any GitHub Pages sub-path.
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => {
      swReg = reg;
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', renderVersion));
      renderVersion();
    })
    .catch((err) => console.warn('SW registration failed', err));
}

/* ================================= version ================================= */

/** What the running service worker says its cache is called; null until it answers. */
let swVersion = null;
/** Set only when the user asked for the update, so the first-ever install —
 *  which claims the page and fires the same event — does not reload under them. */
let swUpdating = false;

function bindVersion() {
  $('#ver-app').textContent = APP_VERSION;
  // Installed apps have no address bar to reload from, so they most need to see
  // that a newer build is sitting there waiting.
  $('#ver-mode').textContent =
    matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Yes — running standalone' : 'No — in a browser tab';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'version') { swVersion = e.data.version; renderVersion(); }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swUpdating) location.reload();
      else { swVersion = null; renderVersion(); }
    });
  }

  $('#btn-update').addEventListener('click', async () => {
    if (!swReg) { toast('No offline cache to update here.'); return; }
    const btn = $('#btn-update');
    btn.disabled = true;
    try {
      await swReg.update();
      const waiting = swReg.waiting;
      if (waiting) {
        // controllerchange (above) reloads once it has actually taken over.
        swUpdating = true;
        waiting.postMessage('skip-waiting');
        toast('Updating…');
      } else {
        toast('Already up to date.');
      }
    } catch {
      toast('Could not check — no network?', 'err');
    } finally {
      btn.disabled = false;
      renderVersion();
    }
  });

  renderVersion();
}

function renderVersion() {
  const controller = navigator.serviceWorker?.controller;
  if (controller && swVersion === null) controller.postMessage('version');

  const el = $('#ver-sw');
  el.textContent = !('serviceWorker' in navigator) ? 'Not supported'
    : !controller ? 'Not active yet — reload'
    : swVersion || 'Checking…';
  // The two lines carry the same number when the cache is current. Say so in
  // colour, because "why am I not seeing my change" is the whole point of this.
  el.classList.toggle('stale', !!swVersion && swVersion !== `v${APP_VERSION}`);

  $('#ver-state').textContent = swReg?.waiting
    ? 'An update is downloaded and waiting. Check for update to switch to it.'
    : swVersion && swVersion !== `v${APP_VERSION}`
      ? 'The offline cache is older than this build — check for update, or reload twice.'
      : 'Everything on this device is served from the offline cache; nothing is uploaded.';
}

/* ================================= layout ================================= */

function bindUI() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    // Pressing Records always lands on the grid, even from inside an open record.
    if (tab.dataset.view === 'albums' && state.album) openAlbum(null);
    showView(tab.dataset.view);
  }));

  bindAddMenu();
  $('#btn-add-track').addEventListener('click', () => $('#file-input').click());
  // "Add album" here has its own menu, wired in bindAddMenu.
  $('#tracks-empty').addEventListener('click', (e) => {
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
    // The filters live in the rail, so picking one has to take you to the list
    // it actually filters.
    showView('tracks');
    renderTracks();
  });
  $('#track-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderTracks(); });
  $('#btn-analyze-all').addEventListener('click', analyzePending);
  $('#btn-select').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('#btn-sel-exit').addEventListener('click', () => setSelectMode(false));
  $('#btn-sel-all').addEventListener('click', () => selectAllVisible(true));
  $('#btn-sel-none').addEventListener('click', () => selectAllVisible(false));
  $('#btn-sel-artist').addEventListener('click', openBulkArtistDialog);
  $('#btn-sel-send').addEventListener('click', sendPicked);
  $('#btn-sel-delete').addEventListener('click', deletePicked);

  $('#track-list').addEventListener('click', onTrackListClick);
  $('#quality-list').addEventListener('click', onTrackListClick);
  $('#album-grid').addEventListener('click', onAlbumGridClick);
  $('#album-detail').addEventListener('click', onTrackListClick);
  $('#report-body').addEventListener('click', onReportClick);
  $('#btn-album-back').addEventListener('click', () => openAlbum(null));
  $('#btn-normalize-quality').addEventListener('click', normalizeSelectedQuality);
  $('#btn-renorm-art').addEventListener('click', renormalizeArt);
  $('#btn-repair-art').addEventListener('click', repairArt);

  bindSettings();
  bindDropZone();

  // Crossing the 860px fold hides or shows the hero meter, so the loop has to
  // follow the layout.
  window.addEventListener('resize', debounce(syncMeter, 200));

  document.addEventListener('keydown', (e) => {
    // Escape closes the phone screen first — its close button holds focus, and
    // the guard below would otherwise swallow the key.
    if (e.key === 'Escape' && !$('#now').hidden && !$('dialog[open]')) { openNow(false); return; }
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

/**
 * "Add album" offers a folder or a .zip — one <input> cannot do both. The empty
 * state gets its own copy of the menu rather than borrowing the header's: the
 * only thing a first-time user is looking at is the middle of the page, and a
 * menu that opens in the far corner is not an answer.
 */
function bindAddMenu() {
  // Linking needs the File System Access API, so the option only exists where it does.
  if (source.canLink()) $$('.needs-link').forEach((el) => el.classList.remove('hidden'));

  for (const [btn, menu] of [['#btn-add-album', '#add-album-menu'], ['#btn-empty-album', '#empty-album-menu']]) {
    const m = $(menu);
    bindPopover($(btn), m);
    m.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      closeMenus();
      if (item.dataset.source === 'link') { linkFolder(); return; }
      $(item.dataset.source === 'zip' ? '#zip-input' : '#dir-input').click();
    });
  }
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
}

/**
 * Wire a button to the .menu that follows it. Menus stay in the DOM and are
 * only hidden, so anything inside keeps its id and its event bindings.
 */
function bindPopover(btn, menu) {
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const show = menu.classList.contains('hidden');
    closeMenus();
    menu.classList.toggle('hidden', !show);
    btn.setAttribute('aria-expanded', String(show));
    // Focus an item, never the order <select> — focusing a control inside the
    // hero scrolls it out of view the moment the menu opens.
    if (show) { fitMenu(menu); menu.querySelector('.menu-item')?.focus(); }
  });
  // Clicks inside a menu must not reach the document closer.
  menu.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * Keep an opened menu on the screen.
 *
 * A menu is positioned against its row, not against the window, so where it
 * lands depends on how far down the page that row happens to be — and on a
 * phone the record's Configure menu opened with its last item, Delete record,
 * 148 px below the fold. Where it ends up is a measured fact and CSS cannot see
 * it, so cap the height here and let the menu scroll inside itself.
 */
function fitMenu(menu) {
  menu.style.maxHeight = '';
  const room = window.innerHeight - menu.getBoundingClientRect().top - 10;
  if (menu.scrollHeight <= room) return;      // it already fits
  menu.style.maxHeight = `${Math.max(160, Math.round(room))}px`;
}

function closeMenus() {
  $$('.menu').forEach((m) => { m.classList.add('hidden'); m.style.maxHeight = ''; });
  $$('[aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

const VIEW_CTX = { tracks: 'Tracks', albums: 'Records', quality: 'Quality', report: 'Report', settings: 'Settings' };

function showView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  setContext(view === 'albums' && state.album
    ? state.albums.find((a) => a.key === state.album)?.name
    : VIEW_CTX[view]);
  if (view === 'quality') renderQuality();
  if (view === 'report') renderReportView();
  if (view === 'settings') { updateStorageInfo(); updateBackupEstimate(); }
  syncMeter();   // the hero meter only runs while its hero is on screen
}

const setContext = (label) => { $('#chrome-ctx').textContent = label || 'Library'; };

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

  // One of our own backups is a zip too, and unpacking it as an album would
  // import `audio/<uuid>.wav` as untagged tracks and throw away every
  // measurement in its manifest. Ask first, and restore it instead.
  const backups = [];
  for (const f of archives.slice()) {
    if (!await archive.isArchive(f)) continue;
    backups.push(f);
    archives.splice(archives.indexOf(f), 1);
  }
  for (const f of backups) await openRestoreDialog(f);

  let audio = files.filter((f) => !archives.includes(f) && !backups.includes(f)).filter(lib.isAudioFile);
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
    // A backup was the whole point of the drop, and it has already been handled.
    if (backups.length) return;
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
    if (res.reattached) bits.push(`${res.reattached} reattached`);
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

/* ============================= linked folders ============================= */

/** Pick a folder and pull what is in it into the library — by reference, not by
 *  copy. The picker has to run inside the click that asked for it. */
async function linkFolder() {
  if (!source.canLink()) { toast('This browser cannot link folders', 'err'); return; }
  let folder;
  try {
    folder = await source.pickFolder();
  } catch (err) {
    if (err?.name !== 'AbortError') toast(`Could not link that folder: ${err.message}`, 'err');
    return;
  }
  await scanFolderInto(folder, `Linking ${folder.name}`);
}

async function scanFolderInto(folder, label) {
  const ctrl = progressStart(label);
  try {
    const res = await lib.rescanFolder(folder, {
      settings: state.settings,
      signal: ctrl.signal,
      onProgress: (done, total, sub) => ctrl.set(total ? done / total : 0, sub),
    });
    await reload();
    const bits = [];
    if (res.added) bits.push(`${res.added} added`);
    if (res.reattached) bits.push(`${res.reattached} reattached`);
    if (res.moved) bits.push(`${res.moved} moved`);
    if (res.skipped) bits.push(`${res.skipped} already here`);
    if (res.missing.length) bits.push(`${res.missing.length} no longer in the folder`);
    toast(bits.length ? bits.join(' · ') : 'Nothing new in that folder');
  } catch (err) {
    toast(err instanceof source.NeedsPermissionError
      ? 'That folder needs to be reconnected first'
      : `Scan failed: ${err.message}`, 'err');
  } finally { ctrl.done(); }
}

/** The Settings list of links, with whatever each one needs doing to it. */
async function renderFolders() {
  const panel = $('#folders-panel');
  if (!panel) return;
  // Nothing to say in a browser that cannot link, and nothing to hide either.
  panel.hidden = !source.canLink();
  if (panel.hidden) return;

  const list = $('#folder-list');
  if (!state.folders.length) {
    list.innerHTML = '<p class="muted small">No folders linked. Everything in the library is stored in this browser.</p>';
    return;
  }
  const rows = [];
  for (const f of state.folders) {
    const state_ = await source.permissionOf(f);
    const n = state.tracks.filter((t) => t.folderId === f.id).length;
    const bytes = state.tracks.filter((t) => t.folderId === f.id).reduce((a, t) => a + (t.size || 0), 0);
    rows.push(`<div class="folder${state_ === 'granted' ? '' : ' is-stale'}" data-folder="${escapeHtml(f.id)}">
      <div class="folder-main">
        <b>${escapeHtml(f.name)}</b>
        <span class="muted small">${n} track${n === 1 ? '' : 's'} · ${fmtBytes(bytes)} read in place${
  f.lastScan ? ` · scanned ${new Date(f.lastScan).toLocaleDateString()}` : ''}</span>
      </div>
      <div class="folder-acts">
        ${state_ === 'granted'
    ? '<button class="btn ghost" data-folder-act="rescan">Rescan</button>'
    : '<button class="btn primary" data-folder-act="reconnect">Reconnect</button>'}
        <button class="btn ghost danger" data-folder-act="unlink">Unlink</button>
      </div>
    </div>`);
  }
  list.innerHTML = rows.join('');
}

async function onFolderListClick(e) {
  const btn = e.target.closest('[data-folder-act]');
  if (!btn) return;
  const id = btn.closest('[data-folder]')?.dataset.folder;
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;

  if (btn.dataset.folderAct === 'reconnect') {
    const got = await source.reconnect(folder);
    source.forgetCache();
    if (got === 'granted') { await reload(); toast(`"${folder.name}" reconnected`); }
    else toast('The browser did not grant access to that folder', 'err');
    return;
  }
  if (btn.dataset.folderAct === 'rescan') { await scanFolderInto(folder, `Rescanning ${folder.name}`); return; }
  if (btn.dataset.folderAct === 'unlink') {
    const n = state.tracks.filter((t) => t.folderId === folder.id).length;
    if (!confirm(`Unlink "${folder.name}"?\n\n${n} track${n === 1 ? '' : 's'} will be removed from the library. `
      + 'The folder and the files in it are not touched.')) return;
    await lib.unlinkFolder(folder.id);
    await reload();
    toast(`Unlinked "${folder.name}"`);
  }
}

/** A linked folder whose permission lapsed cannot play anything — say so once,
 *  at boot, rather than one failed track at a time. */
async function warnStaleFolders() {
  if (!source.canLink() || !state.folders.length) return;
  const stale = await source.foldersNeedingPermission();
  if (stale.length) {
    toast(`${stale.length} linked folder${stale.length === 1 ? '' : 's'} need reconnecting — see Settings`, 'err');
  }
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

/** Phone widths swap the tier word for these — see .badge[data-abbr] in the CSS.
 *  The column is 96px on a phone and "standard" alone does not fit in it. */
const TIER_ABBR = {
  lossless: 'LSL', high: 'HI', standard: 'STD', low: 'LOW', poor: 'POOR', pending: '—',
};

/**
 * @param {object} o
 * @param {'album'|'style'} [o.secondary] third column: the album, or the genre —
 *        inside a record the album name is the same on every row, so it earns
 *        its space by carrying the style instead.
 */
function trackRow(t, { compact = false, checkbox = false, draggable = false, picked = false, secondary = 'album' } = {}) {
  const g = lib.gainFor(t, state.settings, albumOf(t));
  const q = t.quality;
  const lufs = t.loudness?.integratedLufs;
  const tier = q?.tier || 'pending';
  const badge = !t.analyzed
    ? (t.analyzeError
      ? `<span class="badge poor" data-abbr="ERR" title="${escapeHtml(t.analyzeError)}">not analyzed</span>`
      : '<span class="badge pending" data-abbr="···">analyzing…</span>')
    : `<span class="badge ${tier}" data-abbr="${TIER_ABBR[tier] || '—'} ${q?.score ?? ''}"
             title="${escapeHtml((q?.flags || []).join(' · ') || 'No issues found')}">${q?.tier || '—'} ${q?.score ?? ''}</span>`;

  const cols = compact
    ? `<div class="t3">${escapeHtml(t.codec || t.container || '')}${t.sampleRate ? ` · ${(t.sampleRate / 1000).toFixed(1)} kHz` : ''}</div>
       <div class="qual">${badge}</div>
       <div class="num kbps">${q?.bitrateKbps ? `${q.bitrateKbps} kbps` : '—'}</div>`
    : `<div class="t3">${escapeHtml(secondary === 'style' ? (t.genre || t.codec || t.container || '') : (t.album || ''))}</div>
       <div class="qual">${badge}</div>
       <div class="num lufs" title="Integrated loudness · gain applied ${fmtDb(g.gainDb)} dB">${lufs != null ? lufs.toFixed(1) : '—'}</div>
       <div class="num dur">${fmtTime(t.duration)}</div>`;

  const cls = [
    'track',
    player.track?.id === t.id ? 'is-playing' : '',
    draggable ? 'draggable' : '',
    checkbox ? 'selectable' : '',
    checkbox && picked ? 'is-picked' : '',
  ].filter(Boolean).join(' ');

  const face = checkbox
    ? `<input type="checkbox" class="sel" data-id="${t.id}"${picked ? ' checked' : ''} aria-label="Select ${escapeHtml(t.title)}">`
    : `<div class="tile" style="--cover:${tintOf(t.albumKey).cover}" title="Click to set artwork">
         <img data-art="${t.artId || ''}" class="is-empty" alt=""></div>`;

  return `<div class="${cls}" data-id="${t.id}"${draggable ? ' draggable="true"' : ''}>
    ${face}
    <div class="col">
      <div class="t1">${escapeHtml(t.title)}</div>
      <div class="t2">${escapeHtml(t.artist)}${t.transcode ? ' · normalized' : ''}</div>
    </div>
    ${cols}
    <button class="kebab" data-menu="${t.id}" title="Details">⋮</button>
  </div>`;
}

function renderTracks() {
  const list = visibleTracks();
  const box = $('#track-list');
  $('#tracks-empty').classList.toggle('hidden', state.tracks.length > 0);
  $('#tracks-head').classList.toggle('hidden', list.length === 0);
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
  $('#btn-sel-send').disabled = !n;
}

/** Send the current selection. Named after the record when it is all one. */
function sendPicked() {
  const ids = [...state.picked];
  if (!ids.length) { toast('Select some tracks first'); return; }
  const picked = state.tracks.filter((t) => ids.includes(t.id));
  const albums = new Set(picked.map((t) => t.album));
  sendTracks(ids, albums.size === 1 ? [...albums][0] : `${ids.length} tracks`);
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

/** A record with no cover keeps its printed face — there is no placeholder
 *  image to swap in, so the img is simply left empty and hidden. */
async function hydrateArt(root) {
  for (const img of $$('img[data-art]', root)) {
    const url = img.dataset.art ? await artUrl(img.dataset.art, img.dataset.size || 'thumb') : null;
    if (url) { img.src = url; img.classList.remove('is-empty'); }
    else { img.removeAttribute('src'); img.classList.add('is-empty'); }
  }
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
  if (e.target.closest('.tile')) { pickArtFor({ trackId: row.dataset.id }); return; }
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
  const head = $('#albums-head');
  if (state.album) {
    grid.classList.add('hidden');
    head.classList.add('hidden');
    detail.classList.remove('hidden');
    back.classList.remove('hidden');
    renderAlbumDetail(state.album);
    return;
  }
  grid.classList.remove('hidden');
  head.classList.remove('hidden');
  detail.classList.add('hidden');
  back.classList.add('hidden');
  const albums = sortBy(state.albums, (a) => `${a.artist} ${a.year} ${a.name}`.toLowerCase());
  grid.innerHTML = albums.map((a) => {
    const current = player.track?.albumKey === a.key;
    return `<div class="album${current ? ' is-current' : ''}" data-key="${escapeHtml(a.key)}">
      <div class="tile" style="--cover:${tintOf(a.key).cover}">
        <!-- Full size, not the thumb. A grid tile is 120–220 css px, so a phone
             is asking it for 400-plus device pixels and a 128px thumb has to be
             blown up nearly 4× — which is why the grid read soft next to the
             record's own hero. Thumbs stay where they fit: the 40px track rows,
             which is also where there are thousands of them. -->
        <img data-art="${a.artId || ''}" data-size="full" class="is-empty" alt="">
        <div class="tile-cap">
          <b>${escapeHtml(a.name)}</b>
          <span>${a.trackCount} track${a.trackCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div class="a1">${escapeHtml(a.name)}</div>
      <div class="a2">${escapeHtml(a.artist)}${a.integratedLufs != null ? ` · ${a.integratedLufs} LUFS` : ''}</div>
    </div>`;
  }).join('') || '<p class="hint">No records yet.</p>';
  hydrateArt(grid);
}

function onAlbumGridClick(e) {
  const card = e.target.closest('.album');
  if (card) openAlbum(card.dataset.key);
}

function openAlbum(key) {
  state.album = key;
  renderAlbums();
  setContext(key ? state.albums.find((a) => a.key === key)?.name : VIEW_CTX.albums);
}

function renderAlbumDetail(key) {
  const album = state.albums.find((a) => a.key === key);
  if (!album) { openAlbum(null); return; }
  const tracks = lib.sortAlbumTracks(state.tracks.filter((t) => t.albumKey === key), album);
  const gain = state.settings.mode === 'album' && album.integratedLufs != null
    ? state.settings.targetLufs - album.integratedLufs : null;

  const tint = tintOf(key);
  const pending = album.trackCount - album.analyzedTracks;
  const el = $('#album-detail');
  el.innerHTML = `
    <div class="hero" style="--wash:${tint.wash};--cover:${tint.cover}">
      <div class="hero-wash"></div>
      <div class="hero-grain"></div>
      <div class="hero-fade"></div>
      <div class="hero-body">
        <!-- Not a button. Tapping the cover used to throw you straight into the
             gallery, which on a phone is what happens every time you mean to
             scroll. Setting the cover lives in Configure, where it is deliberate. -->
        <div class="tile">
          <img data-art="${album.artId || ''}" data-size="full" class="is-empty" alt="">
          <div class="tile-cap">
            <b>${escapeHtml(album.name)}</b>
            <span>${album.trackCount} track${album.trackCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div class="hero-text">
          <div class="eyebrow">Record</div>
          <h2 class="display">${escapeHtml(album.name)}</h2>
          <div class="hero-by">
            <span>${escapeHtml(album.artist)}</span>
            ${album.year ? `<i>/</i><span class="dim">${escapeHtml(album.year)}</span>` : ''}
          </div>
          <div class="hero-meta">
            <span>${album.trackCount} track${album.trackCount === 1 ? '' : 's'} (${fmtTime(album.duration)})</span>
            <span>${fmtBytes(album.bytes)}</span>
            ${album.integratedLufs != null
    ? `<span class="press" title="Gated over every block of every track on the record${gain != null ? ` · album gain ${fmtDb(gain)} dB` : ''}${album.truePeakDb != null ? ` · peak ${fmtDb(album.truePeakDb)} dBTP` : ''}">${album.integratedLufs} LUFS</span>`
    : '<span class="press off">Not analyzed</span>'}
            ${pending > 0 && album.integratedLufs != null ? `<span class="press off">${pending} pending</span>` : ''}
          </div>
        </div>
        <div class="hero-meter" id="hero-meter" aria-hidden="true"></div>
      </div>
      <div class="hero-actions">
        <button class="btn primary" data-album-act="play">Play</button>
        <button class="btn" data-album-act="shuffle">Shuffle</button>
        <div class="menu-wrap">
          <button class="linkbtn" id="btn-album-config" aria-haspopup="true" aria-expanded="false">⚙ Configure</button>
          <div class="menu hidden" id="album-config" role="menu">
            <div class="menu-sec">
              <label class="menu-label" for="album-sort">Track order</label>
              <select id="album-sort">
                ${Object.entries(lib.ALBUM_SORTS).map(([v, label]) =>
    `<option value="${v}"${album.sortMode === v ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
              </select>
              <p class="menu-hint">Drag a row to place it by hand — that switches the record to a custom order.</p>
            </div>
            <div class="menu-sep"></div>
            <button class="menu-item" data-album-act="rename" role="menuitem">
              <b>Edit name &amp; artist…</b><span>Applies to all ${album.trackCount} track${album.trackCount === 1 ? '' : 's'}</span>
            </button>
            <button class="menu-item" data-album-act="art" role="menuitem">
              <b>Set cover…</b><span>Center-cropped and normalized</span>
            </button>
            <button class="menu-item" data-album-act="normalize" role="menuitem">
              <b>Normalize quality</b><span>Re-encode tracks that miss the target</span>
            </button>
            <button class="menu-item" data-album-act="send" role="menuitem">
              <b>Send this record…</b><span>A .zip carrying the audio and every measurement</span>
            </button>
            <div class="menu-sep"></div>
            <button class="menu-item danger" data-album-act="delete" role="menuitem">
              <b>Delete record</b><span>Its tracks, audio and orphaned covers</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="tl-head">
      <span></span><span>Title</span><span class="t3">Style</span>
      <span class="qual">Quality</span><span class="lufs num">Loudness</span><span class="num dur">Time</span><span></span>
    </div>
    <div class="track-list" id="album-tracks">${tracks.map((t) =>
    trackRow(t, { draggable: true, secondary: 'style' })).join('')}</div>`;
  hydrateArt(el);
  bindPopover($('#btn-album-config'), $('#album-config'));
  syncMeter();

  el.querySelectorAll('[data-album-act]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenus();
    const act = btn.dataset.albumAct;
    if (act === 'play' && tracks.length) playTrack(tracks[0].id, tracks.map((t) => t.id));
    if (act === 'shuffle' && tracks.length) {
      const ids = tracks.map((t) => t.id);
      playTrack(ids[Math.floor(Math.random() * ids.length)], ids, { shuffle: true });
    }
    if (act === 'rename') openAlbumEditDialog(album);
    if (act === 'art') pickArtFor({ albumKey: key });
    if (act === 'normalize') normalizeTracks(tracks.filter((t) => lib.needsQualityNormalization(t, state.settings)));
    if (act === 'send') sendTracks(tracks.map((t) => t.id), album.name);
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

  // Resolves once the form is finished with — after onSave has run, or straight
  // away if it was cancelled. Callers that queue dialogs (importing two backups
  // at once) need to know when one is really done, and the dialog's own close
  // event fires long before the work behind it has.
  let saving = false;
  let settle;
  const closed = new Promise((r) => { settle = r; });
  dlg.addEventListener('close', () => { if (!saving) settle(); }, { once: true });

  const save = async () => {
    saving = true;               // set before close(), which the listener races
    const values = read();
    dlg.close();
    try { await onSave(values); } catch (err) { toast(err.message, 'err'); }
    settle();
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
  return { dlg, closed };
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

/* ================================= report ================================= */

/** The whole library, added up. Cheap enough to rebuild on every reload — it is
 *  arithmetic over records that are already in memory. */
function renderReportView() {
  const box = $('#report-body');
  if (!box) return;
  box.innerHTML = renderReport(computeReport(state.tracks, state.albums, state.settings));
}

/** Every number on the report is a door into the list it came from. */
function onReportClick(e) {
  const btn = e.target.closest('[data-report-act]');
  if (!btn) return;
  const act = btn.dataset.reportAct;
  if (act === 'track') { openTrackDialog(btn.dataset.id); return; }
  if (act === 'album') {
    openAlbum(btn.dataset.key);
    showView('albums');
    return;
  }
  if (act === 'filter') {
    const chip = $(`#track-filters .chip[data-filter="${btn.dataset.filter}"]`);
    if (chip) chip.click();   // the chip already knows to switch views and redraw
  }
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
  const linked = picked.filter((t) => t.source === 'folder').length;
  const bytes = picked.reduce((a, t) => a + (t.source === 'folder' ? 0 : t.size || 0), 0);
  // Deleting a linked track removes a record, not a file. Saying "will be
  // removed from this device" about someone's own music folder would be a lie.
  const detail = linked === picked.length
    ? `${picked.length} track${picked.length === 1 ? '' : 's'} will be removed from the library. The files stay in their linked folder.`
    : `${picked.length} file${picked.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} will be removed from this device. This cannot be undone.${
      linked ? `\n\n${linked} of them are linked — those files stay in their folder.` : ''}`;
  if (!confirm(`Delete ${what}?\n\n${detail}`)) return false;

  const ctrl = progressStart(`Deleting ${picked.length} track${picked.length === 1 ? '' : 's'}`);
  try {
    // Stop first if we are about to delete what is playing.
    if (player.track && ids.includes(player.track.id)) stopPlayback();
    const res = await lib.deleteTracks(ids, {
      signal: ctrl.signal,
      onProgress: (done, total, label) => ctrl.set(done / total, `${done} / ${total} — ${label}`),
    });

    const gone = new Set(ids);
    state.queue = state.queue.filter((id) => !gone.has(id));
    state.qi = Math.min(state.qi, state.queue.length - 1);
    for (const id of ids) { state.picked.delete(id); state.selected.delete(id); state.knownOutliers.delete(id); }

    await reload();
    toast(`Deleted ${res.deleted} track${res.deleted === 1 ? '' : 's'}${
      res.freed ? ` · ${fmtBytes(res.freed)} freed` : ''}${
      res.linked ? ` · ${res.linked} left in their folder` : ''}`);
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

async function playTrack(id, queueIds, { shuffle = false } = {}) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  state.queue = queueIds?.length ? [...queueIds] : [id];
  state.qi = Math.max(0, state.queue.indexOf(id));
  if (state.settings.shuffle || shuffle) shuffleQueue();
  await loadCurrent();
}

async function loadCurrent() {
  const id = state.queue[state.qi];
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  let blob;
  try {
    blob = await lib.getAudio(track);
  } catch (err) {
    // A linked folder that lapsed is fixable, and saying how is the whole point.
    toast(err instanceof source.NeedsPermissionError
      ? `${err.message} — Settings → Linked folders`
      : err.message, 'err');
    return;
  }
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
  $$('#p-shuffle,#now-shuffle').forEach((b) => b.classList.toggle('is-on', state.settings.shuffle));
  $$('#p-repeat,#now-repeat').forEach((b) => {
    b.classList.toggle('is-on', state.settings.repeat !== 'off');
    b.textContent = state.settings.repeat === 'one' ? '↻1' : '↻';
  });

  // The transport and the phone Now-playing screen drive the same player, so
  // every control exists twice and both copies show the same state.
  for (const [a, b] of [['#p-play', '#now-play'], ['#p-next', '#now-next'], ['#p-prev', '#now-prev'],
    ['#p-shuffle', '#now-shuffle'], ['#p-repeat', '#now-repeat']]) {
    $(b).addEventListener('click', () => $(a).click());
  }
  $('#p-play').addEventListener('click', () => player.toggle());
  $('#p-next').addEventListener('click', () => playNext(1));
  $('#p-prev').addEventListener('click', () => (player.position > 3 ? player.seek(0) : playNext(-1)));
  $('#p-vol').addEventListener('input', (e) => {
    player.setVolume(+e.target.value);
    db.setSetting('volume', +e.target.value);
  });
  bindWave();
  $('#p-shuffle').addEventListener('click', async () => {
    const on = !state.settings.shuffle;
    await db.setSetting('shuffle', on);
    $$('#p-shuffle,#now-shuffle').forEach((b) => b.classList.toggle('is-on', on));
    if (on) shuffleQueue();
  });
  $('#p-repeat').addEventListener('click', async () => {
    const next = { off: 'all', all: 'one', one: 'off' }[state.settings.repeat];
    await db.setSetting('repeat', next);
    $$('#p-repeat,#now-repeat').forEach((b) => {
      b.classList.toggle('is-on', next !== 'off');
      b.textContent = next === 'one' ? '↻1' : '↻';
    });
  });

  // Tapping the mini player opens the second screen; ⌄ and Escape close it.
  // The target is the whole bar, not just .t-now: at phone widths the controls
  // squeeze that down to the cover and a clipped title, which is not something
  // you find by accident. Anything you can actually operate is excluded.
  $('#player').addEventListener('click', (e) => {
    if (e.target.closest('button,input,label,.wave')) return;
    openNow(true);
  });
  $('#now-close').addEventListener('click', () => openNow(false));
  $('#now-more').addEventListener('click', () => player.track && openTrackDialog(player.track.id));
  // Growing past the fold leaves the phone screen stranded over a desktop layout.
  window.addEventListener('resize', debounce(() => {
    if (!isPhone()) openNow(false);
    measureMarquees();
  }, 200));

  player.on('track', () => { bar.hidden = false; });
  player.on('play', () => { setPlayLabel(true); setSpin(true); syncMeter(); });
  player.on('pause', () => { setPlayLabel(false); setSpin(false); syncMeter(); });
  player.on('ended', () => playNext(1, true));
  player.on('error', () => toast('Playback error — the file may be corrupt', 'err'));
  player.on('timeupdate', () => {
    const d = player.duration, p = player.position;
    $('#p-cur').textContent = fmtTime(p);
    $('#p-dur').textContent = fmtTime(d);
    $('#now-cur').textContent = fmtTime(p);
    $('#now-dur').textContent = fmtTime(d);
    paintWave(d ? p / d : 0);
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

/* ------------------------------- waveform -------------------------------- */

/**
 * The scrubber draws the track's measured momentary-loudness envelope (stored
 * by the analysis pass). A track that has not been analyzed gets a flat strip
 * rather than an invented shape — it still scrubs, it just claims nothing.
 *
 * There are two: the transport's, and the phone Now-playing screen's wider one.
 * They share the envelope but keep their own bars and their own fill cursor.
 */
const waves = [];

function addWave(sel, count) {
  const box = $(sel);
  if (!box) return;
  waves.push({ box, count, bars: [], filled: -1 });
  const seekTo = (clientX) => {
    const d = player.duration;
    if (!d) return;
    const r = box.getBoundingClientRect();
    player.seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d);
  };
  box.addEventListener('click', (e) => seekTo(e.clientX));
  box.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') { e.preventDefault(); player.seek(player.position + step); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); player.seek(Math.max(0, player.position - step)); }
  });
}

function renderWave(track) {
  const env = track?.loudness?.envelope;
  const n = env?.length || 0;
  for (const w of waves) {
    w.box.classList.toggle('flat', !n);
    w.box.replaceChildren(...Array.from({ length: w.count }, (_, i) => {
      const bar = document.createElement('i');
      const v = n ? env[Math.min(n - 1, Math.floor((i / w.count) * n))] / 255 : 0.34;
      bar.style.height = `${Math.max(6, v * 100)}%`;
      return bar;
    }));
    w.bars = [...w.box.children];
    w.filled = -1;
  }
  paintWave(0);
}

function paintWave(frac) {
  const f = Math.max(0, Math.min(1, frac));
  for (const w of waves) {
    const n = Math.round(f * w.count);
    if (n === w.filled) continue;
    const [lo, hi] = w.filled < 0 ? [0, w.count] : [Math.min(n, w.filled), Math.max(n, w.filled)];
    for (let i = lo; i < hi; i++) w.bars[i]?.classList.toggle('on', i < n);
    w.filled = n;
    w.box.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }
}

function bindWave() {
  addWave('#p-wave', 96);
  addWave('#now-wave', 60);   // the design's phone screen draws 60
  renderWave(null);
}

/* ------------------------------ live meter ------------------------------- */

/**
 * The record hero carries a live output meter while something is playing. It
 * reads real FFT magnitudes tapped off the playback graph *after* normalization
 * gain, so it shows what you actually hear. Bars are log-spaced across the bins
 * — linear spacing would bunch everything audible into the first two bars.
 */
const METER_BARS = 26;
const METER_REST = 6;   // % height with no signal
/** Bar i covers bins [EDGES[i], EDGES[i+1]) of the 128-bin FFT. */
const METER_EDGES = Array.from({ length: METER_BARS + 1 }, (_, i) => Math.round(110 ** (i / METER_BARS)));

let meterBars = [];
let meterRaf = 0;
let meterData = null;

function meterOn() {
  // offsetParent is null whenever the meter is display:none — which covers the
  // record being closed, the narrow layout and reduced-motion in one test.
  return !!state.settings.liveMeter && player.playing && !!$('#hero-meter')?.offsetParent;
}

/** Start or stop the meter to match what is on screen and what is playing. */
function syncMeter() {
  const box = $('#hero-meter');
  if (!box) { stopMeter(); return; }
  if (box.childElementCount !== METER_BARS) {
    box.replaceChildren(...Array.from({ length: METER_BARS }, () => document.createElement('i')));
  }
  meterBars = [...box.children];
  if (meterOn()) startMeter();
  else stopMeter();
}

function startMeter() {
  if (meterRaf) return;
  const tick = () => {
    meterRaf = requestAnimationFrame(tick);
    const an = player.analyser();
    if (!an) return;
    if (meterData?.length !== an.frequencyBinCount) meterData = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(meterData);
    const lit = Math.round((player.duration ? player.position / player.duration : 0) * METER_BARS);
    for (let i = 0; i < METER_BARS; i++) {
      const to = Math.max(METER_EDGES[i] + 1, METER_EDGES[i + 1]);
      let peak = 0;
      for (let b = METER_EDGES[i]; b < to && b < meterData.length; b++) if (meterData[b] > peak) peak = meterData[b];
      meterBars[i].style.height = `${Math.max(METER_REST, (peak / 255) * 100)}%`;
      meterBars[i].classList.toggle('on', i < lit);
    }
  };
  meterRaf = requestAnimationFrame(tick);
}

function stopMeter() {
  if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = 0; }
  for (const bar of meterBars) { bar.style.height = `${METER_REST}%`; bar.classList.remove('on'); }
}

/** `press` is the shape — with a cover in place the artwork is cut to a record
 *  face, which is what makes the rotation visible at all. `spin` only runs the
 *  animation, so pausing freezes the record where it stands instead of snapping
 *  the cover back to a square. */
const setSpin = (on) => {
  const s = state.settings;
  for (const box of [$('#p-art-box'), $('#now-art-box')]) {
    // Two switches: `press` is the vinyl shape, `spin` is the rotation. Turning
    // the cover off leaves the grooves turning over a square, which is what the
    // app did before the record face existed.
    box?.classList.toggle('press', !!s.spinDisc && !!s.discCover);
    box?.classList.toggle('spin', !!s.spinDisc && !!on);
  }
};

/** The transport spells it out; the phone screen's 66px square uses glyphs. */
function setPlayLabel(playing) {
  $('#p-play').textContent = playing ? 'Pause' : 'Play';
  $('#now-play').textContent = playing ? '▮▮' : '▶';
}

/* -------------------------------- marquee --------------------------------- */

/* Whether a title fits its box is a measured fact, and CSS cannot measure it —
   so the class and the travel distance are set from here and the stylesheet
   only draws. Live marquees are kept so a rotation or a fold re-measures them. */
const marquees = new Set();

/** Put `text` in `el` (a .marquee) and slide it if it does not fit. */
function setMarquee(el, text) {
  if (!el) return;
  let span = el.firstElementChild;
  if (!span || span.tagName !== 'SPAN') {
    el.textContent = '';
    span = el.appendChild(document.createElement('span'));
  }
  span.textContent = text ?? '';
  el.title = text ?? '';
  marquees.add(el);
  measureMarquee(el);
}

function measureMarquee(el) {
  const span = el.firstElementChild;
  if (!span) return;
  // The animation's transform is part of what scrollWidth reports, so it has to
  // come off before the box is measured.
  el.classList.remove('is-scrolling');
  const box = el.clientWidth;
  if (!box) return; // hidden — openNow() and the resize hook measure it later
  const shift = span.scrollWidth - box;
  if (shift <= 2) return;
  el.style.setProperty('--mq-shift', `${shift}px`);
  // A steady ~34 px/s across the moving 68% of the cycle — the rest is the hold
  // at each end. Long titles take longer rather than travelling faster.
  el.style.setProperty('--mq-dur', `${Math.max(4, shift / 34 / 0.68).toFixed(1)}s`);
  el.classList.add('is-scrolling');
}

const measureMarquees = () => { for (const el of marquees) measureMarquee(el); };

/* --------------------------- now playing (phone) -------------------------- */

/** The design's second screen only exists at phone widths — on desktop the
 *  transport and the record hero already say everything it would. */
const isPhone = () => window.matchMedia('(max-width: 860px)').matches;

function openNow(show) {
  const on = !!show && !!player.track && isPhone();
  const el = $('#now');
  el.hidden = !on;
  // Focus the screen itself, not its close button: a control would take a
  // visible ring the moment it is focused from script.
  if (on) { el.focus({ preventScroll: true }); measureMarquees(); }
}

/** Everything on the screen that depends on which track is loaded. */
async function renderNow(track, gain) {
  const el = $('#now');
  const tint = tintOf(track.albumKey);
  el.style.setProperty('--wash', tint.wash);
  $('#now-art-box').style.setProperty('--cover', tint.cover);

  $('#now-record').textContent = track.album;
  setMarquee($('#now-track'), track.title);
  $('#now-artist').textContent = track.artist;
  $('#now-cap-title').textContent = track.album;
  const total = state.tracks.filter((t) => t.albumKey === track.albumKey).length;
  $('#now-cap-sub').textContent = track.trackNo ? `Track ${track.trackNo} of ${total}` : `${total} tracks`;
  // The design prints a fixed "24-BIT 44,1kHZ" here; this is the file's own.
  // Some codec names already carry the depth ("PCM 16-bit") — don't say it twice.
  const codec = track.codec || track.container || '';
  $('#now-format').textContent = [
    track.bits && !/\d+[- ]?bit/i.test(codec) ? `${track.bits}-bit` : '',
    track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : '',
    codec,
  ].filter(Boolean).join(' · ');
  $('#now-gain').textContent = `${fmtDb(gain.gainDb)} dB`;
  $('#now-queue').textContent = state.queue.length > 1 ? `${state.qi + 1} / ${state.queue.length}` : '';

  const img = $('#now-art');
  const url = await artUrl(track.artId, 'full');
  if (url) { img.src = url; img.classList.remove('is-empty'); }
  else { img.removeAttribute('src'); img.classList.add('is-empty'); }
}

/** Stop and pack the transport away — nothing is playing, so nothing should show. */
function stopPlayback() {
  player.stop();
  $('#player').hidden = true;
  openNow(false);
  setSpin(false);
  stopMeter();
  renderWave(null);
}

async function updatePlayerUI(track, gain) {
  $('#player').hidden = false;
  setMarquee($('#p-title'), track.title);
  $('#p-sub').textContent = `${track.artist} · ${track.album}`;
  $('#p-gain').textContent = `${fmtDb(gain.gainDb)} dB`;
  $('#p-gain').title = gain.basis === 'off'
    ? 'Normalization is off'
    : `${gain.basis} normalization · wanted ${fmtDb(gain.wanted)} dB${gain.limitedBy === 'peak' ? ' · reduced to stay under the true-peak ceiling' : ''}`;

  const box = $('#p-art-box');
  box.style.setProperty('--cover', tintOf(track.albumKey).cover);
  const img = $('#p-art');
  const url = await artUrl(track.artId, 'full');
  if (url) { img.src = url; img.classList.remove('is-empty'); }
  else { img.removeAttribute('src'); img.classList.add('is-empty'); }
  renderWave(track);
  setSpin(player.playing);
  await renderNow(track, gain);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: url ? [{ src: url, sizes: `${state.settings.artSize}x${state.settings.artSize}` }] : [],
    });
  }
}

/* ============================== track dialog ============================== */

/** Where this track's audio actually is — the one thing the dialog could not
 *  say before, and the thing that decides what deleting it means. */
function sourceLabel(t) {
  if (t.needsAudio) return '<span class="muted">restored without its audio — re-import the file to reattach it</span>';
  if (t.needsRelink) return '<span class="muted">waiting for its folder to be linked again</span>';
  if (t.source === 'folder') {
    const folder = state.folders.find((f) => f.id === t.folderId);
    return `linked · ${escapeHtml(folder?.name || 'folder')}/${escapeHtml(t.relPath || '')}`;
  }
  return `in this browser${t.hasOriginal ? ' · the original is kept alongside it' : ''}`;
}

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
      <div class="tile" style="--cover:${tintOf(t.albumKey).cover}">
        ${art ? `<img src="${art}" alt="">` : ''}
        <div class="tile-cap"><b>${escapeHtml(t.album || '')}</b><span>${escapeHtml(t.codec || t.container || '')}</span></div>
      </div>
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
      <div>Stored</div><div>${sourceLabel(t)}</div>
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
      ${lib.canRestore(t) ? '<button class="btn" data-act="restore">Restore original</button>' : ''}
      <button class="btn" data-act="send">Send…</button>
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
    if (act === 'send') { dlg.close(); sendTracks([t.id], t.title); return; }
    if (act === 'restore') {
      dlg.close();
      const ctrl = progressStart('Restoring original');
      try { await lib.restoreOriginal(t); await reload(); toast('Original restored'); }
      catch (err) { toast(err.message, 'err'); }
      finally { ctrl.done(); }
      return;
    }
    if (act === 'download') {
      const blob = await lib.getAudio(t).catch((err) => { toast(err.message, 'err'); return null; });
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

  /* -- appearance: applied to :root immediately, persisted on release -- */
  renderSwatches();
  $('#set-accent').addEventListener('click', async (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw?.dataset.hex) return;          // the custom swatch is handled below
    await db.setSetting('accent', sw.dataset.hex);
    applyTheme();
    renderSwatches();
  });
  // Live-preview while dragging the picker; persist (and redraw the row, which
  // would tear the open picker down) only once it is committed.
  $('#set-accent').addEventListener('input', (e) => {
    if (e.target.type !== 'color') return;
    s().accent = e.target.value;
    applyTheme();
  });
  $('#set-accent').addEventListener('change', async (e) => {
    if (e.target.type !== 'color') return;
    await db.setSetting('accent', e.target.value);
    applyTheme();
    renderSwatches();
  });
  const haze = $('#set-haze');
  haze.addEventListener('input', () => {
    s().haze = +haze.value;
    $('#set-haze-val').textContent = `${Math.round(s().haze * 100)} %`;
    applyTheme();
  });
  haze.addEventListener('change', () => db.setSetting('haze', +haze.value));
  // The tint is baked into each tile's inline --cover, so the lists have to redraw.
  bindCheck('#set-tint', 'tintedCovers', renderAll);
  bindCheck('#set-spin', 'spinDisc', () => setSpin(player.playing));
  bindCheck('#set-disc-cover', 'discCover', () => setSpin(player.playing));
  bindCheck('#set-phone-cols', 'phoneColumns', applyTheme);
  bindCheck('#set-meter', 'liveMeter', () => syncMeter());

  /* -- backdrop -- */
  renderBackdrops();
  $('#set-backdrop').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-backdrop]');
    if (!btn) return;
    await db.setSetting('backdrop', btn.dataset.backdrop);
    applyTheme();
    renderBackdrops();
    // Picking "Image" with nothing chosen yet would just look broken, so go
    // straight to the picker.
    if (btn.dataset.backdrop === 'image' && !state.settings.backdropImage) pickBackdrop();
  });
  $('#btn-backdrop-pick').addEventListener('click', pickBackdrop);
  $('#btn-backdrop-clear').addEventListener('click', async () => {
    await db.setSetting('backdropImage', null);
    applyBackdropImage();
    toast('Backdrop image removed');
  });
  const dim = $('#set-backdrop-dim');
  dim.addEventListener('input', () => {
    s().backdropDim = +dim.value;
    $('#set-backdrop-dim-val').textContent = `${Math.round(s().backdropDim * 100)} %`;
    applyTheme();
  });
  dim.addEventListener('change', () => db.setSetting('backdropDim', +dim.value));
  bindCheck('#set-backdrop-mono', 'backdropMono', applyTheme);

  $('#btn-persist').addEventListener('click', async () => {
    if (!navigator.storage?.persist) { toast('Not supported in this browser', 'err'); return; }
    const ok = await navigator.storage.persist();
    toast(ok ? 'Storage is now persistent' : 'The browser declined persistent storage', ok ? '' : 'err');
    updateStorageInfo();
  });

  /* -- backup -- */
  $('#set-backup-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    state.backupScope = btn.dataset.scope;
    $$('#set-backup-scope button').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    updateBackupEstimate();
  });
  $('#set-backup-originals').addEventListener('change', updateBackupEstimate);
  $('#btn-backup').addEventListener('click', runBackup);
  $('#btn-restore').addEventListener('click', () => $('#backup-input').click());
  $('#backup-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await openRestoreDialog(file);
  });

  /* -- linked folders -- */
  $('#folder-list').addEventListener('click', onFolderListClick);
  $('#btn-link-folder').addEventListener('click', linkFolder);

  $('#btn-export').addEventListener('click', async () => {
    const tracks = (await lib.allTracks()).map(({ loudness, ...t }) => ({
      ...t,
      loudness: loudness ? { ...loudness, hist: undefined, envelope: undefined } : null,
    }));
    // The backdrop picture is a Blob — it would serialize as {}, so it is named
    // rather than dumped.
    const { backdropImage, ...settings } = state.settings;
    settings.backdropImage = backdropImage ? `<image, ${fmtBytes(backdropImage.size)}>` : null;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings, tracks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'offline-music-library.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  $('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Delete every track, cover and folder link stored by this app?\n\n'
      + 'Files inside a linked folder are not touched — only the link to them.')) return;
    stopPlayback();
    await db.wipe();
    source.forgetCache();
    state.selected.clear();
    await reload();
    toast('Library deleted');
  });
}

/* ============================ backup / restore ============================ */

const backupOptions = () => ({
  includeAudio: state.backupScope === 'full',
  includeOriginals: $('#set-backup-originals')?.checked ?? true,
});

/** Say how big this is going to be *before* the file picker opens. It reads
 *  every track and cover record to do it, so it only runs while the panel that
 *  shows it is actually on screen — not on every library redraw. */
async function updateBackupEstimate() {
  const el = $('#backup-estimate');
  if (!el || state.view !== 'settings') return;
  try {
    const est = await archive.estimate(backupOptions());
    const parts = [`about ${fmtBytes(est.bytes)}`, `${est.tracks} track${est.tracks === 1 ? '' : 's'}`];
    if (est.art) parts.push(`${est.art} cover${est.art === 1 ? '' : 's'}`);
    if (est.linked) parts.push(`${est.linked} linked (recorded, not copied)`);
    el.textContent = parts.join(' · ');
  } catch { el.textContent = '—'; }
}

async function runBackup() {
  if (!state.tracks.length) { toast('Nothing to back up yet'); return; }
  const ctrl = progressStart('Writing backup');
  try {
    const res = await archive.exportLibrary({
      ...backupOptions(),
      settings: state.settings,
      signal: ctrl.signal,
      onProgress: (p, sub) => ctrl.set(p, sub),
    });
    toast(res.via === 'file'
      ? `Backup written · ${res.entries} entries`
      : `Backup downloaded as ${res.name}`);
  } catch (err) {
    if (err?.name === 'AbortError') toast('Backup cancelled');
    else toast(`Backup failed: ${err.message}`, 'err');
  } finally { ctrl.done(); }
}

/* ================================= sending ================================ */

/** Can this browser put a *file* into the OS share sheet? Chrome and Edge can
 *  on Android and Windows, Safari can on iOS. Firefox and Linux cannot, and
 *  there the bundle is simply saved and sent by whatever you already use. */
const canShareFiles = (file) => {
  try { return !!navigator.canShare?.({ files: [file] }) && !!navigator.share; }
  catch { return false; }
};

/**
 * Pack tracks into a bundle and offer it to whatever can carry it.
 *
 * The build and the send are deliberately two steps. `navigator.share` has to
 * be called from a user gesture, and packing a few hundred megabytes takes far
 * longer than a gesture survives — so the file is made first, behind the
 * progress bar, and the dialog's own button is the gesture that sends it.
 */
async function sendTracks(ids, label) {
  if (!ids.length) { toast('Nothing to send'); return; }
  // Linked audio is read out of its folder and packed in, so the only tracks
  // that cannot travel whole are the ones this device cannot read at all.
  const hollow = state.tracks.filter((t) => ids.includes(t.id) && (t.needsAudio || t.needsRelink)).length;
  if (hollow) {
    toast(`${hollow} track${hollow === 1 ? '' : 's'} have no audio on this device and will go as measurements only`);
  }

  const ctrl = progressStart(`Packing ${label}`);
  let file;
  try {
    file = await archive.buildBundle(ids, {
      settings: state.settings,
      title: label,
      signal: ctrl.signal,
      onProgress: (p, sub) => ctrl.set(p, sub),
    });
  } catch (err) {
    if (err?.name !== 'AbortError') toast(`Could not pack that: ${err.message}`, 'err');
    return;
  } finally { ctrl.done(); }

  openSendDialog(file, label, ids.length);
}

/** What to do with the packed bundle. Both buttons act inside their own click. */
function openSendDialog(file, label, count) {
  const dlg = $('#dlg');
  const shareable = canShareFiles(file);

  dlg.innerHTML = `<div class="dlg-body">
    <h3>Send ${escapeHtml(label)}</h3>
    <p class="muted small">${count} track${count === 1 ? '' : 's'} · ${fmtBytes(file.size)} ·
    ${escapeHtml(file.name)}</p>
    <p class="hint">The bundle carries the audio, the covers and every loudness and quality
    measurement. Whoever opens it in Offpress gets the record fully analyzed, and anything
    they already have is skipped. It is an ordinary .zip, so it travels by any means you
    like.</p>
    ${shareable ? '' : `<p class="hint">This browser cannot hand a file to the system share
    sheet, so save it and send it however you normally would.</p>`}
    <div class="actions">
      ${shareable ? '<button class="btn primary" data-act="share">Share…</button>' : ''}
      <button class="btn${shareable ? '' : ' primary'}" data-act="save">Save as a file…</button>
      <div class="grow"></div>
      <button class="btn" data-act="close">Cancel</button>
    </div>
  </div>`;

  dlg.onclick = async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); return; }
    if (act === 'share') {
      // Inside the click, with the file already in hand — no await before this.
      try {
        await navigator.share({ files: [file], title: label });
        dlg.close();
      } catch (err) {
        if (err?.name !== 'AbortError') toast(`Share failed: ${err.message}`, 'err');
      }
      return;
    }
    if (act === 'save') {
      dlg.close();
      try {
        const via = await saveStream(file.stream(), file.name, {
          types: [{ description: 'Offpress bundle', accept: { 'application/zip': ['.zip'] } }],
        });
        toast(via === 'file' ? 'Bundle written' : `Bundle downloaded as ${file.name}`);
      } catch (err) {
        if (err?.name !== 'AbortError') toast(`Could not save it: ${err.message}`, 'err');
      }
    }
  };
  dlg.showModal();
}

/**
 * Read the manifest, describe what is in the file, then ask how to bring it in.
 * Resolves once the restore has actually finished, so two archives dropped
 * together are handled one after the other rather than at the same time.
 */
async function openRestoreDialog(file) {
  let manifest;
  try {
    ({ manifest } = await archive.inspect(file));
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const c = manifest.counts || {};
  const bundle = manifest.kind === 'bundle';
  const when = manifest.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : 'an unknown date';
  const what = bundle && manifest.title ? manifest.title : file.name;

  const describe = `${escapeHtml(what)} — ${c.tracks || 0} track${c.tracks === 1 ? '' : 's'}, `
    + `${c.albums || 0} record${c.albums === 1 ? '' : 's'}, ${c.art || 0} cover${c.art === 1 ? '' : 's'}, `
    + `written by v${escapeHtml(manifest.appVersion || '?')} on ${escapeHtml(when)}. `
    + (manifest.includesAudio
      ? 'It carries the audio, and every loudness and quality measurement with it.'
      : 'This is a measurements-only archive — tracks come in without their audio and reattach when you import the files.');

  // Replacing your library with somebody else's record would be a catastrophe,
  // so a shared bundle can only ever merge. A backup of your own can do either.
  const fields = bundle ? [] : [
    {
      key: 'replace',
      label: `Replace what is here (${state.tracks.length} track${state.tracks.length === 1 ? '' : 's'}) instead of merging into it`,
      type: 'checkbox',
      value: false,
    },
    { key: 'restoreSettings', label: 'Also restore the settings from the backup', type: 'checkbox', value: false },
  ];

  const { closed } = formDialog({
    title: bundle ? 'Add shared record' : 'Restore from backup',
    hint: bundle
      ? `${describe} Anything you already have is skipped by content hash.`
      : describe,
    saveLabel: bundle ? 'Add to library' : 'Restore',
    fields,
    async onSave({ replace = false, restoreSettings = false }) {
      if (replace && !confirm('Delete the current library first?\n\nEverything in it is removed before the backup is read. This cannot be undone.')) return;
      const ctrl = progressStart('Restoring');
      try {
        if (replace) stopPlayback();
        const res = await archive.restoreLibrary(file, {
          mode: replace ? 'replace' : 'merge',
          restoreSettings,
          signal: ctrl.signal,
          onProgress: (p, sub) => ctrl.set(p, sub),
        });
        if (restoreSettings) {
          state.settings = await db.settings();
          applyTheme();
          applyBackdropImage();
          applySettingsToUI();
          player.setVolume(state.settings.volume);
          player.setLimiter(state.settings.limiter);
        }
        await lib.refreshAllAlbums();
        await reload();
        const bits = [`${res.added} ${bundle ? 'added' : 'restored'}`];
        if (res.skipped) bits.push(`${res.skipped} already here`);
        if (res.missingAudio) bits.push(`${res.missingAudio} awaiting audio`);
        if (res.relink) bits.push(`${res.relink} awaiting a folder link`);
        if (res.failed.length) bits.push(`${res.failed.length} failed`);
        toast(bits.join(' · '), res.failed.length ? 'err' : '');
        if (res.failed.length) console.warn('Restore problems', res.failed);
      } catch (err) {
        toast(`Restore failed: ${err.message}`, 'err');
      } finally { ctrl.done(); }
    },
  });
  await closed;
}

function renderBackdrops() {
  const cur = state.settings.backdrop || 'none';
  $('#set-backdrop').innerHTML = db.BACKDROPS.map((b) =>
    `<button type="button" role="radio" aria-checked="${b.key === cur}" data-backdrop="${b.key}"
             class="${b.key === cur ? 'is-active' : ''}">${b.label}</button>`).join('');
  // The image controls are noise unless the image backdrop is the one selected.
  $('#backdrop-image-fields').classList.toggle('hidden', cur !== 'image');
}

/** Choose the window backdrop picture. Downscaled on the way in, then kept in
 *  settings like any other preference — it never leaves the device. */
function pickBackdrop() {
  const input = $('#img-input');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const ctrl = progressStart('Preparing backdrop');
    try {
      await db.setSetting('backdropImage', await normalizeBackdrop(file));
      // Choosing a picture is the intent to use it.
      if (state.settings.backdrop !== 'image') await db.setSetting('backdrop', 'image');
      applyTheme();
      applyBackdropImage();
      renderBackdrops();
      toast('Backdrop saved');
    } catch (err) {
      toast(`Backdrop failed: ${err.message}`, 'err');
    } finally { ctrl.done(); }
  };
  input.click();
}

function renderSwatches() {
  const cur = String(state.settings.accent).toLowerCase();
  const known = db.ACCENTS.some((a) => a.hex.toLowerCase() === cur);
  $('#set-accent').innerHTML = db.ACCENTS.map((a) =>
    `<button class="swatch${a.hex.toLowerCase() === cur ? ' is-active' : ''}" style="--hex:${a.hex}"
             data-hex="${a.hex}" title="${a.label}" aria-label="Accent: ${a.label}"></button>`).join('')
    + `<label class="swatch custom${known ? '' : ' is-active'}" style="--hex:${known ? db.DEFAULTS.accent : cur}"
              title="Custom colour">
         <input type="color" id="set-accent-custom" value="${known ? db.DEFAULTS.accent : cur}" aria-label="Custom accent colour">
       </label>`;
}

function applySettingsToUI() {
  const s = state.settings;
  $('#set-haze').value = s.haze;
  $('#set-haze-val').textContent = `${Math.round(s.haze * 100)} %`;
  $('#set-tint').checked = s.tintedCovers;
  $('#set-spin').checked = s.spinDisc;
  $('#set-disc-cover').checked = s.discCover;
  $('#set-phone-cols').checked = s.phoneColumns;
  $('#set-meter').checked = s.liveMeter;
  $('#set-backdrop-mono').checked = s.backdropMono;
  $('#set-backdrop-dim').value = s.backdropDim;
  $('#set-backdrop-dim-val').textContent = `${Math.round(s.backdropDim * 100)} %`;
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
  $('#p-repeat').textContent = s.repeat === 'one' ? '↻1' : '↻';
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
  const linked = state.tracks.filter((t) => t.source === 'folder');
  if (linked.length) {
    parts.push(`${linked.length} linked (${fmtBytes(linked.reduce((a, t) => a + (t.size || 0), 0))} read in place, not stored)`);
  }
  el.textContent = parts.join(' · ');
  updateBackupEstimate();
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
