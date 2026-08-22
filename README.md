# Offline Music

An installable PWA that turns a pile of audio files into a consistent music library —
**every song at the same loudness, every file at the same encoding target, every cover
the same normalized square.** Everything happens on the device: no uploads, no server,
no accounts. The service worker makes the app itself work with no network at all.

Static files only, so it deploys to GitHub Pages as-is.

## What it actually does

### Loudness normalization (the real thing, not peak normalization)
Each file is decoded once and measured to **ITU-R BS.1770-4 / EBU R128**:

- K-weighted **integrated loudness** in LUFS, with the absolute (−70 LUFS) and
  relative (−10 LU) gates
- **Loudness range** (LRA, EBU Tech 3342) and momentary/short-term maxima
- **True peak** in dBTP, 4× oversampled — it catches inter-sample peaks that a sample
  peak meter reports 3 dB too low

Playback then applies `target − measured` as a gain on the Web Audio graph, pulled back
automatically so the true peak never crosses your ceiling (default −1 dBTP). Nothing is
written into the file, so changing the target re-normalizes the whole library instantly.

**Album mode** is done properly: album loudness is the gated mean over the 400 ms blocks
of *every track on the album*, recomputed from a 0.1 LU histogram stored per track — not
an average of the per-track LUFS values. Quiet interludes stay quiet relative to the
loud tracks around them.

### Quality detection
The same decode pass measures what the file actually contains, rather than trusting tags:

- **Effective bandwidth** — the average spectrum is scanned for the frequency where
  signal stops. Lossy encoders brick-wall; instruments roll off. A "FLAC" that dies at
  16 kHz gets flagged as *transcoded from a lossy source*.
- **Clipping** (runs of samples pinned at full scale), **crest factor**, real bitrate
  from bytes ÷ duration, sample rate, channel count, container and codec
- A 0–100 score and a tier (lossless / high / standard / low / poor)

### Quality normalization
Pick one encoding target (Opus at a chosen bitrate, or 16-bit WAV) and the Quality tab
lists every file that deviates. Normalizing decodes → resamples → maps channels →
optionally bakes in the loudness gain → re-encodes:

- **Opus** via WebCodecs `AudioEncoder`, wrapped in Ogg by a muxer in
  `js/audio/oggopus.js` (browsers hand back raw packets)
- Every encoded file is **decoded again before it is stored**; if that fails the track
  falls back to WAV instead of being lost
- Files already better than the target are skipped by default (re-encoding them only
  loses quality), and the original can be kept so the operation stays reversible

### Albums
Click an album to open just its tracks. Inside:

- **Track order** defaults to **folder order** — the order the files were imported in,
  compared numerically, so `2 - x` comes before `10 - y`. Tags are frequently missing or
  wrong; the folder rarely is. You can switch to track number from tags, to title, or
  **drag any row** to build a custom order, which is stored per album and survives
  reloads, re-analysis, renames and later imports (new tracks join the end).
- **Rename album** rewrites the album name and album artist across every track in it.
  Renaming onto an existing album merges the two.
- An untagged file is filed under **the folder it came from** rather than a single giant
  "Unknown Album", and dropping a folder onto the window imports the whole tree with its
  paths intact.
- **Delete album** removes every track in it, its audio, and any artwork left orphaned.

### Deleting

**Select** in the Tracks toolbar turns the list into a multi-select: click rows to pick
them, **shift-click** to take a range, `Ctrl/⌘+A` for everything currently shown (which
respects the search box and filters, so you can select-all *just* the poor-quality
tracks). **Delete selected** shows how many files and how many megabytes are about to go,
then removes the tracks, their audio, any kept originals and any now-unreferenced covers
in a single pass. `Esc` leaves the mode, `Del` deletes. If you delete what is playing,
playback stops and the queue closes over the gap.

### Artwork
Embedded covers (ID3 `APIC`, MP4 `covr`, FLAC/Ogg `PICTURE`) are extracted on import, and
you can drop your own image on any track or album. Each one is center-cropped to a square,
downscaled in halving steps (no aliasing), and stored at two sizes — a full cover and a
list thumbnail — as WebP at a fixed quality.

Covers are deduplicated by **image content** (SHA-256), never by album: an album that
embeds the same cover in all twelve tracks stores it once, while two albums with
different covers can never end up sharing one, however similar or absent their tags are.
If a library imported by an earlier build shows the wrong cover somewhere,
**Settings → Repair covers from files** re-reads the artwork embedded in each audio file
and reassigns it.

