/** Beam — two devices, one data channel.
 *
 *  Everything the library is worth already sits in IndexedDB on whichever
 *  device did the importing, and getting it onto the other one used to mean
 *  packing a zip, handing it to the system share sheet, and hoping the phone
 *  had room for a second copy of the whole thing. This is the direct route: the
 *  two browsers open a WebRTC data channel and the tracks go straight across.
 *
 *  Why peer-to-peer rather than a server: a library is tens of gigabytes of
 *  music the user already owns. Uploading it somewhere to download it again
 *  costs twice the transfer, needs an account and a bill, and puts a copy of a
 *  private collection on a machine neither device controls. On the same Wi-Fi a
 *  direct channel also runs at LAN speed, which nothing routed through the
 *  internet can match.
 *
 *  What the network costs: WebRTC still needs signalling to introduce the two
 *  peers. That is a PeerJS broker — a few hundred bytes of "here is my session
 *  description", never a byte of audio. The library is vendored (js/vendor), so
 *  nothing is fetched from a CDN at runtime, and pointing `server` at your own
 *  peerjs-server makes the whole thing work on a LAN with no internet at all.
 *
 *  Connectivity is the one part that can genuinely fail: on symmetric NAT
 *  (common on mobile carriers) STUN is not enough and a TURN relay is needed.
 *  None ships with the app, because a hardcoded dead relay looks configured
 *  while failing exactly when it matters — see Settings → Beam → Network to add
 *  one, and `probeIce` to find out whether you need it.
 *
 *  The protocol this carries lives in sync.js; this file is the wire. */

import * as db from './db.js';
import * as sync from './sync.js';
import { APP_VERSION } from './util.js';

export const BEAM_PROTO = 1;

const CHUNK_SIZE = 16 * 1024;          // 16 KB — safe SCTP message size
const BUFFER_HIGH_WATER = 1024 * 1024; // let the channel hold this much…
const BUFFER_LOW_WATER = 256 * 1024;   // …then wait for it to drain to here
const FOLD_BYTES = 8 * 1024 * 1024;    // fold received chunks into a Blob this often
const INVENTORY_PAGE = 400;            // fingerprints per message
const IDLE_TIMEOUT = 90_000;           // silence during a transfer means it died
const CONNECT_TIMEOUT = 30_000;        // how long a typed code waits for an answer
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I, O, 0 or 1
const ID_PREFIX = 'offpress-';

/* ============================ network settings ============================ */

/* Same shape, and the same reasoning, as FileBeam's Network panel:

     {
       "iceServers": [
         { "urls": "stun:stun.l.google.com:19302" },
         { "urls": "turn:turn.example.com:3478",
           "username": "user", "credential": "pass" }
       ],
       "forceRelay": false,
       "server": { "host": "peer.example.com", "port": 443,
                   "path": "/", "secure": true, "key": "peerjs" }
     }

   Every field is optional. `forceRelay` sets iceTransportPolicy:'relay', which
   is how you prove your own TURN server actually works; `server` points the
   signalling at your own peerjs-server instead of the public broker. */

export const RTC_STORAGE_KEY = 'offpress.rtc';

/** STUN only. Public binding servers are cheap to run and stay up; a *relay*
 *  carries the traffic itself, so every free public one either dies or rotates
 *  its credentials. Bring your own. */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Shown in the Network box as a fill-in-the-blanks starting point. */
export const TURN_EXAMPLE = {
  urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'],
  username: 'your-username',
  credential: 'your-password',
};

export function loadRtcConfig() {
  let raw = null;
  try { raw = localStorage.getItem(RTC_STORAGE_KEY); } catch { /* private mode */ }
  if (!raw) return { iceServers: DEFAULT_ICE_SERVERS };
  try {
    const parsed = JSON.parse(raw);
    const cfg = {
      iceServers: Array.isArray(parsed.iceServers) && parsed.iceServers.length
        ? parsed.iceServers : DEFAULT_ICE_SERVERS,
    };
    if (parsed.forceRelay) cfg.forceRelay = true;
    if (parsed.server && typeof parsed.server === 'object') cfg.server = parsed.server;
    return cfg;
  } catch {
    return { iceServers: DEFAULT_ICE_SERVERS };
  }
}

