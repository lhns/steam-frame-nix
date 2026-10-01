// tracker.js: controller tip -> keyboard surface -> key (through
// vr-keyboard-controllers' geometry.js, as the bridge computes it),
// press/release hysteresis, two hands.
// usage: node tracker.test.mjs <tracker.js> <geometry.js>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const TR = (0, eval)(readFileSync(process.argv[2], 'utf8'));
const GEO = (0, eval)(readFileSync(process.argv[3], 'utf8'));
let passed = 0;
const test = (name, f) => { f(); passed++; console.log(`ok ${name}`); };
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} != ${b}`);

// A keyboard as measured live: world transform of its scaled frame
// (SGQueryService), 0.738 m wide; page 854 x 280 px.
const KB = {
  translation: { x: -0.8552, y: 0.4129, z: -3.8837 },
  rotation: { w: 0.88649, x: -0.11484, y: -0.44456, z: -0.05758 },
  width: 0.738,
};
const PAGE = { w: 854, h: 280 };
// Keys of a row (page px), like Steam's German layout.
const KEYS = { f: [265, 97, 60, 47], g: [325.6, 97, 60.4, 47], h: [386, 97, 60.4, 47], Backspace: [760, 3, 90, 47] };
const keyAt = (u, v) => {
  const x = u * PAGE.w, y = v * PAGE.w;
  return Object.entries(KEYS).find(([, [kx, ky, w, h]]) => x >= kx && x < kx + w && y >= ky && y < ky + h)?.[0] ?? null;
};
// World point of keyboard-local (page px x, y; m in front of the surface).
const norm = (q) => { const n = Math.hypot(q.w, q.x, q.y, q.z); return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n }; };
KB.rotation = norm(KB.rotation);
function world(x, y, front) {
  const l = { x: (x / PAGE.w - 0.5) * KB.width, y: -(y / PAGE.w) * KB.width, z: front };
  const r = GEO.rotate(KB.rotation, l);
  return { x: r.x + KB.translation.x, y: r.y + KB.translation.y, z: r.z + KB.translation.z };
}
// The frame controller's tip component (render model "tip").
const TIP = { translation: { x: -0.012694, y: -0.02522, z: 0.020687 }, rotation: { w: 0.93969, x: -0.34202, y: 0, z: 0 } };
const HAND_ROT = norm({ w: 0.8294, x: 0.2383, y: -0.3948, z: 0.3154 });
// The device pose that puts the tip at p.
function deviceFor(p) {
  const o = GEO.rotate(HAND_ROT, TIP.translation);
  return { translation: { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }, rotation: HAND_ROT };
}
const sampleAt = (x, y, front) => GEO.toKeyboard(GEO.tipPose(deviceFor(world(x, y, front)), TIP).translation, KB);

// Feeds a path [x, y, front(m)] at 90 Hz from t0; returns the events.
function run(tr, path, t0 = 0) {
  const out = [];
  path.forEach((p, i) => {
    const t = t0 + i * 11;
    const ev = tr.update(p && sampleAt(...p), t);
    if (ev) out.push({ ...ev, t, key: ev.u !== undefined ? keyAt(ev.u, ev.v) : undefined });
  });
  return out;
}
const poke = (x, y, from, to, back, steps = 6) => {
  const p = [];
  for (let i = 0; i <= steps; i++) p.push([x, y, from + (to - from) * i / steps]);
  for (let i = 1; i <= steps; i++) p.push([x, y, to + (back - to) * i / steps]);
  return p;
};
const phases = (evs) => evs.map((e) => (e.phase === 'down' ? `down:${e.key}` : e.phase));

test('a poke presses the key under the tip once, released on the way back', () => {
  const evs = run(TR.createTracker(), poke(356, 120, 0.05, -0.015, 0.05));
  assert.deepEqual(phases(evs), ['down:g', 'up']);
});
test('pointing (tip in front) never presses', () => {
  const p = [];
  for (let i = 0; i < 200; i++) p.push([100 + i * 3, 50 + (i % 40), 0.02 + 0.01 * Math.sin(i / 7)]);
  assert.deepEqual(run(TR.createTracker(), p), []);
});
test('fast poke between two samples: pressed at the crossing point', () => {
  const evs = run(TR.createTracker(), [[356, 120, 0.03], [356, 120, 0.01], [356, 120, -0.03], [356, 120, -0.035], [356, 120, 0.02]]);
  assert.deepEqual(phases(evs), ['down:g', 'up']);
  // moving sideways: the point where the path meets the surface (f | g | h)
  const side = run(TR.createTracker(), [[300, 120, 0.03], [300, 120, 0.01], [400, 120, -0.01], [400, 120, 0.02]]);
  assert.deepEqual(phases(side), ['down:g', 'up']);
  near(side[0].u * PAGE.w, 350, 1e-3);
});
test('jitter at the surface while held: one press; release needs 1 cm back', () => {
  const p = [[356, 120, 0.02], [356, 120, 0.004], [356, 120, -0.002]];
  for (let i = 0; i < 60; i++) p.push([356, 120, -0.002 - 0.004 * (i % 2)]);
  assert.deepEqual(phases(run(TR.createTracker(), p)), ['down:g']);
});
test('re-armed only in front by 5 mm: jitter after a release does not repeat', () => {
  const p = [...poke(356, 120, 0.02, -0.02, -0.005)];   // released 1.5 cm back, still behind
  for (let i = 0; i < 30; i++) p.push([356, 120, -0.004 + 0.006 * (i % 2)]);   // jitter -4..+2 mm
  assert.deepEqual(phases(run(TR.createTracker(), p)), ['down:g', 'up']);
  // ...but out to the front and in again is a second press.
  const q = [...poke(356, 120, 0.02, -0.02, 0.02), ...poke(356, 120, 0.02, -0.02, 0.02)];
  assert.deepEqual(phases(run(TR.createTracker(), q)), ['down:g', 'up', 'down:g', 'up']);
});
test('debounce: no new press within minIntervalMs of a release', () => {
  const tr = TR.createTracker({ minIntervalMs: 100 });
  const F = [356, 120, 0.02], B = [356, 120, -0.005];
  // released at 22 ms; pokes at 44 and 66 ms come too soon, the one at 143 ms counts
  const p = [F, B, F, F, B, F, B, F, F, F, F, F, F, B];
  assert.deepEqual(phases(run(tr, p)), ['down:g', 'up', 'down:g']);
});
test('from behind or around the edge: no press', () => {
  // starts behind the keyboard, inside
  assert.deepEqual(run(TR.createTracker(), [[356, 120, -0.05], [356, 120, -0.04], [356, 120, -0.03]]), []);
  // in front below the keyboard, behind it there, then up into the keys behind
  const p = [[356, 500, 0.03], [356, 500, 0.01], [356, 500, -0.02], [356, 300, -0.02], [356, 120, -0.02], [356, 120, -0.01]];
  assert.deepEqual(run(TR.createTracker(), p), []);
});
test('crossing outside the keyboard: no press', () => {
  assert.deepEqual(run(TR.createTracker(), poke(-100, 120, 0.03, -0.02, 0.03)), []);
  assert.deepEqual(run(TR.createTracker(), poke(356, 600, 0.03, -0.02, 0.03)), []);
});
test('a tracking jump through the surface is no press', () => {
  assert.deepEqual(run(TR.createTracker(), [[356, 120, 0.06], [356, 120, -0.06], [356, 120, 0.06]]), []);
});
test('lost tracking while pressed: cancel', () => {
  const evs = run(TR.createTracker(), [[356, 120, 0.02], [356, 120, -0.005], null, [356, 120, -0.005]]);
  assert.deepEqual(phases(evs), ['down:g', 'cancel']);
});
test('depth: the touch registers that far behind the surface', () => {
  const tr = TR.createTracker({ depth: 0.01 });
  assert.deepEqual(run(tr, poke(356, 120, 0.03, 0.002 - 0.01, 0.03)), []);   // 8 mm in: nothing
  assert.deepEqual(phases(run(TR.createTracker({ depth: 0.01 }), poke(356, 120, 0.03, -0.015, 0.03))), ['down:g', 'up']);
});
test('two hands: independent, overlapping presses', () => {
  const L = TR.createTracker(), R = TR.createTracker();
  const left = [[300, 120, 0.02], [300, 120, -0.005]];          // f, held
  for (let i = 0; i < 40; i++) left.push([300, 120, -0.006]);
  const right = [[356, 300, 0.02], ...poke(400, 120, 0.02, -0.01, 0.02), ...poke(356, 120, 0.02, -0.01, 0.02)];
  while (right.length < left.length) right.push([400, 120, 0.03]);
  left.push([300, 120, 0.02]);
  right.push([400, 120, 0.03]);
  const evs = [];
  left.forEach((p, i) => {
    for (const [hand, tr, q] of [['L', L, p], ['R', R, right[i]]]) {
      const ev = tr.update(sampleAt(...q), i * 11);
      if (ev) evs.push(`${hand}:${ev.phase}${ev.phase === 'down' ? `:${keyAt(ev.u, ev.v)}` : ''}`);
    }
  });
  assert.deepEqual(evs, ['L:down:f', 'R:down:h', 'R:up', 'R:down:g', 'R:up', 'L:up']);
});

console.log(`${passed} tests passed`);
