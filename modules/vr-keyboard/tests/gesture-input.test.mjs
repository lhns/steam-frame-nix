// gesture-input.js: a gesture only gets the events of the contact that
// started it. Like patch.js: a 'down' starts a path (claim), moves extend
// it, the release ends it. Fixture two-controllers.json: a swipe recorded in
// VR (Steam's keyboard page) while the other controller pointed at the
// keyboard; its hover (485,106) once broke into the path ("tust" for "test").
// usage: node gesture-input.test.mjs <gesture-input.js> <two-controllers.json>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const P = (0, eval)(readFileSync(process.argv[2], 'utf8'));
let passed = 0;

const touch = ([identifier, clientX, clientY]) => ({ identifier, clientX, clientY, target: `@${clientX},${clientY}` });
const ev = {
  touch: (type, touches, changed) => ({ type, touches: touches.map(touch), changedTouches: changed.map(touch) }),
  pointer: (type, pointerType, pointerId, clientX, clientY) => ({ type, pointerType, pointerId, clientX, clientY, target: 'p' }),
  mouse: (type, clientX, clientY) => ({ type, clientX, clientY, target: 'm' }),
};
// A recorded event: [type, touches, changed] | [type, pointerType, id, x, y] | [type, x, y].
const fromRecord = (r) => (r[0].startsWith('touch') ? ev.touch(...r) : r[0].startsWith('pointer') ? ev.pointer(...r) : ev.mouse(...r));

// Feeds events like patch.js; returns the finished paths [{ id, pts, ended }].
function run(events, { startIf = () => true } = {}) {
  const input = P.create(), paths = [];
  let cur = null;
  for (const e of events) {
    const c = input.read(e);
    if (!c) continue;
    if (c.phase === 'down') {
      cur = null;
      if (startIf(c)) { cur = { id: c.id, pts: [[c.x, c.y]] }; input.claim(c); }
    } else if (c.phase === 'move') {
      assert.ok(cur, 'a move without a gesture');
      cur.pts.push([c.x, c.y]);
    } else {
      assert.ok(cur, `${c.phase} without a gesture`);
      cur.pts.push([c.x, c.y]);
      cur.ended = c.phase;
      paths.push(cur);
      cur = null;
    }
  }
  if (cur) paths.push(cur);
  return paths;
}
function test(name, f) { f(); passed++; console.log(`ok ${name}`); }

test('recorded swipe with the other controller hovering', () => {
  const rec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  assert.ok(rec.some((r) => r[0] === 'pointermove' && r[1] === 'mouse' && r[3] === 485), 'fixture has the stray hover');
  const paths = run(rec.map(fromRecord));
  assert.equal(paths.length, 1);
  const [p] = paths;
  assert.equal(p.id, 't814');
  assert.equal(p.ended, 'up');
  assert.deepEqual(p.pts[0], [334, 74]);
  const touchMoves = rec.filter((r) => r[0] === 'touchmove').map((r) => r[1][0].slice(1));
  assert.deepEqual(p.pts.slice(1, -1), touchMoves, 'the path is exactly its touch moves');
  assert.ok(!p.pts.some(([x, y]) => x === 485 && y === 106), 'no hover of the other controller');
});