/** @returns {{ok:boolean, error?:string, cleared?:boolean}} */
export function saveRtcConfig(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    try { localStorage.removeItem(RTC_STORAGE_KEY); } catch { /* private mode */ }
    return { ok: true, cleared: true };
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (err) { return { ok: false, error: `Not valid JSON: ${err.message}` }; }
  if (parsed.iceServers && !Array.isArray(parsed.iceServers)) {
    return { ok: false, error: '"iceServers" must be an array.' };
  }
  try { localStorage.setItem(RTC_STORAGE_KEY, JSON.stringify(parsed, null, 2)); }
  catch (err) { return { ok: false, error: `Could not save: ${err.message}` }; }
  return { ok: true };
}

const peerOptions = () => {
  const cfg = loadRtcConfig();
  const opts = {
    config: {
      iceServers: cfg.iceServers,
      iceCandidatePoolSize: 2,
      ...(cfg.forceRelay ? { iceTransportPolicy: 'relay' } : {}),
    },
  };
  if (cfg.server) Object.assign(opts, cfg.server);
  return opts;
};

export const available = () =>
  typeof RTCPeerConnection !== 'undefined' && typeof RTCPeerConnection.prototype.createDataChannel === 'function';

/**
 * Gather candidates against the configured servers, so the app can say whether
 * a relay is reachable *before* a transfer is attempted rather than after it
 * has silently failed.
 */
export async function probeIce(iceServers = loadRtcConfig().iceServers, timeoutMs = 8000) {
  if (!available()) return { srflx: false, relay: false, error: 'WebRTC unavailable' };
  const found = { srflx: false, relay: false };
  let pc = null;
  try {
    pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('probe');
    const settled = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return finish();
        const c = ev.candidate.candidate || '';
        if (c.includes(' typ srflx')) found.srflx = true;
        if (c.includes(' typ relay')) { found.relay = true; finish(); }
      };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(); };
      setTimeout(finish, timeoutMs);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await settled;
  } catch (err) {
    found.error = err?.message || String(err);
  } finally {
    if (pc) { try { pc.close(); } catch { /* already gone */ } }
  }
  return found;
}

/** Which path did a live connection actually settle on? Worth showing: "direct,
 *  local network" and "relayed via TURN" differ by an order of magnitude. */
async function selectedPathKind(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
    });
    if (!pair) return null;
    const types = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType];
    if (types.includes('relay')) return 'relayed via TURN';
    if (types.includes('srflx') || types.includes('prflx')) return 'direct, through NAT';
    return 'direct, local network';
  } catch { return null; }
}

/* ============================== the library =============================== */

let libPromise = null;

/** PeerJS is a UMD bundle rather than a module, so it goes in as a script tag.
 *  Loaded on demand: nobody who never beams anything pays for it. */
function loadPeerJs() {
  if (typeof window !== 'undefined' && window.Peer) return Promise.resolve(window.Peer);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = new URL('./vendor/peerjs.min.js', import.meta.url).href;
    el.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('The peer library did not register')));
    el.onerror = () => { libPromise = null; reject(new Error('Could not load the peer library')); };
    document.head.appendChild(el);
  });
  return libPromise;
}

/* ================================= codes ================================== */

export function makeCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** What the user typed, back into what was generated: case, spaces and the
 *  hyphen the code is displayed with are all noise. */
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const isCode = (s) => /^[A-Z0-9]{6}$/.test(normalizeCode(s));

/** ABCDEF → ABC-DEF, which is what people read back over a phone. */
export const prettyCode = (s) => {
  const c = normalizeCode(s);
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
};

export const beamLink = (code) =>
  `${location.origin}${location.pathname}#beam=${normalizeCode(code)}`;

