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
- A 160-bin **momentary-loudness envelope**, which is what the transport's scrubber
  draws. A track that has not been analyzed gets a flat strip rather than a made-up
  waveform — it still scrubs, it just doesn't claim anything.

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

### The interface
Condensed uppercase display type, monospaced microtype, hairline rules, no rounded
corners, one accent colour — the **Offpress** design.

- A **rail** on the left holds the three destinations (Records, Tracks, Quality) with
  live counts, the library filters, and a footer readout of what is cached and what the
  encoder is aimed at. Settings sits at its foot. Under 860 px the rail folds into a
  scrolling strip under the header, and the header's search drops to its own line.
- The **transport** carries the mini cover (with the press turning while it plays), the
  transport buttons, the applied normalization gain, and the loudness-envelope scrubber.
- The **press turns the cover itself**. Where a record has artwork, the artwork is cut to
  the record's face and rotates under the grooves, with the spindle punched at the middle;
  a record with no cover turns its grooves over the tinted sleeve as before. Pausing
  freezes it where it stands rather than snapping it back upright. Two switches in
  Settings → Appearance: **Spin the press** turns the rotation off entirely, and **Turn the
  cover into a spinning record** keeps the grooves turning but leaves the cover a square.
- On a phone, tapping **anywhere on the transport bar** — the whole strip, not just the
  cover — opens the **Now-playing screen**, and a chevron on the mini player says so.
  It carries the turning record, the track, the wide scrubber over the same measured
  envelope, the transport, and the file's real format, queue position and applied gain
  along the bottom. The artwork is the only elastic row on the screen: everything else is
  a fixed height and the square takes what is left, so the whole thing fits one screen
  down to 360×640 without scrolling. `⌄` or Escape goes back; playback is untouched
  either way. It only exists under 860 px — above that the transport and the record hero
  already carry all of it. At that width the bar itself drops to cover, title,
  prev/play/next; the scrubber, shuffle and repeat live on the Now-playing screen, which
  is where there is room for them.
- A **track title too long for its box slides across and back** rather than being cut off,
  on the Now-playing screen and on the mini player. Whether it moves at all is measured,
  not guessed: a title that fits is left perfectly still.
- On a phone the track lists carry **the title alone** — quality and time are dropped so a
  long name has the row to itself, and **Quality and time columns on phones** in
  Settings → Appearance puts them back. With them on, the quality badge drops to an
  abbreviation (`LSL`, `HI`, `STD`, `LOW`, `POOR`) to fit. The Quality tab always keeps its
  own columns, and the full wording stays in the track dialog.
- The record grid draws the **full-size stored cover**, not the 128 px thumbnail. A grid
  tile is 120–220 css px, so a phone asks it for 400-plus device pixels and the thumb was
  being blown up nearly 4× — which is why the grid read soft next to the record's own hero.
  Thumbnails stay where they fit, on the 40 px track rows.
- Tapping a record's cover does **not** open the file picker. Setting a cover is a
  deliberate act behind **⚙ Configure → Set cover**; on a phone the tap-to-set version fired
  every time you meant to scroll.
- The page itself never scrolls. Only the stage and the folded rail do, so nothing can be
  dragged around the way a zoomed page can.
- A record's hero carries a **live output meter** while something is playing. It reads
  real FFT magnitudes off the playback graph *after* normalization gain, so it moves with
  what you actually hear rather than to a timer. Desktop only, and off under
  `prefers-reduced-motion`.
- **Settings → Appearance** picks the accent from the seven press-shop colours or any colour
  you like, sets how much grain sits over covers, and toggles the record tinting, the
  turning press and the live meter. The default is **Blank**, plain white; the ink on the
  accent is chosen from its luminance, so a near-white accent stays readable without a
  second setting to get wrong.
- **Settings → Backdrop** puts a wallpaper behind the whole window. *Grooves*, *Halftone*
  and *Sleeve* are drawn in CSS from the accent colour and cost nothing. *Image* uses a
  picture you choose: it is downscaled to 1920 px on the longest edge, stored in IndexedDB
  like everything else, and never uploaded. It is desaturated and darkened by default, and
  a **Dim** slider sets how much ink sits between the picture and the interface. Whenever a
  backdrop is on, the chrome, rail, panels and transport go translucent so it reads through.