## Using it

**Add album** takes a whole folder or a **.zip archive**; **Add track** takes individual
files. You can also drag any of the three onto the window. The library then builds
itself: tags are read, the audio is analyzed, covers are normalized. Files are stored in
IndexedDB, so it all still works offline and after install.

Archives are unpacked on the device by a small ZIP reader (`js/zip.js`) using the
browser's own `DecompressionStream` — no library, and only one entry is held in memory at
a time, so a multi-gigabyte archive of FLACs behaves like a small one. Store and deflate
are supported, along with ZIP64 and UTF-8 entry names; each entry keeps its path, so a
zipped album orders and names itself exactly like a real folder would.

- **Tracks** — everything, searchable, with filters for *not analyzed*, *off-target
  loudness* and *below quality target*, plus multi-select for bulk deletion
- **Albums** — cover grid; click through to an album to reorder, rename, set a cover,
  play it, or normalize the whole thing
- **Quality** — library statistics, loudness distribution, and the batch normalizer
- **Settings** — target loudness and ceiling, track/album/off mode, limiter, encoding
  target, artwork sizes, storage

Click a row to play, click its cover to set artwork, click **⋮** for the full measurement
readout and per-track actions.

## Running locally

```sh
npm run serve      # http://localhost:8080 — service workers need http, not file://
npm test           # everything below
npm run test:unit  # DSP + container/parser/zip checks (no browser needed)
npm run test:ui    # drives the real app in headless Chrome
npm run icons      # regenerate the PWA icons
```

No dependencies — the tests use only Node built-ins, and the UI test talks to Chrome
over the DevTools Protocol directly (set `CHROME_PATH` if it can't find a browser; it
skips rather than fails when there is none).

The unit tests verify the K-weighting coefficients against the values published in
BS.1770-4, check the EBU Tech 3341 calibration (a full-scale 1 kHz stereo sine reads
0.0 LUFS, a −23 dBFS one reads −23.0), prove the gates actually gate, and round-trip the
Ogg muxer, WAV writer and the ID3 / FLAC / MP4 / Ogg parsers. They also build real ZIP
archives with Node's zlib and read them back through `js/zip.js`, covering store, deflate,
ZIP64, UTF-8 names, trailing comments and corrupt entries.

The UI test imports synthetic files into a real IndexedDB, then exercises album opening,
every sort mode, drag-to-reorder, renaming, multi-select with shift-ranges, bulk deletion,
album deletion, artwork ownership and importing an album from a .zip — including checking
that no audio blobs or covers are left behind.

On `localhost` the service worker fetches from the network first, so a reload always
shows the code you just edited; on a real host it stays cache-first for offline use.

## Deploying to GitHub Pages

Push to `main` and enable Pages for the repository root. Every path in the app is
relative, so it works from `/<repo>/` without configuration.

## Browser support

Chrome, Edge and Android Chrome get everything. Firefox and Safari get the full library,
analysis and playback; Opus re-encoding needs WebCodecs, and where it is missing the app
says so in Settings and falls back to WAV.

## Layout

```
index.html            app shell            sw.js              offline cache + share target
js/app.js             UI                   js/library.js      import, albums, jobs
js/db.js              IndexedDB            js/metadata.js     ID3 / MP4 / FLAC / Ogg / WAV tags
js/image.js           artwork pipeline    js/zip.js          ZIP reader (store/deflate/ZIP64)
js/dsp/loudness.js    BS.1770-4            js/dsp/quality.js  spectrum, clipping, scoring
js/dsp/analyzer-worker.js                  off-main-thread analysis
js/audio/decode.js    decode + worker pool js/audio/player.js playback graph + gain
js/audio/transcode.js re-encode pipeline   js/audio/oggopus.js WebCodecs Opus + Ogg muxer
js/audio/wav.js       PCM writer           tests/             node test scripts
```

## Notes and limits

- Audio is decoded by the browser, so anything it can't decode (APE, WavPack, some WMA)
  can be stored but not analyzed or played.
- Analysis decodes at a fixed 48 kHz so measurements are identical across devices; the
  file's native sample rate is read from its container instead.
- Loudness figures are within ~0.1 LU of the reference in the checks in `tests/`, but
  this has not been run against the full EBU Tech 3341 compliance set.
- Ask for persistent storage in Settings, otherwise a browser under disk pressure may
  evict the library.
