/** End-to-end checks driving the real app in headless Chrome: album opening,
 *  folder ordering, sort modes, drag-to-reorder and album rename.
 *  Starts its own server.  Run with:  node tests/ui.test.mjs  */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitFor, findBrowser } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!findBrowser()) {
  console.log('SKIP  no Chrome/Edge found (set CHROME_PATH to run the UI tests)');
  process.exit(0);
}

/** Boot the static server on an OS-assigned port and read back its URL. */
const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '0'], { cwd: ROOT });
const origin = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
  server.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});
console.log(`server on ${origin}`);

const URL = `${origin}/index.html`;
const page = await launch(URL);
let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const bootWait = () => waitFor(page, `document.querySelector('#build-info')?.textContent?.length > 0`, { label: 'app boot' });

// Page-side helper: build synthetic WAV files with a folder path.
const MAKE_FILES = `
window.__mk = async (folder, names) => {
  const { encodeWav } = await import('./js/audio/wav.js');
  const rate = 44100, n = rate;
  return names.map((name, i) => {
    const ch = new Float32Array(n);
    for (let s = 0; s < n; s++) ch[s] = 0.2 * Math.sin(2 * Math.PI * (200 + i * 50) * s / rate);
    const f = new File([encodeWav([ch, ch], rate, 16)], name, { type: 'audio/wav' });
    Object.defineProperty(f, 'relPath', { value: folder + '/' + name, enumerable: true });
    return f;
  });
};`;

