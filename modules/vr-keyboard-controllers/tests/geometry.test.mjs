// geometry.js (tip and laser relative to the keyboard) and hub.js (page px,
// subscribers). usage: node geometry.test.mjs <geometry.js> <hub.js>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const GEO = (0, eval)(readFileSync(process.argv[2], 'utf8'));
let passed = 0;
const test = (name, f) => { f(); passed++; console.log(`ok ${name}`); };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const norm = (q) => { const n = Math.hypot(q.w, q.x, q.y, q.z); return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n }; };
const axis = (deg, x, y, z) => { const h = (deg * Math.PI) / 360; return { w: Math.cos(h), x: x * Math.sin(h), y: y * Math.sin(h), z: z * Math.sin(h) }; };
const ID = { w: 1, x: 0, y: 0, z: 0 };

// A keyboard as measured live (SGQueryService world transform of the
// overlay's scaled frame), 0.738 m wide, page 854 x 280 px.
const KB = { translation: { x: -0.8552, y: 0.4129, z: -3.8837 }, rotation: norm({ w: 0.88649, x: -0.11484, y: -0.44456, z: -0.05758 }), width: 0.738 };
const PAGE = 854;
function world(x, y, front) {                       // page px, m in front -> tracking space
  const r = GEO.rotate(KB.rotation, { x: (x / PAGE - 0.5) * KB.width, y: -(y / PAGE) * KB.width, z: front });
  return { x: r.x + KB.translation.x, y: r.y + KB.translation.y, z: r.z + KB.translation.z };
}
// The frame controller's render model "tip" component.
const TIP = { translation: { x: -0.012694, y: -0.02522, z: 0.020687 }, rotation: axis(-40, 1, 0, 0) };

test('toKeyboard: identity keyboard', () => {
  const s = GEO.toKeyboard({ x: 0.25, y: -0.1, z: 0.02 }, { translation: { x: 0, y: 0, z: 0 }, rotation: ID, width: 1 });
  near(s.u, 0.75); near(s.v, 0.1); near(s.d, -0.02);
});
test('toKeyboard inverts the keyboard transform', () => {
  const s = GEO.toKeyboard(world(356, 120, 0.03), KB);
  near(s.u * PAGE, 356, 1e-4); near(s.v * PAGE, 120, 1e-4); near(s.d, -0.03);
});
test('tipPose: device pose times the tip component', () => {
  const dev = { translation: { x: 1, y: 2, z: 3 }, rotation: axis(90, 0, 1, 0) };
  const p = GEO.tipPose(dev, TIP);
  // 90 degrees about y: (x, y, z) -> (z, y, -x)
  near(p.translation.x, 1 + TIP.translation.z); near(p.translation.y, 2 + TIP.translation.y); near(p.translation.z, 3 - TIP.translation.x);
  assert.deepEqual(GEO.tipPose(dev, null).translation, dev.translation);
});
test('rayHit: a laser pointing at a key from 30 cm', () => {
  // the tip 30 cm in front of (356, 120), pointing straight at the keyboard:
  // tip -z = keyboard -z, i.e. the tip's rotation = the keyboard's
  const hit = GEO.rayHit({ translation: world(356, 120, 0.3), rotation: KB.rotation }, KB);
  near(hit.u * PAGE, 356, 1e-4); near(hit.v * PAGE, 120, 1e-4); near(hit.dist, 0.3, 1e-9);
  // tilted 20 degrees about the keyboard's x axis (pointing down): hits lower
  const down = GEO.rayHit({ translation: world(356, 120, 0.3), rotation: GEO.multiply({ translation: { x: 0, y: 0, z: 0 }, rotation: KB.rotation }, { translation: { x: 0, y: 0, z: 0 }, rotation: axis(-20, 1, 0, 0) }).rotation }, KB);
  near(down.v * KB.width, 120 / PAGE * KB.width + 0.3 * Math.tan(Math.PI / 9), 1e-6);
  near(down.u * PAGE, 356, 1e-4);
});
test('rayHit: none from behind or pointing away', () => {
  assert.equal(GEO.rayHit({ translation: world(356, 120, -0.1), rotation: KB.rotation }, KB), null);
  const away = GEO.multiply({ translation: { x: 0, y: 0, z: 0 }, rotation: KB.rotation }, { translation: { x: 0, y: 0, z: 0 }, rotation: axis(180, 0, 1, 0) }).rotation;
  assert.equal(GEO.rayHit({ translation: world(356, 120, 0.3), rotation: away }, KB), null);
});
test('rotationDegrees: the trigger component angle', () => {
  near(GEO.rotationDegrees(axis(12.5, 0.98, 0.076, -0.178)), 12.5, 1e-6);
  near(GEO.rotationDegrees(ID), 0);
});

// hub.js with a fake keyboard popup (854 x 280).
globalThis.performance ??= { now: () => Date.now() };
globalThis.g_PopupManager = { GetPopups: () => [{ window: { innerWidth: 854, innerHeight: 280, closed: false, document: { querySelector: () => ({}) } } }] };
const HUB = (0, eval)(readFileSync(process.argv[3], 'utf8'));
test('hub: page px and onKeyboard, subscribers, lost', () => {
  const got = [];
  const off = HUB.subscribe((f) => got.push(f));
  HUB.frame({ seq: 1, t: 5, moving: false, keyboard: { width: 0.738 }, hands: {
    left: { tip: { u: 0.5, v: 0.1, d: -0.01 }, ray: { u: 1.2, v: 0.1, dist: 0.2 }, trigger: 0 }, right: null } });
  const l = got[0].hands.left;
  near(l.tip.x, 427); near(l.tip.y, 85.4, 1e-9); assert.equal(l.tip.onKeyboard, true); assert.equal(l.ray.onKeyboard, false);
  assert.equal(HUB.last, got[0]);
  HUB.lost();
  assert.equal(got[1], null); assert.equal(HUB.last, null);
  off();
  HUB.frame({ seq: 2, t: 6, keyboard: null, hands: { left: null, right: null } });
  assert.equal(got.length, 2);
  assert.equal((0, eval)(readFileSync(process.argv[3], 'utf8')), HUB, 'same version: kept');
});

console.log(`${passed} tests passed`);