test('two touches interleaved: the second is ignored until the first ends', () => {
  const T = (type, touches, changed) => ev.touch(type, touches, changed);
  const paths = run([
    ev.pointer('pointermove', 'mouse', 1, 600, 150),        // B hovers
    T('touchstart', [[1, 100, 50]], [[1, 100, 50]]),        // A presses
    ev.pointer('pointermove', 'mouse', 1, 610, 150),        // B's hover meanwhile
    T('touchmove', [[1, 120, 55]], [[1, 120, 55]]),
    T('touchstart', [[1, 120, 55], [2, 500, 120]], [[2, 500, 120]]),   // B presses
    T('touchmove', [[1, 120, 55], [2, 520, 120]], [[2, 520, 120]]),    // only B moved
    T('touchmove', [[1, 140, 60], [2, 520, 120]], [[1, 140, 60]]),
    T('touchend', [[1, 140, 60]], [[2, 530, 121]]),          // B releases first
    T('touchmove', [[1, 160, 70]], [[1, 160, 70]]),
    ev.mouse('mousemove', 700, 160),                         // no pointer events seen yet: still not A's
    T('touchend', [], [[1, 170, 72]]),                       // A releases
    T('touchmove', [[3, 300, 90]], [[3, 300, 90]]),          // a touch that started elsewhere
    T('touchstart', [[4, 200, 80]], [[4, 200, 80]]),         // B swipes alone
    ev.pointer('pointermove', 'mouse', 1, 50, 50),           // A's hover
    T('touchmove', [[4, 230, 85]], [[4, 230, 85]]),
    T('touchend', [], [[4, 240, 90]]),
  ]);
  assert.deepEqual(paths, [
    { id: 't1', pts: [[100, 50], [120, 55], [120, 55], [140, 60], [160, 70], [170, 72]], ended: 'up' },
    { id: 't4', pts: [[200, 80], [230, 85], [240, 90]], ended: 'up' },
  ]);
});

test("a cancel of another contact doesn't end the gesture", () => {
  const paths = run([
    ev.pointer('pointerdown', 'touch', 7, 10, 10),
    ev.touch('touchstart', [[9, 10, 10]], [[9, 10, 10]]),
    ev.pointer('pointercancel', 'touch', 7, 0, 0),           // Chromium's, after a few moves
    ev.touch('touchcancel', [[9, 12, 10]], [[8, 0, 0]]),
    ev.touch('touchmove', [[9, 30, 12]], [[9, 30, 12]]),
    ev.touch('touchcancel', [], [[9, 30, 12]]),
  ]);
  assert.deepEqual(paths, [{ id: 't9', pts: [[10, 10], [30, 12], [30, 12]], ended: 'cancel' }]);
});

test('a missed release: the next lone press takes over', () => {
  const paths = run([
    ev.touch('touchstart', [[1, 10, 10]], [[1, 10, 10]]),
    ev.touch('touchmove', [[1, 20, 10]], [[1, 20, 10]]),
    ev.touch('touchstart', [[2, 50, 50]], [[2, 50, 50]]),    // touch 1 is gone
    ev.touch('touchend', [], [[1, 25, 10]]),
    ev.touch('touchend', [], [[2, 60, 50]]),
  ]);
  assert.deepEqual(paths.map((p) => [p.id, p.ended]), [['t2', 'up']]);
});

test('presses that start no gesture leave the next one free', () => {
  const paths = run([
    ev.touch('touchstart', [[1, 10, 10]], [[1, 10, 10]]),    // Shift held by one hand
    ev.touch('touchmove', [[1, 11, 10]], [[1, 11, 10]]),
    ev.touch('touchend', [], [[1, 11, 10]]),
    ev.touch('touchstart', [[2, 50, 50]], [[2, 50, 50]]),
    ev.touch('touchend', [], [[2, 60, 50]]),
  ], { startIf: (c) => c.x > 30 });
  assert.deepEqual(paths, [{ id: 't2', pts: [[50, 50], [60, 50]], ended: 'up' }]);
});

test('mouse: pointer events by pointerId, mouse events only without them', () => {
  assert.deepEqual(run([
    ev.mouse('mousedown', 1, 1), ev.mouse('mousemove', 2, 1), ev.mouse('mouseup', 3, 1),
  ]), [{ id: 'm', pts: [[1, 1], [2, 1], [3, 1]], ended: 'up' }]);
  assert.deepEqual(run([
    ev.pointer('pointerdown', 'mouse', 1, 1, 1), ev.mouse('mousedown', 1, 1),
    ev.pointer('pointermove', 'pen', 2, 9, 9), ev.mouse('mousemove', 9, 9),
    ev.pointer('pointermove', 'mouse', 1, 2, 1),
    ev.pointer('pointerup', 'mouse', 1, 3, 1), ev.mouse('mouseup', 3, 1),
  ]), [{ id: 'p1', pts: [[1, 1], [2, 1], [3, 1]], ended: 'up' }]);
});

console.log(`gesture-input: ${passed} tests passed`);