- The **mark** — a stylus crossing a record — is the same geometry in the header, in
  `icons/icon.svg` and in the generated PNG icons, so the installed app looks like the app.
  The arm is a true diameter through the centre, and the label punches it out at exactly
  its middle so it reads as an arm passing behind the record rather than as a struck-out
  circle. Run `npm run icons` after touching `scripts/gen-icons.mjs`.
- Fonts come from Google Fonts and are cached by the service worker on first load; before
  that, and if they never load at all, the app falls back to a local condensed/mono stack.

### Records
Click a record to open just its tracks. Inside:

- **Play** and **Shuffle** are the only two buttons. Everything else lives behind
  **⚙ Configure**: track order, edit name and artist, set cover, normalize quality,
  delete record.
- **Track order** defaults to **folder order** — the order the files were imported in,
  compared numerically, so `2 - x` comes before `10 - y`. Tags are frequently missing or
  wrong; the folder rarely is. You can switch to track number from tags, to title, or
  **drag any row** to build a custom order, which is stored per record and survives
  reloads, re-analysis, renames and later imports (new tracks join the end).
- **Edit name & artist…** applies across every track on the record, with an opt-in to
  push that artist down onto each track's own artist too — right for a single-artist
  record, wrong for a compilation, so it is a choice rather than a default. Renaming onto
  an existing record merges the two.
- A record with no cover is not given a placeholder: it keeps a printed face, tinted by a
  hue derived from its own key, with its name and track count set into the corner.
- An untagged file is filed under **the folder it came from** rather than a single giant
  "Unknown Album", and dropping a folder onto the window imports the whole tree with its
  paths intact.
- **Delete record** removes every track in it, its audio, and any artwork left orphaned.

### Editing tags
**⋮ → Edit details** on any track edits title, artist, album, album artist, track and disc
number, year and genre. The album key is derived from album/album artist, so changing
either *moves* the track — both the album it left and the album it joined are recounted
immediately. Blank values fall back (`Unknown Artist`, the file name) rather than leaving
an unreachable entry.

To fix many tracks at once, use **Select → Set artist…**: it pre-fills when the selection
already shares an artist, says how many artists it spans when it doesn't, and can set the
album artist to match in the same pass.

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

### Backup and restore

The library lives in IndexedDB, which a cleared profile, a reinstall or a browser
reclaiming disk space will take with it. **Settings → Back up the library** writes an
ordinary `.zip` — your audio, your covers, and a `manifest.json` holding every
measurement — straight to a file you choose, streamed, so a 40 GB library never has to fit
in memory. Nothing is uploaded, and the archive opens in any unzip tool.

Restoring merges by content hash (so re-reading a backup you already have adds nothing) or
replaces the library outright. What comes back is not just the files: the loudness
histograms, quality scores, hand-set covers, tag edits and the track orders you dragged
into place all survive, because recomputing those is the expensive part.

**Measurements only** leaves the audio out. It is small and quick, and still worth taking:
restore it, re-import the same files, and each one reattaches to the row that already holds
its analysis instead of being imported fresh.

The same archive format is what gets sent to another person, scoped to one record — see
below. Any Offpress archive dropped on the app, opened with it or shared into it is
recognised by its manifest and restored, rather than being unpacked as if it were an album
of loose files.

### Sending a record to someone

**Configure → Send this record**, **Send…** in the track selection, or **Send…** in a
track's details packs the chosen tracks into a bundle: the audio, the covers and every
loudness and quality measurement, in an ordinary `.zip`. Where the browser supports it the
bundle goes straight into the OS share sheet (`navigator.share`), so on Android or Windows
it is one tap to AirDrop, Nearby Share, a messenger or a mail draft. Everywhere else it is
saved as a file and you send it however you already do.

Whoever opens it in Offpress gets the record already analyzed, because the measurements
travel with it and nothing has to be decoded again. Anything they already own is skipped by
content hash, so sending someone a record they half have transfers the half they are
missing. Dropping the bundle on the app, opening it with the app, or sharing it into the app
all land in the same place.