/** A link opened on the other device: #beam=ABC123. */
export function parseBeamHash(hash = location.hash) {
  const m = String(hash || '').match(/[#&]beam=([A-Za-z0-9-]+)/);
  const code = m ? normalizeCode(m[1]) : '';
  return isCode(code) ? code : null;
}

/** A name for this device, so the other end knows what it is talking to. */
export function deviceName() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows'
        : /Mac OS X/i.test(ua) ? 'macOS'
          : /Linux/i.test(ua) ? 'Linux' : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

/* ================================ session ================================= */

/**
 * One beam, from the moment a code exists to the moment the channel closes.
 *
 * Events (`session.on(name, fn)`):
 *   status(text, kind)   something worth putting on screen
 *   ready(info)          both inventories are in — `info.summary` is the diff
 *   phase(text)          a transfer phase started
 *   progress(fraction, sub)
 *   done(result)         the sync finished; result counts what changed here
 *   error(err)
 *   closed()
 */
class BeamSession {
  constructor({ isHost, code }) {
    this.isHost = isHost;
    this.code = code;
    this.state = 'starting';   // starting | waiting | connected | ready | running | done | closed
    this.peer = null;
    this.conn = null;
    this.remote = null;        // their hello
    this.mine = null;          // my inventory
    this.theirs = null;        // theirs
    this.pathKind = null;
    this.plan = null;          // the agreed plan, once started
    this.result = { added: 0, filled: 0, skipped: 0, sent: 0, settings: 0, failed: [] };

    this._handlers = new Map();
    this._invIn = null;        // inventory being assembled
    this._pending = null;      // track being received
    this._file = null;         // file being received
    this._albums = [];         // album messages, applied by the caller at the end
    this._settings = null;     // held until the phase ends, in case a backdrop follows
    this._backdrop = null;
    this._chain = Promise.resolve();
    this._closed = false;
    this._aborted = null;
    this._idle = null;
    this._sentBytes = 0;
    this._recvBytes = 0;
    this._phaseBytes = 0;
  }

  /* ------------------------------- events -------------------------------- */

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, []);
    this._handlers.get(name).push(fn);
    return this;
  }

  _emit(name, ...args) {
    for (const fn of this._handlers.get(name) || []) {
      try { fn(...args); } catch (err) { console.warn(`[beam] ${name} handler failed`, err); }
    }
  }

  _status(text, kind = '') { this._emit('status', text, kind); }

  _fail(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this._closed) return;
    this._emit('error', error);
    this.close();
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Wire up a data connection, whichever side opened it. */
  _attach(conn) {
    this.conn = conn;
    this._watchIce(conn);
    // The host waits for a person to walk to the other device, so it waits as
    // long as it takes. The guest is answering a code that was just read out:
    // if that has not connected in half a minute, something is wrong and saying
    // so beats a spinner that never stops.
    const reach = this.isHost ? null : setTimeout(() => {
      if (this.state === 'waiting') {
        this._fail(new Error('No answer from that code. It may have expired, or this network may be '
          + 'blocking the connection — check that the other device is still waiting.'));
      }
    }, CONNECT_TIMEOUT);
    conn.on('open', () => {
      if (reach) clearTimeout(reach);
      this.state = 'connected';
      this._status('Connected. Comparing libraries…', 'good');
      this._chain = this._chain.then(() => this._greet()).catch((err) => this._fail(err));
    });
    conn.on('data', (msg) => this._onData(msg));
    conn.on('close', () => {
      if (this.state === 'running') this._fail(new Error('The other device disconnected'));
      else this.close();
    });
    conn.on('error', (err) => this._fail(err));
  }

  /** PeerJS makes the RTCPeerConnection lazily, so poll briefly for it. */
  _watchIce(conn) {
    let tries = 0;
    const attach = () => {
      const pc = conn?.peerConnection;
      if (!pc) { if (tries++ < 40) setTimeout(attach, 50); return; }
      const handler = async () => {
        const s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
          const kind = await selectedPathKind(pc);
          if (kind && kind !== this.pathKind) { this.pathKind = kind; this._emit('path', kind); }
        } else if (s === 'failed') {
          this._fail(new Error('Could not open a path to the other device (ICE failed). '
            + 'This network needs a TURN relay — see Network below.'));
        }
      };
      pc.addEventListener('iceconnectionstatechange', handler);
      handler();
    };
    attach();
  }

  _send(msg) {
    if (!this.conn?.open) throw new Error('The connection is gone');
    this.conn.send(msg);
  }

  async _greet() {
    this.mine = await sync.buildInventory();
    this._send({
      t: 'hello',
      proto: BEAM_PROTO,
      app: 'offpress',
      version: APP_VERSION,
      device: deviceName(),
      tracks: this.mine.tracks.length,
    });
    // Covers and records ride on the first page; tracks are paged because a big
    // library's fingerprints are the one message here that can get large.
    this._send({ t: 'inv', tracks: this.mine.tracks.slice(0, INVENTORY_PAGE), art: this.mine.art, albums: this.mine.albums });
    for (let i = INVENTORY_PAGE; i < this.mine.tracks.length; i += INVENTORY_PAGE) {
      this._send({ t: 'inv', tracks: this.mine.tracks.slice(i, i + INVENTORY_PAGE), art: [], albums: [] });
    }
    this._send({ t: 'inv-end' });
  }

  /** Both sides have described themselves: the diff can be shown. */
  _maybeReady() {
    if (!this.theirs || !this.mine || this.state === 'ready' || this.state === 'running') return;
    this.state = 'ready';
    this._emit('ready', {
      remote: this.remote,
      mine: this.mine,
      theirs: this.theirs,
      summary: sync.summarize(this.mine, this.theirs),
    });
  }

  /**
   * Begin. Host only — one device decides, so the two can never disagree about
   * who is sending. Resolves when this device has finished *its* half; the sync
   * as a whole is over at the `done` event.
   *
   * @param {'push'|'pull'|'mirror'} o.mode from *this* device's point of view
   * @param {string[]|null} [o.only] track ids, for beaming a record rather than
   *        syncing everything
   * @param {'none'|'push'|'pull'} [o.settings]
   */
  async start({ mode = 'mirror', only = null, settings = 'none' } = {}) {
    if (!this.isHost) throw new Error('Only the device that started the session can begin the sync');
    if (this.state !== 'ready') throw new Error('Not connected yet');
    this.plan = { mode, only, settings };
    this.state = 'running';
    this._send({ t: 'plan', mode, only: !!only, settings, proto: BEAM_PROTO });

    /* One direction at a time, host first: two libraries streaming over one
       channel at once would halve both progress bars and explain nothing. The
       handover is a single `turn` message, and the guest's `done` ends it. */
    try {
      if (this._iPush()) await this._push(only, this._iSendSettings());
      this._send({ t: 'turn' });
    } catch (err) {
      this._fail(err);
    }
  }

  /** Does this device send, under the agreed plan? The mode is written from the
   *  host's point of view, so the guest reads it inverted. */
  _iPush() {
    const mode = this.plan?.mode || 'mirror';
    return mode === 'mirror' || (this.isHost ? mode === 'push' : mode === 'pull');
  }

  _iSendSettings() {
    const s = this.plan?.settings || 'none';
    return s !== 'none' && (this.isHost ? s === 'push' : s === 'pull');
  }

  /** Everything this device owes the other one. */
  async _push(only, withSettings) {
    const plan = sync.planPush(this.mine, this.theirs, { only });
    this._emit('phase', 'sending');
    this._send({ t: 'phase', tracks: plan.items.length, bytes: plan.bytes });
    this._sentBytes = 0;
    const total = plan.bytes || 1;
    const touched = new Set();

    for (const item of plan.items) {
      if (this._aborted) throw new Error(this._aborted);
      const track = await db.get('tracks', item.id);
      if (!track) continue;
      const { audio, original, art } = await sync.readTrackPayload(track);
      const artMeta = art ? (({ full, thumb, ...rest }) => rest)(art) : null;
      const sendArt = !!art && !sync.hasArt(this.theirs, art);

      this._send({
        t: 'track',
        record: sync.packTrack(track),
        art: artMeta,
        artBytes: sendArt,
        audio: !!audio,
        original: !!original,
      });
      if (sendArt) {
        if (art.full) await this._sendFile('art-full', art.full);
        if (art.thumb) await this._sendFile('art-thumb', art.thumb);
      }
      if (audio) await this._sendFile('audio', audio, (sent) => {
        this._emit('progress', (this._sentBytes + sent) / total, `${track.title || track.fileName}`);
      });
      if (original) await this._sendFile('original', original);
      this._send({ t: 'track-end', hash: track.hash });

      this._sentBytes += audio ? audio.size : 0;
      this.result.sent++;
      touched.add(track.albumKey);
      this._emit('progress', this._sentBytes / total, track.title || track.fileName || '');
    }

    // Records last: by now the other side has the tracks their order refers to.
    for (const album of await db.getAll('albums')) {
      if (!touched.has(album.key)) continue;
      this._send({
        t: 'album',
        record: sync.albumFingerprint(album),
        orderHashes: await sync.albumOrderHashes(album),
      });
    }

    if (withSettings) {
      const settings = await db.settings();
      const backdrop = settings.backdropImage instanceof Blob ? settings.backdropImage : null;
      this._send({ t: 'settings', values: sync.syncableSettings(settings), backdrop: !!backdrop });
      if (backdrop) await this._sendFile('backdrop', backdrop);
    }
  }

  /**
   * One blob, chunked, with the channel's own buffer as the brake. Slicing
   * reads lazily from wherever the browser put the blob, so a 60 MB track never
   * sits in the heap.
   */
  async _sendFile(kind, blob, onBytes = null) {
    this._send({ t: 'file', kind, size: blob.size, mime: blob.type || '' });
    const dc = this.conn?.dataChannel || null;
    if (dc) { try { dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER; } catch { /* older impl */ } }

    let offset = 0;
    let since = 0;
    while (offset < blob.size) {
      if (this._aborted) throw new Error(this._aborted);
      if (!this.conn?.open) throw new Error('The connection closed mid-transfer');
      const end = Math.min(offset + CHUNK_SIZE, blob.size);
      this.conn.send(await blob.slice(offset, end).arrayBuffer());
      offset = end;
      since++;
      onBytes?.(offset);

      if (dc && dc.bufferedAmount > BUFFER_HIGH_WATER) {
        since = 0;
        await new Promise((resolve) => {
          const handler = () => { dc.removeEventListener('bufferedamountlow', handler); resolve(); };
          dc.addEventListener('bufferedamountlow', handler);
          setTimeout(() => { dc.removeEventListener('bufferedamountlow', handler); resolve(); }, 1000);
        });
      } else if (since >= 32) {
        since = 0;
        await new Promise((r) => setTimeout(r, 0));   // let the UI breathe
      }
    }
    this._send({ t: 'file-end', kind, size: blob.size });
  }

  /* ------------------------------ receiving ------------------------------ */

  /** PeerJS delivers data synchronously; an async handler would interleave and
   *  write chunks out of order, so everything funnels through one chain. */
  _serial(fn) {
    this._chain = this._chain.then(fn).catch((err) => this._fail(err));
    return this._chain;
  }

  _onData(msg) {
    this._touch();
    const u8 = msg instanceof ArrayBuffer ? new Uint8Array(msg)
      : ArrayBuffer.isView(msg) ? new Uint8Array(msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength))
        : null;
    if (u8) {
      this._recvBytes += u8.byteLength;
      this._serial(() => this._chunk(u8));
      return;
    }
    if (!msg || typeof msg !== 'object' || !msg.t) return;
    this._serial(() => this._control(msg));
  }

  async _chunk(u8) {
    const f = this._file;
    if (!f) throw new Error('Received file data with no file open');
    f.pending.push(u8);
    f.bytes += u8.byteLength;
    f.pendingBytes += u8.byteLength;
    if (f.pendingBytes >= FOLD_BYTES) {
      // Fold into a Blob the browser is free to spill to disk, so a big track
      // never costs its own size in JS heap.
      f.parts.push(new Blob(f.pending));
      f.pending = [];
      f.pendingBytes = 0;
    }
    if (this._phaseBytes) {
      this._emit('progress', this._recvBytes / this._phaseBytes, this._pending?.record?.title || '');
    }
  }

  async _control(msg) {
    switch (msg.t) {
      case 'hello': {
        if (msg.app !== 'offpress') throw new Error('The other device is not running Offpress');
        if ((msg.proto || 0) > BEAM_PROTO) {
          throw new Error(`The other device speaks a newer beam protocol (v${msg.proto}) — update this one`);
        }
        this.remote = { device: msg.device || 'device', version: msg.version || '?', tracks: msg.tracks || 0 };
        this._invIn = sync.emptyInventory();
        this._emit('peer', this.remote);
        return;
      }
      case 'inv': {
        if (!this._invIn) this._invIn = sync.emptyInventory();
        this._invIn.tracks.push(...(msg.tracks || []));
        this._invIn.art.push(...(msg.art || []));
        this._invIn.albums.push(...(msg.albums || []));
        return;
      }
      case 'inv-end': {
        this.theirs = this._invIn || sync.emptyInventory();
        this._invIn = null;
        this._maybeReady();
        return;
      }
      case 'plan': {
        // The guest takes the host's plan as given, and waits for its turn.
        if (this.isHost) return;
        this.plan = { mode: msg.mode, only: msg.only, settings: msg.settings };
        this.state = 'running';
        this._emit('planned', this.plan);
        return;
      }
      case 'phase': {
        this._phaseBytes = msg.bytes || 0;
        this._recvBytes = 0;
        this._emit('phase', 'receiving');
        this._emit('progress', 0, `${msg.tracks} track${msg.tracks === 1 ? '' : 's'} incoming`);
        return;
      }
      case 'track': {
        this._pending = { record: msg.record, art: msg.art || null, artBytes: !!msg.artBytes, files: {} };
        return;
      }
      case 'file': {
        this._file = {
          kind: msg.kind, size: msg.size || 0, mime: msg.mime || '',
          parts: [], pending: [], pendingBytes: 0, bytes: 0,
        };
        return;
      }
      case 'file-end': {
        const f = this._file;
        this._file = null;
        if (!f) return;
        if (f.bytes !== (msg.size || 0)) {
          throw new Error(`A file arrived short (${f.bytes} of ${msg.size} bytes) — the transfer was truncated`);
        }
        if (f.pending.length) f.parts.push(new Blob(f.pending));
        const blob = new Blob(f.parts, { type: f.mime });
        if (f.kind === 'backdrop') this._backdrop = blob;
        else if (this._pending) this._pending.files[f.kind] = blob;
        return;
      }
      case 'track-end': {
        const p = this._pending;
        this._pending = null;
        if (!p) return;
        try {
          const artId = p.art
            ? await sync.commitArt(p.art, { full: p.files['art-full'], thumb: p.files['art-thumb'] })
            : null;
          const what = await sync.commitTrack(p.record, {
            audio: p.files.audio || null,
            original: p.files.original || null,
            artId,
          });
          this.result[what === 'added' ? 'added' : what === 'filled' ? 'filled' : 'skipped']++;
          this._emit('track', what, p.record);
        } catch (err) {
          this.result.failed.push(`${p.record?.title || p.record?.id}: ${err.message}`);
        }
        return;
      }
      case 'album': {
        this._albums.push({ record: msg.record, orderHashes: msg.orderHashes || null });
        return;
      }
      case 'settings': {
        // Held rather than applied: a backdrop picture may still be on its way,
        // and settings that arrive in two pieces should land as one change.
        this._settings = msg.values || {};
        if (!msg.backdrop) await this._flushSettings();
        return;
      }
      case 'turn': {
        // The host has finished its half. Anything this device owes goes now,
        // and `done` closes the exchange for both of us.
        await this._flushSettings();
        if (!this.isHost && this._iPush()) await this._push(null, this._iSendSettings());
        this._send({ t: 'done' });
        this._finish();
        return;
      }
      case 'done': {
        await this._flushSettings();
        this._finish();
        return;
      }
      case 'abort': {
        throw new Error(msg.reason ? `The other device stopped: ${msg.reason}` : 'The other device stopped the beam');
      }
      default:
    }
  }

  /** Preferences land once, with their picture if one came. */
  async _flushSettings() {
    if (!this._settings) return;
    const values = this._settings;
    const backdrop = this._backdrop;
    this._settings = null;
    this._backdrop = null;
    this.result.settings += await sync.applySettings(values, backdrop || null);
  }

  _finish() {
    if (this.state === 'done' || this._closed) return;
    this.state = 'done';
    this._stopIdle();
    this._emit('done', { ...this.result, albums: this._albums });
  }

  /* -------------------------------- idle --------------------------------- */

  _touch() {
    if (this.state !== 'running') return;
    this._stopIdle();
    this._idle = setTimeout(() => {
      this._fail(new Error('The other device went quiet — the beam timed out'));
    }, IDLE_TIMEOUT);
  }

  _stopIdle() { if (this._idle) { clearTimeout(this._idle); this._idle = null; } }

  /* ------------------------------- closing ------------------------------- */

  abort(reason = 'cancelled') {
    this._aborted = reason;
    try { this.conn?.open && this._send({ t: 'abort', reason }); } catch { /* already gone */ }
    this.close();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._stopIdle();
    this.state = 'closed';
    try { this.conn?.close(); } catch { /* already gone */ }
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this._emit('closed');
  }
}

