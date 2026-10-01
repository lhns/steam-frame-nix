// Headless tests of the cat's behaviour core (core.js) with scripted hands
// (the world: sim.js).
// usage: node core.test.js <frames.json>   (exit 1 on failure)
// Run by the flake check `pet` (package.nix `tests`).
'use strict';
const fs = require('fs');
const { Core, DT, seed, sim: simOf, test, assert, near, done } = require('./sim.js');
const baked = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const T = Core.THRESHOLDS;
const sim = (s, opts) => simOf(baked, s, { opts });
const M = Core.math;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const qdiff = (a, b) => 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);   // 0: same rotation

// ---------------------------------------------------------------------------

test('held by the scruff (laser drag) -> lift -> release -> fall -> land -> shake/groom/walk off', () => {
  const s = sim(1);
  s.run(1);
  const sc = s.zone('scruff');
  assert(sc && near(sc.y, baked.poseZones.stand.scruff[1], 0.01), `scruff at standing height (${sc?.y})`);
  // The grab point on the scruff, then pressed.
  s.setScript((t) => ({ x: sc.x, y: sc.y + 0.03, z: sc.z, press: 0 }));
  s.run(0.3);
  s.setScript((t) => ({ x: sc.x, y: sc.y + 0.03, z: sc.z, press: 1 }));
  let st = s.run(0.1);
  assert(st.held?.source === 'laser' && st.pose === 'dangle' && st.clip === 'dangle', `held and dangling (${JSON.stringify(st.held)} ${st.pose})`);
  // Lift 0.5 m in 1 s: the scruff follows the hand, offset kept.
  const t0 = s.t;
  s.setScript((t) => ({ x: sc.x, y: sc.y + 0.03 + 0.5 * Math.min(1, (t - t0) / 1), z: sc.z, press: 1 }));
  st = s.run(1.2);
  assert(near(st.y, sc.y + 0.5, 0.01) && near(st.x, sc.x, 0.01) && near(st.z, sc.z, 0.01), `scruff follows the hand (y ${st.y.toFixed(3)})`);
  // Release: falls, lands within the fall time, plays `land`, then an after-landing activity.
  s.setScript(() => ({ x: sc.x, y: sc.y + 0.53, z: sc.z, press: 0 }));
  const clips = new Set();
  let landedAt = null, minY = Infinity;
  st = s.run(0.05);
  assert(st.falling && st.pose === 'fall' && !st.held, `falling after release (${st.pose})`);
  const startY = st.y;
  s.run(1.5, (x, t) => { clips.add(x.clip); minY = Math.min(minY, x.y); if (landedAt === null && !x.falling) landedAt = t; });
  const tFall = Math.sqrt(2 * startY / T.GRAVITY);
  assert(landedAt !== null && landedAt - t0 - 1.2 < tFall + 0.15, `landed in time (fall from ${startY.toFixed(2)} m, ${(landedAt - t0 - 1.2).toFixed(2)} s, free fall ${tFall.toFixed(2)} s)`);
  assert(minY >= 0, 'never below the floor');
  assert(clips.has('land'), `land clip played (${[...clips]})`);
  st = s.run(3, (x) => clips.add(x.clip));
  assert(['shake', 'groom', 'walk', 'sitdown', 'walkstart'].some((c) => clips.has(c)), `shakes, grooms or walks off after landing (${[...clips]})`);
});

test('slow petting on the back -> purr; hand away -> stops', () => {
  const s = sim(4);
  s.run(0.5);
  // Stroke from the scruff to the back and back, 3 cm above, ~0.15 m/s.
  s.setScript((t) => {
    const a = s.zone('scruff'), b = s.zone('back'), u = 0.5 - 0.5 * Math.cos(t * 2.2);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u + 0.03, z: a.z + (b.z - a.z) * u, press: 0 };
  });
  let purredAt = null;
  const t0 = s.t;
  let st = s.run(2.5, (x, t) => { if (purredAt === null && x.purring) purredAt = t - t0; });
  assert(purredAt !== null && purredAt >= T.PET_TIME - 0.05 && purredAt < T.PET_TIME + 0.4, `purrs after ~${T.PET_TIME} s of strokes (${purredAt})`);
  assert(['purr', 'sitpurr', 'liepurr'].includes(st.pose) && ['purr', 'sitpurr', 'liepurr'].includes(st.clip), `purr pose and loop (${st.pose}/${st.clip})`);
  assert(st.activity === 'petted', `activity petted (${st.activity})`);
  // Repeated strokes keep it going.
  st = s.run(4, (x) => assert(x.purring, 'stopped purring while stroked'));
  // Hand away: stops after PURR_LINGER, back to the base pose.
  s.setScript(() => ({ x: 0.6, y: 1.1, z: 1.4, press: 0 }));
  st = s.run(T.PURR_LINGER - 0.3);
  assert(st.purring, 'lingers a moment');
  st = s.run(1.5);
  assert(!st.purring && ['stand', 'sit', 'lie'].includes(st.goal), `stopped, back to ${st.goal}`);
});