A bundle is not a backup of the machine it came from. It carries no settings, no backdrop
picture and no folder links, and a linked track's audio is read out of its folder and packed
in — the person receiving it cannot reach your disk. A shared record can only ever merge
into a library, never replace one.

### Linked folders

Importing copies files into IndexedDB, which means a second copy of your music on disk.
**Add album → Link a folder** instead reads a folder where it sits: only the metadata,
artwork and measurements are stored, which is a few MB. Files you add to the folder turn up
on the next **Rescan**, and a file that only moved is followed by its content hash rather
than imported again.

Deleting a linked track removes the record and leaves the file alone; unlinking a folder
never touches the folder. Linking needs the File System Access API, so it is offered only
where the browser has it (desktop Chromium) — and because browsers do not always keep
folder permission across a reload, Settings shows a **Reconnect** button when one lapses.

### Report

The **Report** tab adds up what the import pass already measured: quality tiers across the
library, loudness against the target, where each file's spectrum actually stops, which
codecs are eating the space, what the detector flagged and how often, records whose tracks
span more than 3 LU (usually a compilation, or two different rips), and the extremes.
Everything on it is a link into the list it came from. Nothing is computed fresh.

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

- **Records** — cover grid; click through to a record to play it, shuffle it, or open
  **⚙ Configure** to reorder, rename, set a cover, normalize or delete it
- **Tracks** — everything, searchable, with rail filters for *not analyzed*, *off target*
  and *below quality*, plus multi-select for bulk artist edits and deletion
- **Quality** — library statistics, loudness distribution, and the batch normalizer
- **Settings** — appearance, target loudness and ceiling, track/album/off mode, limiter,
  encoding target, artwork sizes, storage, and a **Version** panel at the foot

**Version** prints the build you are running and the offline cache the service worker is
actually serving. When those two disagree you are looking at stale code, which is the
usual reason a change does not show up after a deploy — **Check for update** re-fetches
the worker, activates a waiting one and reloads. `APP_VERSION` in `js/util.js` and
`VERSION` in `sw.js` are the two places the number is written; keep them in step.

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

The UI test imports synthetic files into a real IndexedDB, then exercises opening a
record, the Configure menu, every sort mode, drag-to-reorder, renaming, multi-select with
shift-ranges, bulk deletion, record deletion, artwork ownership, tag editing (including a
track moving between records) and importing a record from a .zip — checking along the way
that no audio blobs or covers are left behind.

On `localhost` the service worker fetches from the network first, so a reload always
shows the code you just edited; on a real host it stays cache-first for offline use.

## Deploying to GitHub Pages

Push to `main` and enable Pages for the repository root. Every path in the app is
relative, so it works from `/<repo>/` without configuration.

## Browser support

Chrome, Edge and Android Chrome get everything. Firefox and Safari get the full library,
analysis and playback; Opus re-encoding needs WebCodecs, and where it is missing the app
says so in Settings and falls back to WAV. Linking folders needs the File System Access
API, so that option only appears on desktop Chromium; backup and restore work everywhere,
though without the API the archive is downloaded rather than streamed to a chosen file.
Handing a bundle to the OS share sheet needs `navigator.share` with file support — Android
Chrome, iOS Safari, and Chrome and Edge on Windows have it, Firefox and Linux do not, and
there the bundle is saved instead.

## Layout

```
index.html            app shell            sw.js              offline cache + share target
js/app.js             UI                   js/library.js      import, albums, jobs
js/db.js              IndexedDB            js/metadata.js     ID3 / MP4 / FLAC / Ogg / WAV tags
js/image.js           artwork pipeline     js/zip.js          ZIP reader (store/deflate/ZIP64)
js/zipwrite.js        ZIP writer (stream)  js/archive.js      backup + restore
js/source.js          stored vs linked     js/report.js       library aggregates
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
  evict the library — and take a backup, which is the only thing that survives a cleared
  profile or a new machine.
- A directory handle belongs to the browser that created it, so linked folders cannot
  travel in a backup. Those rows are restored with their measurements and wait to be
  linked again.
