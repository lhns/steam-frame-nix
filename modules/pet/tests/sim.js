// The scripted world of the core's tests (core.test.js, species.test.js):
// the user at (0, 1.6) looking toward -z, a right hand moved by a script,
// deterministic randomness, every clip shown and prefetched recorded.
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'core.js'));
const HZ = 24, DT = 1 / HZ;

// Deterministic randomness (mulberry32); SEED_OFFSET=n: other random runs.
function seed(s) {
  s += +process.env.SEED_OFFSET || 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A core on `baked` in the scripted world. setScript(f): the right hand
// follows f(t, api) -> { x, y, z, press, carried } | null (velocity by finite
// differences, like a tracked controller's). press >= 0.5: the laser drags
// the pet by the scruff (world.held(), as systemui.js' drag), the grab point
// the hand's position; with `carried` ({ p, q }: where the adapter's
// compositor has it, systemui.js' root carried by the hand)
// world.heldPose() reports that. A shown clip or frame that is not baked
// throws.
function sim(baked, seedValue, { opts = {}, saved } = {}) {
  seed(seedValue);
  const head = { x: 0, y: 1.6, z: 1.6, fx: 0, fz: -1 };
  let script = () => null, t = 0, prev = null, hand = null, held = null, carried = null;
  const shown = [], asked = new Set(), logs = [];
  const world = {
    head: () => head,
    hands: () => ({ left: null, right: hand }),
    held: () => held,
    heldPose: () => (carried ? { x: carried.p[0], y: carried.p[1], z: carried.p[2], q: carried.q } : null),
    show: (clip, frame, at) => {
      if (!baked.clips[clip] || frame < 0 || frame >= baked.clips[clip].frames) throw new Error(`shown ${clip} ${frame}: not baked`);
      shown.push({ t, clip, frame, ...at });
    },
    prefetch: (clips) => { for (const c of clips) asked.add(c); },
    ready: () => true,
    load: () => saved, save: () => {},
    log: (...a) => logs.push(`${t.toFixed(2)} ${a.join(' ')}`),
  };
  const cat = Core.create(world, opts, baked);
  const api = {
    cat, shown, asked, logs,
    get t() { return t; },
    setScript(f) { script = f; prev = null; },
    run(seconds, check) {
      for (let end = t + seconds - 1e-9; t < end;) {
        t += DT;
        const p = script(t, api);
        hand = p ? { x: p.x, y: p.y, z: p.z,
          vx: prev ? (p.x - prev.x) / DT : 0, vy: prev ? (p.y - prev.y) / DT : 0, vz: prev ? (p.z - prev.z) / DT : 0 } : null;
        prev = p;
        carried = p?.press >= 0.5 && p.carried ? p.carried : (p?.carried && held ? p.carried : null);   // (read on the release tick too)
        held = p?.press >= 0.5 ? (p.carried ? { source: 'laser', hand: 'right' } : { source: 'laser', hand: 'right', ...hand }) : null;
        cat.tick(DT);
        check?.(cat.state(), t);
      }
      return cat.state();
    },
    zone: (n) => cat.zone(n),
    clipsShown: () => new Set(shown.map((s) => s.clip)),
    // A hand moving toward `target()` at most `speed` m/s (no teleports).
    toward(target, speed = 0.3, press = 0) {
      let at = null;
      return () => {
        const g = target();
        if (!at) at = { ...g };
        const d = Math.hypot(g.x - at.x, g.y - at.y, g.z - at.z), k = d > speed * DT ? speed * DT / d : 1;
        at = { x: at.x + (g.x - at.x) * k, y: at.y + (g.y - at.y) * k, z: at.z + (g.z - at.z) * k };
        return { ...at, press: typeof press === 'function' ? press() : press };
      };
    },
  };
  cat.tick(DT);           // placed in front of the user
  cat.command('stand');   // calm start: rests 20 s
  return api;
}

// A synchronous test runner: test(name, f), then done().
let failed = 0;
function test(name, f) {
  try { f(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function done() {
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('all passed');
}

module.exports = { Core, DT, seed, sim, test, assert, near, done };