test('petting a sitting cat -> sitpurr; a sleeping cat wakes to liepurr', () => {
  for (const [pose, want] of [['sit', 'sitpurr'], ['sleep', 'liepurr']]) {
    const s = sim(5);
    s.run(0.2);
    s.cat.command(pose);
    s.run(5);
    assert(s.cat.state().pose === pose, `${pose} reached (${s.cat.state().pose})`);
    s.setScript(s.toward(() => { const h = s.zone('head'); return { x: h.x, y: h.y + 0.04, z: h.z }; }));
    const st = s.run(4);
    assert(st.pose === want && st.purring, `${pose} -> ${want} (${st.pose})`);
  }
});

test('fast swipe past the cat -> startle, backs off away from the hand, wary', () => {
  const s = sim(6);
  s.run(1);
  const hd = s.zone('head');
  const t0 = s.t, from = { x: hd.x - 0.6, z: hd.z };
  // 1.5 m/s sideways swipe through the head, 5 cm above it.
  s.setScript((t) => ({ x: from.x + 1.5 * (t - t0), y: hd.y + 0.05, z: hd.z, press: 0 }));
  const clips = new Set();
  let st = s.run(0.8, (x) => clips.add(x.clip));
  assert(clips.has('startle'), `startle clip played (${[...clips]})`);
  const c0 = { x: st.x, z: st.z };
  s.setScript(() => null);
  st = s.run(5, (x) => clips.add(x.clip));
  assert(clips.has('walk'), 'walks off');
  const moved = Math.hypot(st.x - c0.x, st.z - c0.z);
  assert(moved > 0.4, `backed off (${moved.toFixed(2)} m)`);
  // Wary: slow petting right after does not make it purr.
  const s2 = sim(6);
  s2.run(1);
  const h2 = s2.zone('head'), t2 = s2.t;
  s2.setScript((t) => ({ x: h2.x - 0.6 + 1.5 * (t - t2), y: h2.y + 0.05, z: h2.z, press: 0 }));
  s2.run(0.6);
  s2.setScript(s2.toward(() => { const h = s2.zone('back'); return { x: h.x, y: h.y + 0.03, z: h.z }; }));
  s2.run(3, (x) => assert(!x.purring, 'purred while wary'));
});

test('slow hand near the cat does not startle; resting hand counts as petting', () => {
  const s = sim(7);
  s.run(1);
  const b = s.zone('back');
  s.setScript(() => ({ x: b.x, y: b.y + 0.04, z: b.z, press: 0 }));
  const clips = new Set();
  const st = s.run(2, (x) => clips.add(x.clip));
  assert(!clips.has('startle'), 'startled by a still hand');
  assert(st.purring, 'a resting hand on the back makes it purr');
});

test('idle life: grooms and stretches over a calm half hour', () => {
  const s = sim(9);
  const clips = new Map();
  s.run(30 * 60, (x) => clips.set(x.clip, (clips.get(x.clip) ?? 0) + 1));
  const starts = (a) => s.logs.filter((l) => l.endsWith(`action ${a}`)).length;
  const n = { groom: starts('groom'), stretch: starts('stretch'), shake: starts('shake') };
  assert(n.groom >= 1 && n.stretch >= 1, `groom / stretch in 30 min (${JSON.stringify(n)})`);
  // Cooldowns hold: no two grooms closer than their cooldown.
  const times = s.logs.filter((l) => l.endsWith('action groom')).map((l) => parseFloat(l));
  for (let i = 1; i < times.length; i++) assert(times[i] - times[i - 1] >= T.COOLDOWN.groom, `groom cooldown (${times[i] - times[i - 1]} s)`);
  console.log(`     30 min: ${JSON.stringify(n)} actions, clips ${[...clips.keys()].join(' ')}`);
});

