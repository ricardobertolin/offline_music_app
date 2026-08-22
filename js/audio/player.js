/** Playback with per-track (or per-album) loudness gain applied live.
 *
 *  <audio> → MediaElementSource → normalization gain → optional limiter → out.
 *  Nothing is written back to the file: the same library plays correctly whatever
 *  the target loudness is set to. */

import { dbToGain } from '../util.js';

export class Player {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'metadata';
    this.el.crossOrigin = 'anonymous';
    this.ctx = null;
    this.src = null;
    this.gainNode = null;
    this.limiterNode = null;
    this.limiterOn = true;
    this.gainDb = 0;
    this.track = null;
    this.url = null;
    this.handlers = {};

    for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'error', 'loadedmetadata']) {
      this.el.addEventListener(ev, () => this.emit(ev));
    }
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }

  /** The graph can only be built once we're allowed to make an AudioContext. */
  ensureGraph() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.src = this.ctx.createMediaElementSource(this.el);
    this.gainNode = this.ctx.createGain();
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1.5;
    this.limiterNode.knee.value = 0;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0.003;
    this.limiterNode.release.value = 0.12;
    this.connectGraph();
    this.applyGain();
  }

  connectGraph() {
    if (!this.ctx) return;
    try { this.src.disconnect(); this.gainNode.disconnect(); this.limiterNode.disconnect(); } catch { /* first run */ }
    this.src.connect(this.gainNode);
    if (this.limiterOn) this.gainNode.connect(this.limiterNode).connect(this.ctx.destination);
    else this.gainNode.connect(this.ctx.destination);
  }

  setLimiter(on) {
    this.limiterOn = !!on;
    this.connectGraph();
  }

  /** Normalization gain in dB, ramped so switching modes mid-song doesn't click. */
  setGainDb(db) {
    this.gainDb = Number.isFinite(db) ? db : 0;
    this.applyGain();
    this.emit('gain', this.gainDb);
  }

  applyGain() {
    if (!this.gainNode) return;
    const v = dbToGain(this.gainDb);
    const t = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(t);
    this.gainNode.gain.setTargetAtTime(v, t, 0.02);
  }

  async load(track, blob, { gainDb = 0, autoplay = true } = {}) {
    this.ensureGraph();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.track = track;
    this.el.src = this.url;
    this.setGainDb(gainDb);
    this.emit('track', track);
    if (autoplay) await this.play();
  }

  async play() {
    this.ensureGraph();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    try { await this.el.play(); } catch (e) { this.emit('blocked', e); }
  }

  pause() { this.el.pause(); }
  toggle() { return this.el.paused ? this.play() : (this.pause(), Promise.resolve()); }
  seek(sec) { if (isFinite(sec)) this.el.currentTime = sec; }
  get duration() { return this.el.duration || this.track?.duration || 0; }
  get position() { return this.el.currentTime || 0; }
  get playing() { return !this.el.paused && !this.el.ended; }
  setVolume(v) { this.el.volume = Math.max(0, Math.min(1, v)); }

  stop() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.track = null;
  }
}