try {
  await bootWait();
  await page.evaluate(async () => { const db = await import('./js/db.js'); await db.wipe(); });
  await page.goto(URL);
  await bootWait();
  console.log('--- clean start ---\n');

  /* ---------- 1. clicking an album opens it (the reported bug) ---------- */
  await page.evaluate(MAKE_FILES);
  await page.evaluate(async () => {
    const files = await window.__mk('Night Tapes', ['03 gamma.wav', '01 alpha.wav', '10 delta.wav', '2 beta.wav']);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const input = document.querySelector('#file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await waitFor(page, `document.querySelectorAll('#track-list .track').length === 4`, { timeout: 90000, label: '4 tracks imported' });

  const opened = await page.evaluate(() => {
    document.querySelector('.tab[data-view="albums"]').click();
    const card = document.querySelector('#album-grid .album');
    card.click();
    const detail = document.querySelector('#album-detail');
    return {
      cardTitle: card.querySelector('.a1').textContent,
      hidden: detail.classList.contains('hidden'),
      title: detail.querySelector('h2')?.textContent,
      tracks: [...detail.querySelectorAll('.track .t1')].map((e) => e.textContent.trim()),
      backVisible: !document.querySelector('#btn-album-back').classList.contains('hidden'),
    };
  });
  ok('clicking an album opens its track list', !opened.hidden && opened.tracks.length === 4);
  ok('back button appears', opened.backVisible);

  /* ---------- 2. album name comes from the folder, order is folder order ---------- */
  eq('album is named after its folder', opened.title, 'Night Tapes');
  eq('default order is natural folder order', opened.tracks, ['01 alpha', '2 beta', '03 gamma', '10 delta']);

  /* ---------- 3. switching the sort mode ----------
     Give the tracks titles and track numbers that disagree with the file order,
     so each mode produces a visibly different result. */
  await page.evaluate(async () => {
    const dbm = await import('./js/db.js');
    const lib = await import('./js/library.js');
    const tracks = lib.sortAlbumTracks(await dbm.getAll('tracks'), { sortMode: 'folder' });
    const titles = ['Zulu', 'Yankee', 'X-ray', 'Whiskey'];   // reverse alphabetical
    const trackNos = [4, 3, 2, 1];                            // reverse tag order
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].title = titles[i];
      tracks[i].trackNo = trackNos[i];
      await dbm.put('tracks', tracks[i]);
    }
  });
  await page.goto(URL);
  await bootWait();

  const orderIn = async (mode) => page.evaluate(`(async () => {
    document.querySelector('.tab[data-view="albums"]').click();
    if (document.querySelector('#album-detail').classList.contains('hidden')) {
      document.querySelector('#album-grid .album').click();
      await new Promise((r) => setTimeout(r, 200));
    }
    document.querySelector('#btn-album-config').click();   // the order lives in the config menu
    await new Promise((r) => setTimeout(r, 100));
    const sel = document.querySelector('#album-sort');
    sel.value = ${JSON.stringify(mode)};
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    return [...document.querySelectorAll('#album-tracks .track .t1')].map((e) => e.textContent.trim());
  })()`);

  eq('folder order follows the imported file order', await orderIn('folder'), ['Zulu', 'Yankee', 'X-ray', 'Whiskey']);
  eq('title order sorts alphabetically', await orderIn('title'), ['Whiskey', 'X-ray', 'Yankee', 'Zulu']);
  eq('track-number order uses the tags', await orderIn('track'), ['Whiskey', 'X-ray', 'Yankee', 'Zulu']);
  eq('switching back restores folder order', await orderIn('folder'), ['Zulu', 'Yankee', 'X-ray', 'Whiskey']);

  /* ---------- 4. custom order persists across a reload ---------- */
  const reversed = await page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    const albums = await dbm.getAll('albums');
    const key = albums[0].key;
    const tracks = (await dbm.getAll('tracks')).filter((t) => t.albumKey === key);
    const ids = lib.sortAlbumTracks(tracks, { sortMode: 'folder' }).map((t) => t.id).reverse();
    await lib.setAlbumOrder(key, ids);
    return { key, want: ids.map((id) => tracks.find((t) => t.id === id).title) };
  });
  await page.goto(URL);
  await bootWait();
  const afterReload = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="albums"]').click();
    document.querySelector('#album-grid .album').click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#btn-album-config').click();
    await new Promise((r) => setTimeout(r, 100));
    return {
      mode: document.querySelector('#album-sort')?.value,
      tracks: [...document.querySelectorAll('#album-tracks .track .t1')].map((e) => e.textContent.trim()),
    };
  });
  eq('custom order survives a reload', afterReload.tracks, reversed.want);
  eq('sort mode shows as custom', afterReload.mode, 'custom');

  /* ---------- 4b. dragging a row to reorder ---------- */
  const dragged = await page.evaluate(async () => {
    const rows = () => [...document.querySelectorAll('#album-tracks .track')];
    const before = rows().map((r) => r.querySelector('.t1').textContent.trim());
    const from = rows()[0];
    const onto = rows()[2];
    const dt = new DataTransfer();
    const fire = (el, type, extra = {}) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }));

    const box = onto.getBoundingClientRect();
    fire(from, 'dragstart');
    fire(onto, 'dragover', { clientX: box.x + 10, clientY: box.y + box.height - 2 }); // lower half → after
    fire(from, 'dragend');
    await new Promise((r) => setTimeout(r, 800));

    const dbm = await import('./js/db.js');
    const lib = await import('./js/library.js');
    const albums = await dbm.getAll('albums');
    const tracks = await dbm.getAll('tracks');
    const stored = lib.sortAlbumTracks(tracks, albums[0]).map((t) => t.title);
    return { before, after: rows().map((r) => r.querySelector('.t1').textContent.trim()), stored, mode: albums[0].sortMode };
  });
  const expectDrag = [dragged.before[1], dragged.before[2], dragged.before[0], dragged.before[3]];
  eq('dragging row 1 below row 3 moves it there', dragged.after, expectDrag);
  eq('the dragged order is persisted', dragged.stored, expectDrag);
  eq('dragging switches the album to custom order', dragged.mode, 'custom');

  /* ---------- 5. renaming the album ---------- */
  const renamed = await page.evaluate(async () => {
    document.querySelector('#btn-album-config').click();
    await new Promise((r) => setTimeout(r, 100));
    const menuOpen = !document.querySelector('#album-config').classList.contains('hidden');
    document.querySelector('#album-config [data-album-act="rename"]').click();
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('#f-name').value = 'Late Night Tapes';
    document.querySelector('#f-artist').value = 'The Quiet Type';
    document.querySelector('[data-act="save"]').click();
    await new Promise((r) => setTimeout(r, 1200));
    const dbm = await import('./js/db.js');
    const albums = await dbm.getAll('albums');
    const tracks = await dbm.getAll('tracks');
    return {
      menuOpen,
      albums: albums.map((a) => ({ key: a.key, name: a.name, artist: a.artist, order: a.order?.length })),
      trackAlbums: [...new Set(tracks.map((t) => t.album))],
      trackKeys: [...new Set(tracks.map((t) => t.albumKey))],
      shown: document.querySelector('#album-detail h2')?.textContent,
      order: [...document.querySelectorAll('#album-tracks .track .t1')].map((e) => e.textContent.trim()),
    };
  });
  ok('the album config button opens its menu', renamed.menuOpen);
  eq('exactly one album record remains', renamed.albums.length, 1);
  eq('album renamed', renamed.albums[0].name, 'Late Night Tapes');
  eq('album artist set', renamed.albums[0].artist, 'The Quiet Type');
  eq('every track carries the new album name', renamed.trackAlbums, ['Late Night Tapes']);
  eq('album key was rebuilt', renamed.trackKeys, ['the quiet type :: late night tapes']);
  eq('detail view shows the new name', renamed.shown, 'Late Night Tapes');
  eq('custom order survived the rename', renamed.order, expectDrag);

  /* ---------- 6. album still opens after rename (key change) ---------- */
  const reopened = await page.evaluate(async () => {
    document.querySelector('#btn-album-back').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#album-grid .album').click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      hidden: document.querySelector('#album-detail').classList.contains('hidden'),
      tracks: document.querySelectorAll('#album-tracks .track').length,
    };
  });
  ok('album reopens after the key change', !reopened.hidden && reopened.tracks === 4);

  /* ---------- 7. multi-select and bulk delete ---------- */
  const counts = await page.evaluate(async () => {
    const dbm = await import('./js/db.js');
    return { tracks: (await dbm.getAll('tracks')).length, blobs: (await dbm.getAll('blobs')).length };
  });
  eq('four tracks and four blobs to start', counts, { tracks: 4, blobs: 4 });

  const selection = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="tracks"]').click();
    document.querySelector('#btn-select').click();
    await new Promise((r) => setTimeout(r, 200));
    const rows = [...document.querySelectorAll('#track-list .track')];
    rows[0].click();                                                     // pick first
    rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // shift-extend to third
    await new Promise((r) => setTimeout(r, 200));
    return {
      barVisible: !document.querySelector('#selection-bar').classList.contains('hidden'),
      checkboxes: document.querySelectorAll('#track-list input.sel').length,
      countLabel: document.querySelector('#sel-count').textContent,
      pickedRows: document.querySelectorAll('#track-list .track.is-picked').length,
    };
  });
  ok('selection mode shows a checkbox on every row', selection.checkboxes === 4);
  ok('the selection bar appears', selection.barVisible);
  ok('shift-click selects the range', selection.pickedRows === 3, `(${selection.countLabel})`);

  const afterDelete = await page.evaluate(async () => {
    document.querySelector('#btn-sel-delete').click();
    await new Promise((r) => setTimeout(r, 2000));
    const dbm = await import('./js/db.js');
    const tracks = await dbm.getAll('tracks');
    const albums = await dbm.getAll('albums');
    return {
      tracks: tracks.length,
      blobs: (await dbm.getAll('blobs')).length,
      rows: document.querySelectorAll('#track-list .track').length,
      albumCount: albums[0]?.trackCount ?? 0,
      selectModeOff: document.querySelector('#selection-bar').classList.contains('hidden'),
    };
  });
  eq('three tracks deleted, one left', afterDelete.tracks, 1);
  eq('their audio blobs went with them', afterDelete.blobs, 1);
  eq('the list re-rendered', afterDelete.rows, 1);
  eq('the album track count updated', afterDelete.albumCount, 1);
  ok('selection mode closes after deleting', afterDelete.selectModeOff);
  ok('a confirmation was shown', page.dialogs.length === 1, `(${page.dialogs.at(-1)?.message.split('\n')[0]})`);

  /* ---------- 8. deleting a whole album ---------- */
  const afterAlbumDelete = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="albums"]').click();
    document.querySelector('#album-grid .album').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#btn-album-config').click();
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('#album-config [data-album-act="delete"]').click();
    await new Promise((r) => setTimeout(r, 2000));
    const dbm = await import('./js/db.js');
    return {
      tracks: (await dbm.getAll('tracks')).length,
      blobs: (await dbm.getAll('blobs')).length,
      albums: (await dbm.getAll('albums')).length,
      art: (await dbm.getAll('art')).length,
      backToGrid: document.querySelector('#album-detail').classList.contains('hidden'),
      emptyShown: !document.querySelector('#tracks-empty').classList.contains('hidden'),
    };
  });
  eq('album delete removed the last track', afterAlbumDelete.tracks, 0);
  eq('no orphaned blobs', afterAlbumDelete.blobs, 0);
  eq('the album record is gone', afterAlbumDelete.albums, 0);
  eq('orphaned artwork was swept', afterAlbumDelete.art, 0);
  ok('the view returns to the album grid', afterAlbumDelete.backToGrid);
  ok('the empty state comes back', afterAlbumDelete.emptyShown);

  /* ---------- 9. artwork belongs to the album it came from ----------
     Regression: two albums whose tags collide (both "Unknown Album", or the same
     artist with no album tag) used to share whichever cover was imported first,
     and the second album's own embedded cover was discarded. */
  const ART = `
    window.__png = async (color) => {
      const c = document.createElement('canvas'); c.width = c.height = 40;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 40, 40);
      return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    };
    window.__mp3 = (name, { title, artist, album, pic, folder }) => {
      const enc = (s) => [...s].map((ch) => ch.charCodeAt(0));
      const frame = (id, payload) => {
        const out = [...enc(id)]; const n = payload.length;
        out.push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255, 0, 0);
        return out.concat(payload);
      };
      let fr = [...frame('TIT2', [0, ...enc(title)])];
      if (artist) fr = fr.concat(frame('TPE1', [0, ...enc(artist)]));
      if (album) fr = fr.concat(frame('TALB', [0, ...enc(album)]));
      if (pic) fr = fr.concat(frame('APIC', [0, ...enc('image/png'), 0, 3, 0, ...pic]));
      const size = fr.length;
      const bytes = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0,
        (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127,
        ...fr, 0xff, 0xfb, 0x90, 0x00, ...new Array(300 + name.length * 13).fill(0)]);
      const f = new File([bytes], name, { type: 'audio/mpeg' });
      if (folder) Object.defineProperty(f, 'webkitRelativePath', { value: folder + '/' + name, enumerable: true });
      return f;
    };
    window.__artCase = async (tags1, tags2) => {
      const lib = await import('./js/library.js');
      const dbm = await import('./js/db.js');
      await dbm.wipe();
      const settings = await dbm.settings();
      const red = await window.__png('#dd2222');
      const blue = await window.__png('#2222dd');
      await lib.importFiles(['a1.mp3', 'a2.mp3'].map((n, i) =>
        window.__mp3(n, { title: 'One ' + i, pic: red, ...tags1 })), { settings });
      await lib.importFiles(['b1.mp3', 'b2.mp3', 'b3.mp3'].map((n, i) =>
        window.__mp3(n, { title: 'Two ' + i, pic: blue, ...tags2 })), { settings });
      const tracks = await dbm.getAll('tracks');
      const one = tracks.filter((t) => t.title.startsWith('One '));
      const two = tracks.filter((t) => t.title.startsWith('Two '));
      return {
        art: (await dbm.getAll('art')).length,
        oneIds: [...new Set(one.map((t) => t.artId))],
        twoIds: [...new Set(two.map((t) => t.artId))],
      };
    };`;
  await page.evaluate(ART);

  for (const [label, t1, t2] of [
    ['untagged files in two batches', {}, {}],
    ['same artist, neither has an album tag', { artist: 'Shared' }, { artist: 'Shared' }],
    ['properly tagged albums', { artist: 'A One', album: 'Al One' }, { artist: 'A Two', album: 'Al Two' }],
  ]) {
    const r = await page.evaluate(`window.__artCase(${JSON.stringify(t1)}, ${JSON.stringify(t2)})`);
    ok(`covers stay with their own album — ${label}`,
      r.oneIds.length === 1 && r.twoIds.length === 1 && r.oneIds[0] !== r.twoIds[0] && r.art === 2,
      `art=${r.art} one=${r.oneIds} two=${r.twoIds}`);
  }

  // ...while an album that embeds the same cover in every track still stores it once.
  const dedupe = await page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    await dbm.wipe();
    const settings = await dbm.settings();
    const png = await window.__png('#22aa55');
    await lib.importFiles([1, 2, 3, 4, 5].map((i) =>
      window.__mp3(`t${i}.mp3`, { title: `T${i}`, artist: 'Band', album: 'Record', pic: png })), { settings });
    const tracks = await dbm.getAll('tracks');
    return { art: (await dbm.getAll('art')).length, ids: [...new Set(tracks.map((t) => t.artId))].length };
  });
  ok('one shared cover is stored once, not five times',
    dedupe.art === 1 && dedupe.ids === 1, `art records=${dedupe.art}`);

  // Repair reassigns covers for a library that already went wrong.
  const repaired = await page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    const tracks = await dbm.getAll('tracks');
    const wrong = await lib.setTrackArt(tracks[0].id, new Blob([await window.__png('#ff00ff')], { type: 'image/png' }), await dbm.settings());
    const before = (await dbm.get('tracks', tracks[0].id)).artId;
    const res = await lib.repairArtwork(await dbm.settings());
    const after = (await dbm.get('tracks', tracks[0].id)).artId;
    return { changed: before !== after, wrongId: wrong.id, before, after, fixed: res.fixed, art: (await dbm.getAll('art')).length };
  });
  ok('repair restores the cover embedded in the file',
    repaired.changed && repaired.after !== repaired.wrongId, `fixed=${repaired.fixed}`);
  ok('repair sweeps the orphaned cover', repaired.art === 1, `art records=${repaired.art}`);

  /* ---------- 10. adding an album from a .zip through the UI ---------- */
  const zipRun = await page.evaluate(async () => {
    const dbm = await import('./js/db.js');
    await dbm.wipe();

    // Build a real ZIP in the page: stored entries, so no deflater is needed here.
    const enc = new TextEncoder();
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

    const parts = [], central = [];
    let offset = 0, count = 0;
    const png = await window.__png('#8844cc');
    for (let i = 1; i <= 3; i++) {
      const file = window.__mp3(`0${i} zipped.mp3`, { title: `Zip ${i}`, artist: 'Zip Band', album: 'Zipped Record', pic: png });
      const data = new Uint8Array(await file.arrayBuffer());
      const name = enc.encode(`Zipped Record/0${i} zipped.mp3`);
      const crc = crc32(data);
      const local = [...u32(0x04034b50), ...u16(20), ...u16(0x800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name];
      parts.push(new Uint8Array(local), data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
      offset += local.length + data.length;
      count++;
    }
    const cd = new Blob(central);
    const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count),
      ...u32(cd.size), ...u32(offset), ...u16(0)]);
    const zip = new File([...parts, cd, eocd], 'Zipped Record.zip', { type: 'application/zip' });

    // Feed it through the real "Add album → from .zip" input.
    const dt = new DataTransfer();
    dt.items.add(zip);
    const input = document.querySelector('#zip-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return { zipBytes: zip.size };
  });
  ok('a zip was built for the test', zipRun.zipBytes > 0);

  await waitFor(page, `document.querySelectorAll('#track-list .track').length === 3`,
    { timeout: 120000, label: '3 tracks imported from the zip' });

  const zipState = await page.evaluate(async () => {
    const dbm = await import('./js/db.js');
    const lib = await import('./js/library.js');
    const tracks = await dbm.getAll('tracks');
    const albums = await dbm.getAll('albums');
    return {
      titles: lib.sortAlbumTracks(tracks, albums[0]).map((t) => t.title),
      album: albums[0]?.name,
      paths: tracks.map((t) => t.path).sort(),
      art: (await dbm.getAll('art')).length,
      // These fixtures carry real tags but no decodable audio frames, so analysis
      // is expected to fail — the point is that the tracks still import cleanly.
      undecodable: tracks.filter((t) => !t.analyzed && t.analyzeError).length,
      blobs: (await dbm.getAll('blobs')).length,
    };
  });
  eq('zip tracks land in one album', zipState.album, 'Zipped Record');
  eq('zip entries keep folder order', zipState.titles, ['Zip 1', 'Zip 2', 'Zip 3']);
  eq('entry paths are preserved', zipState.paths[0], 'Zipped Record/01 zipped.mp3');
  eq('their shared cover is stored once', zipState.art, 1);
  eq('zipped audio is stored', zipState.blobs, 3);
  eq('an undecodable file still imports, with the error recorded', zipState.undecodable, 3);

  /* ---------- 11. the Add album menu ---------- */
  const menu = await page.evaluate(async () => {
    const btn = document.querySelector('#btn-add-album');
    const m = document.querySelector('#add-album-menu');
    const closedAtFirst = m.classList.contains('hidden');
    btn.click();
    await new Promise((r) => setTimeout(r, 100));
    const openAfterClick = !m.classList.contains('hidden');
    const items = [...m.querySelectorAll('.menu-item')].map((i) => i.dataset.source);
    document.body.click();
    await new Promise((r) => setTimeout(r, 100));
    return { closedAtFirst, openAfterClick, items, closedAfterOutside: m.classList.contains('hidden') };
  });
  ok('the add-album menu starts closed', menu.closedAtFirst);
  ok('clicking Add album opens it', menu.openAfterClick);
  eq('it offers folder and zip', menu.items, ['folder', 'zip']);
  ok('clicking elsewhere closes it', menu.closedAfterOutside);

  /* ---------- 11b. the empty state's own Add album menu ----------
     It used to borrow the header's, which the document-level closer then shut
     again in the same click — so first-run "Add album" did nothing at all. */
  const emptyMenu = await page.evaluate(async () => {
    const btn = document.querySelector('#btn-empty-album');
    const m = document.querySelector('#empty-album-menu');
    const r = btn.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    btn.dispatchEvent(new MouseEvent('click', at));   // bubbles, like a real tap
    await new Promise((res) => setTimeout(res, 120));
    const open = !m.classList.contains('hidden');
    const items = [...m.querySelectorAll('.menu-item')].map((i) => i.dataset.source);
    document.body.click();
    await new Promise((res) => setTimeout(res, 120));
    return { open, items, closedAfterOutside: m.classList.contains('hidden') };
  });
  ok('the empty state has its own add-album menu that stays open', emptyMenu.open);
  eq('it offers the same two sources', emptyMenu.items, ['folder', 'zip']);
  ok('and closes on an outside click', emptyMenu.closedAfterOutside);

  /* ---------- 11c. the phone Now-playing screen ---------- */
  const now = await page.evaluate(async () => {
    const el = document.querySelector('#now');
    const tap = async (sel, ms = 200) => {
      document.querySelector(sel).click();
      await new Promise((r) => setTimeout(r, ms));
    };
    const wide = { hiddenOnDesktop: el.hidden };
    await tap('.t-now');
    wide.staysHiddenOnDesktop = el.hidden;   // desktop must never reach it

    // Fold to a phone and play something.
    document.querySelector('.tab[data-view="tracks"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const row = document.querySelector('#track-list .track');
    if (!row) return { ...wide, noTracks: true };
    await tap('#track-list .track', 1200);
    return { ...wide, playing: !document.querySelector('#player').hidden };
  });
  ok('the now screen is hidden on desktop', now.hiddenOnDesktop);
  ok('and tapping the mini player there does not open it', now.staysHiddenOnDesktop);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const phone = await page.evaluate(async () => {
    const el = document.querySelector('#now');
    const t = (sel) => document.querySelector(sel).textContent.trim();
    document.querySelector('.t-now').click();
    await new Promise((r) => setTimeout(r, 250));
    const opened = !el.hidden;
    const filled = !!t('#now-track') && !!t('#now-record');
    const bars = document.querySelectorAll('#now-wave i').length;
    // Pausing here must move the transport too — one player, two control sets.
    document.querySelector('#now-play').click();
    await new Promise((r) => setTimeout(r, 350));
    const bothPaused = t('#now-play') === '▶' && t('#p-play') === 'Play';
    document.querySelector('#now-close').click();
    await new Promise((r) => setTimeout(r, 200));
    return { opened, filled, bars, bothPaused, closed: el.hidden, stillLoaded: !document.querySelector('#player').hidden };
  });
  ok('tapping the mini player on a phone opens the now screen', phone.opened);
  ok('it is filled in from the loaded track', phone.filled);
  eq('its scrubber draws the design’s 60 bars', phone.bars, 60);
  ok('pausing there pauses the transport too', phone.bothPaused);
  ok('the chevron closes it', phone.closed);
  ok('without stopping playback', phone.stillLoaded);

  /* ---------- 11c-2. the Now-playing screen fits one phone screen ----------
     The queue counter and the gain badge sat below the fold: you had to scroll
     the screen to find out what was playing out of what. The artwork is the one
     elastic row now, so it gives way instead. 360x640 is the small end of what
     ships. */
  const fits = [];
  for (const [w, h] of [[390, 844], [360, 640], [412, 732]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
    fits.push(await page.evaluate(async () => {
      const el = document.querySelector('#now');
      document.querySelector('.t-now').click();
      await new Promise((r) => setTimeout(r, 300));
      const foot = document.querySelector('.now-foot').getBoundingClientRect();
      const art = document.querySelector('.now-art').getBoundingClientRect();
      const out = {
        scrolls: el.scrollHeight > el.clientHeight + 1,
        footBelowFold: Math.round(foot.bottom) > el.clientHeight,
        artSquare: Math.abs(art.width - art.height) <= 1,
        artVisible: art.width > 80,
        artFits: Math.round(art.width) <= el.clientWidth,
      };
      document.querySelector('#now-close').click();
      await new Promise((r) => setTimeout(r, 150));
      return out;
    }));
  }
  for (const [i, [w, h]] of [[390, 844], [360, 640], [412, 732]].entries()) {
    ok(`the now screen does not scroll at ${w}x${h}`, !fits[i].scrolls);
    ok(`the queue and gain readout is above the fold at ${w}x${h}`, !fits[i].footBelowFold);
    ok(`the artwork stays square at ${w}x${h}`, fits[i].artSquare);
    ok(`and still fills the width it has at ${w}x${h}`, fits[i].artVisible && fits[i].artFits);
  }

  /* ---------- 11c-3. long titles move rather than being cut ---------- */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
  const mq = await page.evaluate(async () => {
    const el = document.querySelector('#now-track');
    document.querySelector('.t-now').click();
    await new Promise((r) => setTimeout(r, 300));
    const wired = el.firstElementChild?.tagName === 'SPAN';
    const short = el.classList.contains('is-scrolling');
    // Re-measuring is what decides it, so give it something that cannot fit and
    // let the resize hook run.
    el.firstElementChild.textContent =
      'A Title Far Too Long For Any Phone To Show In One Go, By Some Considerable Margin';
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 500));
    const cs = getComputedStyle(el);
    const out = {
      wired,
      shortStaysStill: !short,
      longScrolls: el.classList.contains('is-scrolling'),
      shift: parseFloat(cs.getPropertyValue('--mq-shift')),
      dur: parseFloat(cs.getPropertyValue('--mq-dur')),
      clipped: el.clientWidth < el.firstElementChild.scrollWidth,
    };
    document.querySelector('#now-close').click();
    await new Promise((r) => setTimeout(r, 150));
    return out;
  });
  ok('the title is wrapped in a span the marquee can move', mq.wired);
  ok('a title that fits is left alone', mq.shortStaysStill);
  ok('one that does not fit scrolls', mq.longScrolls);
  ok('it travels exactly the hidden overflow', mq.clipped && mq.shift > 0, `${mq.shift}px`);
  ok('over a duration set by the distance', mq.dur >= 4, `${mq.dur}s`);

  /* ---------- 11c-4. the quality badge shrinks to an abbreviation ---------- */
  const abbr = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="tracks"]').click();
    await new Promise((r) => setTimeout(r, 250));
    const b = document.querySelector('#track-list .badge');
    if (!b) return { none: true };
    return {
      word: b.textContent.trim(),
      abbr: b.dataset.abbr?.trim(),
      wordHidden: getComputedStyle(b).fontSize === '0px',
      shown: getComputedStyle(b, '::before').content.replace(/^"|"$/g, '').trim(),
      width: Math.round(b.getBoundingClientRect().width),
    };
  });
  await page.send('Emulation.clearDeviceMetricsOverride');
  ok('the track row carries an abbreviation for phones', !!abbr.abbr, abbr.abbr);
  ok('the full wording is hidden at phone width', abbr.wordHidden);
  ok('and the abbreviation is what is drawn', abbr.shown === abbr.abbr, `${abbr.shown} vs ${abbr.abbr}`);
  ok('the badge fits its column', abbr.width <= 62, `${abbr.width}px`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  /* ---------- 11d. the phone transport: target size and no page pan ----------
     .t-now on its own came out 120px wide beside the controls, and the seek
     block it was competing with pushed the bar 12px past the right edge — so
     the whole interface could be dragged sideways like a zoomed image. */
  const bar = await page.evaluate(async () => {
    const el = document.querySelector('#now');
    const doc = document.documentElement;
    const p = document.querySelector('#player');
    const b = p.getBoundingClientRect();
    // Where a finger lands: the empty ink at the far left of the bar, well
    // clear of the artwork.
    const hitAt = (x, y) => {
      el.hidden = true;
      document.elementFromPoint(x, y)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return !el.hidden;
    };
    const out = {
      overflowsX: doc.scrollWidth > doc.clientWidth,
      overflowsY: doc.scrollHeight > doc.clientHeight,
      bodyFixed: getComputedStyle(document.body).position === 'fixed',
      barWithinViewport: Math.round(b.right) <= doc.clientWidth,
      chevronShown: getComputedStyle(document.querySelector('.t-open')).display !== 'none',
      openWidth: Math.round(document.querySelector('.t-now').getBoundingClientRect().width),
      farLeftOpens: hitAt(b.x + 5, b.y + b.height / 2),
    };
    // ...but a control still does its own job. Whether the sound actually
    // resumes depends on the synthetic fixture, so watch the button get the
    // click rather than the label that follows from decoding.
    const play = document.querySelector('#p-play');
    const pb = play.getBoundingClientRect();
    play.addEventListener('click', () => { out.playGotClick = true; }, { once: true });
    out.playGotClick = false;
    out.playOpens = hitAt(pb.x + pb.width / 2, pb.y + pb.height / 2);
    el.hidden = true;
    return out;
  });
  await page.send('Emulation.clearDeviceMetricsOverride');
  ok('the phone layout does not scroll sideways', !bar.overflowsX);
  ok('nor up and down at the document level', !bar.overflowsY);
  ok('the body is pinned, so nothing pans', bar.bodyFixed);
  ok('the transport fits inside the viewport', bar.barWithinViewport);
  ok('the mini player shows its open-up chevron', bar.chevronShown);
  ok('and is wide enough to hit', bar.openWidth >= 180, `${bar.openWidth}px`);
  ok('tapping empty bar ink opens the now screen', bar.farLeftOpens);
  ok('tapping Play does not', !bar.playOpens);
  ok('the button gets the tap instead', bar.playGotClick);

  /* ---------- 11f. the record's Configure menu on a phone ----------
     Its 270px minimum hung off a button two thirds across the row and ran past
     the right edge, which gave the stage a sideways scroll you could drag the
     whole record around with. And the cover was a button that threw you into
     the gallery on the way past. */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  const cfg = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="albums"]').click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('.album')?.click();
    await new Promise((r) => setTimeout(r, 350));
    const scrollers = () => [...document.querySelectorAll('.stage,.view,.album-detail,.shell,#album-detail')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className || el.id}:${el.scrollWidth}>${el.clientWidth}`);
    const before = scrollers();
    document.querySelector('#btn-album-config').click();
    await new Promise((r) => setTimeout(r, 250));
    const menu = document.querySelector('#album-config');
    const m = menu.getBoundingClientRect();
    const cover = document.querySelector('.hero .tile');
    return {
      opened: !menu.classList.contains('hidden'),
      beforeScrollers: before,
      afterScrollers: scrollers(),
      docOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      menuLeft: Math.round(m.left),
      menuRight: Math.round(m.right),
      viewport: document.documentElement.clientWidth,
      coverIsButton: cover?.tagName === 'BUTTON' || !!cover?.dataset.albumAct,
      // Every remaining way to set a cover, so removing the tap did not strand it.
      setCoverInMenu: [...menu.querySelectorAll('[data-album-act="art"]')].length,
    };
  });
  ok('the record opens and Configure with it', cfg.opened);
  ok('nothing scrolled sideways before it opened', cfg.beforeScrollers.length === 0, cfg.beforeScrollers.join(' '));
  ok('and nothing does with the menu open', cfg.afterScrollers.length === 0, cfg.afterScrollers.join(' '));
  ok('the document does not overflow either', !cfg.docOverflows);
  ok('the menu stays inside the screen', cfg.menuLeft >= 0 && cfg.menuRight <= cfg.viewport,
    `${cfg.menuLeft}..${cfg.menuRight} in ${cfg.viewport}`);
  ok('the cover is no longer a picker button', !cfg.coverIsButton);
  ok('Set cover is still reachable from Configure', cfg.setCoverInMenu === 1);

  /* ---------- 11g. phone track lists carry the title alone by default ---------- */
  const cols = await page.evaluate(async () => {
    // The header, not a row: whether the Quality tab has anything to list
    // depends on the codec target, and the columns are the point either way.
    const seen = (view) => {
      const head = document.querySelector(`.view[data-view="${view}"] .tl-head`);
      if (!head) return null;
      const vis = (sel) => {
        const el = head.querySelector(sel);
        return !!el && getComputedStyle(el).display !== 'none';
      };
      return { qual: vis('.qual'), dur: vis('.dur') };
    };
    const out = { attr: document.documentElement.dataset.cols, albums: seen('albums') };
    document.querySelector('.tab[data-view="tracks"]').click();
    await new Promise((r) => setTimeout(r, 250));
    out.tracks = seen('tracks');
    document.querySelector('.tab[data-view="quality"]').click();
    await new Promise((r) => setTimeout(r, 250));
    out.quality = seen('quality');
    // Turning the setting on has to bring them straight back.
    document.querySelector('.tab[data-view="settings"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const box = document.querySelector('#set-phone-cols');
    out.defaultUnchecked = !box.checked;
    box.click();
    await new Promise((r) => setTimeout(r, 300));
    out.attrOn = document.documentElement.dataset.cols;
    document.querySelector('.tab[data-view="tracks"]').click();
    await new Promise((r) => setTimeout(r, 250));
    out.tracksOn = seen('tracks');
    box.click();
    await new Promise((r) => setTimeout(r, 300));
    return out;
  });
  await page.send('Emulation.clearDeviceMetricsOverride');
  ok('the phone default is title only', cols.attr === 'name' && cols.defaultUnchecked);
  ok('the record list drops quality and time', cols.albums && !cols.albums.qual && !cols.albums.dur);
  ok('so does the tracks list', cols.tracks && !cols.tracks.qual && !cols.tracks.dur);
  ok('the Quality tab keeps its quality column', cols.quality?.qual === true, JSON.stringify(cols.quality));
  ok('the switch brings the columns back', cols.attrOn === 'all' && cols.tracksOn?.qual === true);

  /* ---------- 11e. Settings → Version ---------- */
  const ver = await page.evaluate(async () => {
    document.querySelector('.tab[data-view="settings"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const t = (sel) => document.querySelector(sel).textContent.trim();
    const heads = [...document.querySelectorAll('.view[data-view="settings"] .panel h3')].map((h) => h.textContent.trim());
    const util = await import('./js/util.js');
    return {
      last: heads[heads.length - 1],
      app: t('#ver-app'),
      constant: util.APP_VERSION,
      sw: t('#ver-sw'),
      mode: t('#ver-mode'),
      state: t('#ver-state').length > 0,
      hasButton: !!document.querySelector('#btn-update'),
    };
  });
  eq('Version is the last panel in Settings', ver.last, 'Version');
  eq('it prints the app version', ver.app, ver.constant);
  ok('and the cache the worker is actually serving', /^v\d|Not /.test(ver.sw), ver.sw);
  ok('it says whether the app is installed', /^(Yes|No)/.test(ver.mode), ver.mode);
  ok('it explains the state in words', ver.state);
  ok('and offers a way to update', ver.hasButton);

  /* ---------- 12. editing track and album artists ---------- */
  // A page reload drops the injected helpers, so re-inject before each use.
  const seed = async () => {
    await page.evaluate(ART);
    return page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    await dbm.wipe();
    const settings = await dbm.settings();
    await lib.importFiles([1, 2, 3].map((i) =>
      window.__mp3(`0${i}.mp3`, { title: `Song ${i}`, artist: 'Old Artist', album: 'The Record' })), { settings });
      const tracks = await dbm.getAll('tracks');
      return lib.sortAlbumTracks(tracks, { sortMode: 'folder' }).map((t) => t.id);
    });
  };

  // (a) one track's artist, through the real dialog
  let ids = await seed();
  await page.goto(URL);
  await bootWait();
  const oneEdit = await page.evaluate(`(async () => {
    document.querySelector('[data-menu="${ids[0]}"]').click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('[data-act="edit"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const before = document.querySelector('#f-artist').value;
    document.querySelector('#f-artist').value = 'New Artist';
    document.querySelector('[data-act="save"]').click();
    await new Promise((r) => setTimeout(r, 900));
    const dbm = await import('./js/db.js');
    const t = await dbm.get('tracks', ${JSON.stringify(ids[0])});
    const others = (await dbm.getAll('tracks')).filter((x) => x.id !== ${JSON.stringify(ids[0])});
    return { before, artist: t.artist, album: t.album, title: t.title, othersUnchanged: others.every((x) => x.artist === 'Old Artist') };
  })()`);
  eq('the edit dialog pre-fills the current artist', oneEdit.before, 'Old Artist');
  eq('editing one track changes its artist', oneEdit.artist, 'New Artist');
  eq('and leaves its other tags alone', [oneEdit.album, oneEdit.title], ['The Record', 'Song 1']);
  ok('other tracks are untouched', oneEdit.othersUnchanged);

  // (b) album artist, with and without pushing it down to track artists
  ids = await seed();
  const albumOnly = await page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    const key = (await dbm.getAll('albums'))[0].key;
    await lib.renameAlbum(key, { artist: 'Album Artist', applyToTrackArtists: false });
    const tracks = await dbm.getAll('tracks');
    const album = (await dbm.getAll('albums'))[0];
    return {
      albumArtist: album.artist,
      trackArtists: [...new Set(tracks.map((t) => t.artist))],
      albumArtists: [...new Set(tracks.map((t) => t.albumArtist))],
      albumCount: (await dbm.getAll('albums')).length,
    };
  });
  eq('album artist is set', albumOnly.albumArtist, 'Album Artist');
  eq('track artists are left alone by default', albumOnly.trackArtists, ['Old Artist']);
  eq('no duplicate album records', albumOnly.albumCount, 1);

  const pushDown = await page.evaluate(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    const key = (await dbm.getAll('albums'))[0].key;
    await lib.renameAlbum(key, { artist: 'Unified Artist', applyToTrackArtists: true });
    const tracks = await dbm.getAll('tracks');
    return {
      trackArtists: [...new Set(tracks.map((t) => t.artist))],
      albums: (await dbm.getAll('albums')).length,
      keys: [...new Set(tracks.map((t) => t.albumKey))],
    };
  });
  eq('opting in rewrites every track artist', pushDown.trackArtists, ['Unified Artist']);
  eq('the album stays a single album', pushDown.albums, 1);
  eq('all tracks share one album key', pushDown.keys.length, 1);

  // (c) bulk "Set artist" over a selection
  ids = await seed();
  await page.goto(URL);
  await bootWait();
  const bulk = await page.evaluate(`(async () => {
    document.querySelector('#btn-select').click();
    await new Promise((r) => setTimeout(r, 200));
    const rows = [...document.querySelectorAll('#track-list .track')];
    rows[0].click();
    rows[1].click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('#btn-sel-artist').click();
    await new Promise((r) => setTimeout(r, 200));
    const hint = document.querySelector('.dlg-body .muted')?.textContent.trim();
    document.querySelector('#f-artist').value = 'Bulk Artist';
    document.querySelector('[data-act="save"]').click();
    await new Promise((r) => setTimeout(r, 1200));
    const dbm = await import('./js/db.js');
    const tracks = await dbm.getAll('tracks');
    return {
      hint,
      bulk: tracks.filter((t) => t.artist === 'Bulk Artist').length,
      untouched: tracks.filter((t) => t.artist === 'Old Artist').length,
      selectClosed: document.querySelector('#selection-bar').classList.contains('hidden'),
    };
  })()`);
  eq('bulk edit applies to exactly the selection', bulk.bulk, 2);
  eq('unselected tracks keep their artist', bulk.untouched, 1);
  ok('the dialog reports the shared current artist', /Old Artist/.test(bulk.hint || ''), bulk.hint);
  ok('selection mode closes afterwards', bulk.selectClosed);

  // (d) editing the album name moves a track to another album
  ids = await seed();
  const moved = await page.evaluate(`(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    await lib.updateTrack(${JSON.stringify(ids[0])}, { album: 'Different Record' });
    const albums = await dbm.getAll('albums');
    return {
      albums: albums.map((a) => ({ name: a.name, count: a.trackCount })).sort((x, y) => x.name.localeCompare(y.name)),
    };
  })()`);
  eq('the track moved into a new album, both counts correct', moved.albums,
    [{ name: 'Different Record', count: 1 }, { name: 'The Record', count: 2 }]);

  // (e) blanks fall back rather than producing an empty library entry
  const blanks = await page.evaluate(`(async () => {
    const lib = await import('./js/library.js');
    const dbm = await import('./js/db.js');
    const t = await lib.updateTrack(${JSON.stringify(ids[1])}, { artist: '   ', title: '' });
    return { artist: t.artist, title: t.title };
  })()`);
  eq('a blank artist falls back', blanks.artist, 'Unknown Artist');
  ok('a blank title falls back to the file name', blanks.title.length > 0, blanks.title);

  console.log('\n--- console output from the page ---');
  page.dumpLogs();
  console.log(fails ? `\n${fails} check(s) failed` : '\nall UI checks passed');
} catch (err) {
  console.error('ERROR:', err.message);
  page.dumpLogs();
  fails++;
} finally {
  await page.close();
  server.kill();
  process.exit(fails ? 1 : 0);
}