test('pose maths: relative / compose round trip; yaw', () => {
  seed(11);
  const r = () => Math.random() * 2 - 1;
  for (let i = 0; i < 200; i++) {
    const hand = { p: [r(), 1 + r(), r()], q: M.qnorm([r(), r(), r(), r()]) };
    const w = { p: [r(), r() + 0.5, r()], q: M.qnorm([r(), r(), r(), r()]) };
    const back = M.compose(hand, M.relative(hand, w));
    assert(dist(back.p, w.p) < 1e-9 && qdiff(back.q, w.q) < 1e-12, `round trip ${i}: ${JSON.stringify(back)} vs ${JSON.stringify(w)}`);
  }
  // yaw: qyaw / yawOf and the zones' rotation (toWorld) agree
  for (const y of [0, 0.7, -2.1, 3]) {
    assert(near(M.yawOf(M.qyaw(y)), y, 1e-9), `yawOf(qyaw(${y}))`);
    const v = M.qrot(M.qyaw(y), [1, 0, 0]);
    assert(near(v[0], Math.cos(y), 1e-9) && near(v[2], -Math.sin(y), 1e-9), 'qyaw turns like toWorld');
  }
});

test('carried by the adapter (heldPose, the laser drag): followed, released where it is drawn, lands upright', () => {
  const s = sim(12);
  s.run(1);
  const sc = s.zone('scruff');
  const st0 = s.cat.state();
  // The carried pose starts where the cat's root is (the dangle frames hang from the scruff).
  const w0 = { p: [sc.x, sc.y, sc.z], q: M.qyaw(st0.yaw) };
  const at = { x: sc.x + 0.2, y: sc.y + 0.8, z: sc.z - 0.4 };   // the laser hand, away from the cat
  s.setScript(() => ({ ...at, press: 1, carried: w0 }));
  let st = s.run(DT);
  const g = s.shown[s.shown.length - 1];
  assert(st.held?.source === 'laser' && g.clip === 'dangle', `held and dangling (${g.clip})`);
  assert(dist([g.x, g.y, g.z], w0.p) < 1e-9, 'drawn where the compositor has it at the grab');
  // Carried along a path, turned 90° about the vertical: the core follows exactly.
  const t0 = s.t;
  const pathAt = (t) => { const u = Math.min(1, (t - t0) / 1); return { p: [w0.p[0] + 1.2 * u, w0.p[1] + 0.3 * u, w0.p[2] - 0.5 * u], q: M.qmul(M.qyaw(Math.PI / 2 * u), w0.q) }; };
  s.setScript((t) => ({ ...at, press: 1, carried: pathAt(t) }));
  s.run(1.1, (x, t) => {
    const w = pathAt(t);
    assert(dist([x.x, x.y, x.z], w.p) < 1e-9 && qdiff(x.q, w.q) < 1e-12, 'the core follows the carried pose');
  });
  const last = pathAt(s.t);
  // Let go: the fall frame's scruff where the cat was drawn, same turn.
  s.setScript(() => ({ ...at, press: 0, carried: last }));
  st = s.run(DT);
  const r = s.shown[s.shown.length - 1];
  assert(st.falling && r.clip === 'fall', `released into the fall (${r.clip})`);
  const fs = M.qrot(r.q, baked.poseZones.fall.scruff);
  const scruffAfter = [r.x + fs[0], r.y + fs[1], r.z + fs[2]];
  assert(dist(scruffAfter, last.p) < 1e-9, `release continuity: scruff ${dist(scruffAfter, last.p)} m off`);
  assert(qdiff(r.q, last.q) < 1e-9, 'release continuity: orientation kept');
  // Lands upright.
  st = s.run(1.5);
  assert(!st.falling && qdiff(st.q, M.qyaw(st.yaw)) < 1e-12, `upright after landing (${st.q})`);
});

test('summon: 1 m in front of the user, facing them', () => {
  const s = sim(13);
  s.run(1);
  s.cat.command('wander');
  s.run(2);
  s.cat.command('summon');
  const st = s.run(DT);
  // user at (0, 1.6) looking toward -z
  assert(near(st.x, 0, 1e-6) && near(st.z, 0.6, 1e-6), `in front (${st.x.toFixed(3)}, ${st.z.toFixed(3)})`);
  assert(near(Math.cos(st.yaw), 1, 1e-6), `facing the user (yaw ${st.yaw.toFixed(3)})`);
});

