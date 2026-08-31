/** Beam planning checks. The decision of what travels between two devices is
 *  pure — inventories in, a list of tracks out — so it runs here without a
 *  browser, a database or a peer.
 *  Run with:  node tests/sync.test.mjs  */

import {
  planPush, summarize, trackFingerprint, artFingerprint, artKey, hasArt,
  holdsAudio, syncableSettings, DEVICE_LOCAL, emptyInventory,
} from '../js/sync.js';
import { makeCode, normalizeCode, isCode, prettyCode, parseBeamHash } from '../js/beam.js';

let fails = 0;
const ok = (name, cond, info = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

let n = 0;
/** A track with just enough shape for a fingerprint to mean something. */
const track = (o = {}) => ({
  id: o.id || `t${++n}`,
  hash: o.hash || `h${n}`,
  title: o.title || `Track ${n}`,
  album: o.album || 'Album',
  albumKey: o.albumKey || 'artist :: album',
  size: o.size ?? 5_000_000,
  needsAudio: !!o.needsAudio,
  needsRelink: !!o.needsRelink,
  analyzed: o.analyzed !== false,
  source: o.source || 'blob',
});

const inv = (tracks, art = [], albums = []) => ({
  proto: 1,
  tracks: tracks.map(trackFingerprint),
  art,
  albums,
});

/* ------------------------------ fingerprints ------------------------------ */

{
  eq('a stored track holds its audio', holdsAudio(track()), true);
  eq('a row awaiting audio does not', holdsAudio(track({ needsAudio: true })), false);
  eq('a row awaiting a folder link does not', holdsAudio(track({ needsRelink: true })), false);

  const fp = trackFingerprint(track({ hash: 'abc', title: 'One', size: 42 }));
  eq('the fingerprint carries the hash', fp.hash, 'abc');
  eq('...and whether the audio is there', fp.audio, true);
  ok('...and nothing heavy', !('loudness' in fp) && !('quality' in fp));
}

/* ------------------------------ the diff ---------------------------------- */

{
  const mine = inv([track({ hash: 'a' }), track({ hash: 'b' }), track({ hash: 'c' })]);
  const theirs = inv([track({ hash: 'b' })]);
  const plan = planPush(mine, theirs);
  eq('only what they lack goes', plan.items.map((t) => t.hash), ['a', 'c']);
  eq('...counted as new', plan.added, 2);
  eq('...and nothing of it is a fill', plan.fills, 0);
  eq('what they have is skipped', plan.skipped, 1);
  eq('bytes add up to what actually moves', plan.bytes, 10_000_000);
}

{
  // Run twice: the second run has nothing to do. This is the whole point of
  // fingerprinting before sending.
  const mine = inv([track({ hash: 'a' }), track({ hash: 'b' })]);
  const plan = planPush(mine, mine);
  eq('a second run sends nothing', plan.items.length, 0);
  eq('...and no bytes', plan.bytes, 0);
}

{
  // A row restored from a measurements-only backup: they have the track, but
  // not the file. That is exactly what the other device can fix.
  const mine = inv([track({ hash: 'a' })]);
  const theirs = inv([track({ hash: 'a', needsAudio: true })]);
  const plan = planPush(mine, theirs);
  eq('a hollow row on their side is filled', plan.items.map((t) => t.reason), ['fill']);
  eq('...counted as a fill', plan.fills, 1);
  eq('...and turned off on request', planPush(mine, theirs, { fillHollow: false }).items.length, 0);
}

{
  // Neither side can play it, so there is nothing to fill it with.
  const mine = inv([track({ hash: 'a', needsAudio: true })]);
  const theirs = inv([track({ hash: 'a', needsAudio: true })]);
  eq('two empty rows do not trade emptiness', planPush(mine, theirs).items.length, 0);
}

{
  // A track with no audio here still travels when they have never seen it: the
  // analysis, the artwork and the tag edits are worth having on their own.
  const mine = inv([track({ hash: 'a', needsAudio: true, size: 9_000_000 })]);
  const plan = planPush(mine, emptyInventory());
  eq('a measurements-only row still goes', plan.items.length, 1);
  eq('...but weighs nothing on the wire', plan.bytes, 0);
}

{
  const a = track({ id: 'x', hash: 'a' });
  const b = track({ id: 'y', hash: 'b' });
  const mine = inv([a, b]);
  const plan = planPush(mine, emptyInventory(), { only: ['x'] });
  eq('a scoped beam sends only what was picked', plan.items.map((t) => t.hash), ['a']);
}

{
  const mine = inv([track({ hash: 'a' }), track({ hash: 'shared' })]);
  const theirs = inv([track({ hash: 'b' }), track({ hash: 'shared' })]);
  const s = summarize(mine, theirs);
  eq('the summary counts both directions', [s.send.items.length, s.receive.items.length], [1, 1]);
  eq('...and what they already agree on', s.shared, 1);
}

{
  // Nothing about a diff should depend on the order rows come back in.
  const t1 = track({ hash: 'a' }), t2 = track({ hash: 'b' }), t3 = track({ hash: 'c' });
  const forward = planPush(inv([t1, t2, t3]), inv([t2]));
  const backward = planPush(inv([t3, t2, t1]), inv([t2]));
  eq('order does not change the plan',
    forward.items.map((t) => t.hash).sort(), backward.items.map((t) => t.hash).sort());
}

/* -------------------------------- covers ---------------------------------- */

{
  const cover = { id: 'art1', hash: 'pic', size: 512, thumbSize: 128, quality: 0.82 };
  const same = { id: 'other-id', hash: 'pic', size: 512, thumbSize: 128, quality: 0.82 };
  const bigger = { id: 'art2', hash: 'pic', size: 1024, thumbSize: 128, quality: 0.82 };

  eq('the same picture at the same size matches', artKey(cover), artKey(same));
  ok('...at a different size does not', artKey(cover) !== artKey(bigger));
  eq('a cover they hold is not sent again', hasArt({ art: [artFingerprint(same)] }, cover), true);
  eq('a cover they only hold smaller is sent', hasArt({ art: [artFingerprint(bigger)] }, cover), false);
  eq('an empty side has no covers', hasArt(emptyInventory(), cover), false);
}

/* ------------------------------- settings --------------------------------- */

{
  const settings = {
    targetLufs: -16, accent: '#e2542c', volume: 0.3, shuffle: true, phoneColumns: true,
    liveMeter: false, backdropImage: new Blob(['x']), notASetting: 1,
  };
  const out = syncableSettings(settings);
  eq('taste travels', [out.targetLufs, out.accent], [-16, '#e2542c']);
  ok('the device-local ones do not', ![...DEVICE_LOCAL].some((k) => k in out));
  ok('the backdrop blob is not stuffed into JSON', !('backdropImage' in out));
  ok('and neither is anything the app does not know', !('notASetting' in out));
}

/* --------------------------------- codes ---------------------------------- */

{
  const code = makeCode();
  ok('a generated code is six characters', isCode(code), code);
  ok('...with no lookalike characters in it', !/[IO01]/.test(code), code);
  eq('typing it back with a dash still works', normalizeCode('abc-def'), 'ABCDEF');
  eq('...and with spaces', normalizeCode(' a b c d e f '), 'ABCDEF');
  eq('it is shown in two halves', prettyCode('ABCDEF'), 'ABC-DEF');
  eq('a link carries it', parseBeamHash('#beam=ABC234'), 'ABC234');
  eq('a malformed one carries nothing', parseBeamHash('#beam=nope'), null);
  eq('and neither does an unrelated hash', parseBeamHash('#settings'), null);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