/* ------------------------------- entry points ----------------------------- */

/** Open a session and wait for the other device. Resolves as soon as the broker
 *  has given us the code — the peer arrives later, as a `peer` event. */
export async function host() {
  const Peer = await loadPeerJs();
  const session = new BeamSession({ isHost: true, code: null });

  await new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOnce = () => {
      const code = makeCode();
      const peer = new Peer(`${ID_PREFIX}${code}`, peerOptions());
      session.peer = peer;
      peer.on('open', () => {
        session.code = code;
        session.state = 'waiting';
        resolve();
      });
      peer.on('connection', (conn) => {
        // One device at a time: a second one arriving mid-sync is a wrong code,
        // not a queue.
        if (session.conn) { try { conn.close(); } catch { /* fine */ } return; }
        session._attach(conn);
      });
      peer.on('error', (err) => {
        if (err?.type === 'unavailable-id' && attempts++ < 3) {
          try { peer.destroy(); } catch { /* fine */ }
          tryOnce();
          return;
        }
        if (session.state === 'starting') reject(brokerError(err));
        else session._fail(brokerError(err));
      });
    };
    tryOnce();
  });

  return session;
}

/** Join the session behind a code. */
export async function join(code) {
  const clean = normalizeCode(code);
  if (!isCode(clean)) throw new Error('A beam code is six letters and digits');
  const Peer = await loadPeerJs();
  const session = new BeamSession({ isHost: false, code: clean });

  await new Promise((resolve, reject) => {
    const peer = new Peer(peerOptions());
    session.peer = peer;
    peer.on('open', () => {
      session.state = 'waiting';
      session._attach(peer.connect(`${ID_PREFIX}${clean}`, { reliable: true }));
      resolve();
    });
    peer.on('error', (err) => {
      const wrapped = err?.type === 'peer-unavailable'
        ? new Error('No device is waiting behind that code. Codes die when the other tab closes.')
        : brokerError(err);
      if (session.state === 'starting') reject(wrapped);
      else session._fail(wrapped);
    });
  });

  return session;
}