test('reveal: stays near and in view, else summoned; forced', () => {
  const h = { x: 0, y: 1.6, z: 0, fx: 0, fz: -1 };
  const K = T.REVEAL_KEEP;
  assert(K === 3, `keep radius 3 m (${K})`);
  assert(Core.reveal({ x: 0, z: -2 }, h, { inView: true }) === 'stay', 'near, in view: stay');
  assert(Core.reveal({ x: 0, z: -K + 0.01 }, h) === 'stay', 'just inside: stay');
  assert(Core.reveal({ x: 0, z: -K - 0.01 }, h) === 'summon', 'beyond 3 m: summon');
  assert(Core.reveal({ x: 0, z: -1 }, h, { inView: false }) === 'summon', 'out of view: summon');
  assert(Core.reveal({ x: 0, z: -1 }, h, { force: true }) === 'summon', 'forced: summon');
  assert(Core.reveal({ x: 0, z: -9 }, null) === 'stay', 'no head pose: stay');
  assert(Core.reveal({ x: 0, z: -1 }, { ...h, y: 0.5 }) === 'stay', 'floor distance (head height ignored)');
});

test('settle: a held, falling or forced cat stands where it is (dangling: below the scruff)', () => {
  // held (laser drag)
  const s = sim(21);
  s.run(1);
  const st0 = s.cat.state(), sc = s.zone('scruff');
  s.setScript(() => ({ x: sc.x, y: sc.y + 0.03, z: sc.z, press: 0 }));
  s.run(0.3);
  s.setScript(() => ({ x: sc.x, y: sc.y + 0.03, z: sc.z, press: 1 }));
  assert(s.run(0.1).held, 'held');
  assert(s.cat.settle() === true, 'settled');
  let st = s.cat.state();
  assert(!st.held && !st.falling && !st.forced && st.pose === 'stand' && st.y === 0, `standing on the floor (${st.pose} y ${st.y})`);
  assert(near(st.x, st0.x, 1e-6) && near(st.z, st0.z, 1e-6), `where it was lifted from (${st.x} ${st.z} vs ${st0.x} ${st0.z})`);
  // falling
  const f = sim(22);
  f.run(1);
  f.cat.command('drop');
  assert(f.run(0.1).falling, 'falling');
  assert(f.cat.settle() === true && !f.cat.state().falling && f.cat.state().y === 0, 'landed at once');
  // forced dangle
  const d = sim(23);
  d.run(1);
  d.cat.command('dangle');
  d.run(0.1);
  assert(d.cat.settle() === true && !d.cat.state().forced && d.cat.state().pose === 'stand', 'forced dangle: standing');
  // free: nothing to do
  const n = sim(24);
  n.run(1);
  assert(n.cat.settle() === false, 'a free cat: unchanged');
});

test('save(): the spot and the resting pose a pose counts as (purring while sitting: sit)', () => {
  const saves = [];
  const cat = Core.create({ head: () => null, show() {}, save: (v) => saves.push(v) }, {}, baked);
  cat.command('sit');
  cat.save();
  assert(saves.length === 1 && saves[0].pose === 'sit' && Number.isFinite(saves[0].x), JSON.stringify(saves));
});

test('ui: the bar\'s lift by height, the menu layout, the view test', () => {
  const { ui } = Core;
  assert(near(ui.liftOf(), 0.40, 1e-12) && near(ui.liftOf(0.35), 0.45, 1e-12), 'lift: 0.40 for the cat, height + 0.10');
  const cat = { order: ['a', 'b', 'c'], models: { a: { group: 'coats' }, b: { group: 'coats' }, c: { group: 'animals' } } };
  const l = ui.menuLayout(cat);
  assert(l.breaks.join() === 'c' && l.px === 8 * 2 + 3 * 48 + 2 * 9 + 4 * 44, JSON.stringify(l));
  const eye = [0, 1.6, 0], fwd = [0, 0, -1];
  assert(ui.inView(eye, fwd, { x: 0, y: 0, z: -2 }) && !ui.inView(eye, fwd, { x: 0, y: 0, z: 2 }), 'ahead in view, behind not');
});

test('every clip the core can ask for is baked', () => {
  const need = new Set([...Object.values(Core.LOOP), ...Core.EDGES.map((e) => e[2]), 'groom', 'stretch', 'shake', 'startle', 'land']);
  for (const c of need) assert(baked.clips[c], `missing clip ${c}`);
  for (const p of ['stand', 'sit', 'lie', 'sleep', 'fall', 'dangle']) assert(baked.poseZones?.[p]?.scruff, `missing zones for ${p}`);
});

done();