/**
 * Two sessions wired to each other inside one page: no broker, no network, no
 * WebRTC. It speaks the same protocol over the same code path as a real beam —
 * the only thing missing is the wire — which makes it the seam the tests drive,
 * and a way to exercise the whole exchange when there is nothing to connect to.
 */
export function loopback() {
  const link = () => {
    const handlers = new Map();
    return {
      open: false,
      other: null,
      dataChannel: null,
      peerConnection: null,
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(fn);
      },
      emit(ev, ...args) { for (const fn of handlers.get(ev) || []) fn(...args); },
      send(msg) {
        if (!this.open) throw new Error('The connection is gone');
        // Copied and delivered on a later tick, exactly as a real channel would:
        // a handler that mutated what it received must not reach back here.
        const copy = msg instanceof ArrayBuffer ? msg.slice(0) : msg;
        setTimeout(() => this.other.emit('data', copy), 0);
      },
      close() {
        if (!this.open) return;
        this.open = false;
        setTimeout(() => { this.emit('close'); this.other?.close(); }, 0);
      },
    };
  };

  const a = link();
  const b = link();
  a.other = b;
  b.other = a;
  const host = new BeamSession({ isHost: true, code: 'LOOPBK' });
  const guest = new BeamSession({ isHost: false, code: 'LOOPBK' });
  host._attach(a);
  guest._attach(b);
  setTimeout(() => { a.open = true; b.open = true; a.emit('open'); b.emit('open'); }, 0);
  return { host, guest };
}

function brokerError(err) {
  const type = err?.type || '';
  if (type === 'network' || type === 'server-error' || type === 'socket-error') {
    return new Error('Could not reach the signalling broker. A beam needs a network to introduce the two devices, even on the same Wi-Fi.');
  }
  if (type === 'browser-incompatible') return new Error('This browser cannot do WebRTC data channels');
  return new Error(err?.message || `Peer error: ${type || 'unknown'}`);
}
