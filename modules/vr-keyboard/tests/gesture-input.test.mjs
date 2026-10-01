// gesture-input.js: a gesture only gets the events of the contact that
// started it. Like patch.js: a 'down' starts a path (claim), moves extend
// it, the release ends it. Fixture two-controllers.json: a swipe recorded in
// VR (Steam's keyboard page) while the other controller pointed at the
// keyboard; its hover (485,106) once broke into the path ("tust" for "test").
// The controller bridge: that recording plus synthetic hub.js frames (the
// pressing hand's laser along the recorded path, the other at its hover).
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

// ---- controller bridge ------------------------------------------------------------
// A frame as hub.js delivers it; a hand: [x, y] (ray on the keyboard), 'off'
// (ray beside it) or null (no pose).
const hand = (p, trigger = null) => (p === null ? null
  : { tip: { u: 0, v: 0, d: 0.3 }, trigger, ray: p === 'off' ? { x: -50, y: 10, onKeyboard: false } : { x: p[0], y: p[1], onKeyboard: true } });
const frame = (left, right, { trigger = {}, moving = false } = {}) =>
  ({ keyboard: { width: 0.74 }, moving, hands: { left: hand(left, trigger.left), right: hand(right, trigger.right) } });

// Timed steps [ms, event | { frame }], fed like patch.js: frame points extend the path.
function runT(steps) {
  let clock = 0;
  const input = P.create({ now: () => clock }), paths = [];
  let cur = null;
  for (const [t, x] of steps) {
    clock = t;
    if ('frame' in x) {
      const p = input.frame(x.frame);
      if (p && cur) cur.pts.push([...p]);
      continue;
    }
    const handNow = input.hand;                    // the hand at the release (read() ends it)
    const c = input.read(x);
    if (!c) continue;
    if (c.phase === 'down') {
      cur = { id: c.id, pts: [[c.x, c.y]] };
      cur.hand = input.claim(c);
    } else if (c.phase === 'move') {
      cur.pts.push([c.x, c.y]);
    } else {
      cur.pts.push([c.x, c.y]);
      Object.assign(cur, { ended: c.phase, hand: handNow, stats: { ...input.stats } });
      paths.push(cur);
      cur = null;
    }
  }
  if (cur) paths.push(cur);
  return paths;
}
const T = (type, touches, changed) => ev.touch(type, touches, changed);

// The recording: its touch path, the other controller's hover.
const rec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const recPath = rec.filter((r) => /^touch(start|move|end)$/.test(r[0])).map((r) => r[2][0].slice(1));
const HOVER = [485, 106];

test('recorded swipe, the pressing hand gets no touchmoves: the path comes from the bridge', () => {
  // Every 20 ms an event of the recording, without the touchmoves; the touchend
  // at the press point (SteamVR forwarded nothing); a frame every 11 ms with
  // the right laser along the recorded path, the left at the hover.
  const events = rec.filter((r) => r[0] !== 'touchmove').map(fromRecord);
  const end = events.findIndex((e) => e.type === 'touchend');
  events[end] = T('touchend', [], [[814, ...recPath[0]]]);
  const startAt = 20 * events.findIndex((e) => e.type === 'touchstart'), endAt = 20 * end;
  const steps = events.map((e, i) => [20 * i, e]);
  for (let t = startAt - 33, k = 0; t < endAt; t += 11, k++) {
    const i = Math.min(recPath.length - 1, Math.max(0, Math.round((t - startAt) / (endAt - startAt) * (recPath.length - 1))));
    steps.push([t + 0.5, { frame: frame(HOVER, recPath[i]) }]);
  }
  steps.sort((a, b) => a[0] - b[0]);
  const [p, ...more] = runT(steps);
  assert.equal(more.length, 0);
  assert.equal(p.hand, 'right');
  assert.equal(p.ended, 'up');
  assert.deepEqual(p.pts[0], recPath[0]);
  assert.ok(p.stats.bridge > 20 && p.stats.touch === 0, `bridge points ${p.stats.bridge}`);
  // "test" ends near its start: the stale touchend agrees (a far one: the next tests).
  assert.deepEqual(p.pts.at(-2), recPath.at(-1), 'the laser up to the release');
  assert.ok(Math.hypot(p.pts.at(-1)[0] - recPath.at(-1)[0], p.pts.at(-1)[1] - recPath.at(-1)[1]) <= 40);
  assert.ok(!p.pts.some(([x, y]) => x === HOVER[0] && y === HOVER[1]), 'no hover of the other controller');
  for (const q of p.pts) assert.ok(recPath.some((r) => r[0] === q[0] && r[1] === q[1]), `${q} on the recorded path`);
});

test('recorded swipe with its touchmoves and frames interleaved: the touchmoves, as without the bridge', () => {
  const steps = rec.map((r, i) => [5 * i, fromRecord(r)]);
  for (let t = 0; t < 5 * rec.length; t += 11) steps.push([t + 0.5, { frame: frame(HOVER, recPath[0]) }]);
  steps.sort((a, b) => a[0] - b[0]);
  const [p] = runT(steps);
  assert.equal(p.hand, 'right');
  assert.equal(p.stats.bridge, 0, "Chromium's pointer moves of the touch, then its touchmoves: flowing");
  assert.deepEqual(p.pts, recPath);
});

test('attribution with both lasers on the keyboard: nearest within 30 px, trigger as a tiebreak', () => {
  const press = (f, x, y) => runT([[0, { frame: f }], [10, T('touchstart', [[1, x, y]], [[1, x, y]])]])[0].hand;
  const apart = frame([100, 50], [300, 80]);
  assert.equal(press(apart, 302, 79), 'right');
  assert.equal(press(apart, 98, 52), 'left');
  assert.equal(press(apart, 200, 200), null, 'neither laser there');
  assert.equal(press(frame([100, 50], 'off'), 300, 80), null, 'the near laser beside the keyboard');
  assert.equal(press(frame([300, 70], [305, 82]), 301, 74), 'left', 'a near tie, no trigger: nearest');
  assert.equal(press(frame([300, 70], [305, 82], { trigger: { left: 0, right: 1 } }), 301, 74), 'right');
  assert.equal(press(frame([300, 70], [305, 82], { trigger: { left: 1, right: 0.1 } }), 301, 74), 'left');
  assert.equal(press(frame([300, 70], [303, 120], { trigger: { left: 0, right: 1 } }), 301, 74), 'left', 'no tie: the trigger is not asked');
  assert.equal(press(frame([100, 50], [300, 80], { moving: true }), 302, 79), null, 'keyboard moving');
});

test('no recent frames at the press: the first frame after it attributes (the bridge woke up)', () => {
  const [p] = runT([
    [0, { frame: frame([100, 50], [300, 80]) }],             // an idle frame, long ago
    [1000, T('touchstart', [[1, 300, 80]], [[1, 300, 80]])],
    [1035, { frame: frame([100, 50], [340, 82]) }],           // moved 40 px since
    [1046, { frame: frame([100, 50], [360, 83]) }],
    [1070, { frame: frame([100, 50], [380, 84]) }],
    [1100, { frame: frame([100, 50], [420, 86]) }],
    [1110, T('touchend', [], [[1, 300, 80]])],
  ]);
  assert.equal(p.hand, 'right');
  assert.equal(p.stats.late, true);
  assert.deepEqual(p.pts, [[300, 80], [380, 84], [420, 86], [420, 86]], 'frames once touchmoves paused 60 ms; the release at the laser, not at the stale touchend');
});

test('stale bridge: touch events only (as without it)', () => {
  const [p] = runT([
    [0, { frame: frame([100, 50], [300, 80]) }],
    [200, T('touchstart', [[1, 300, 80]], [[1, 300, 80]])],
    [300, T('touchmove', [[1, 320, 80]], [[1, 320, 80]])],
    [500, { frame: frame([100, 50], [360, 80]) }],           // after the wait: not attributed
    [600, T('touchmove', [[1, 340, 80]], [[1, 340, 80]])],
    [700, T('touchend', [], [[1, 350, 80]])],
  ]);
  assert.equal(p.hand, null);
  assert.deepEqual(p.pts, [[300, 80], [320, 80], [340, 80], [350, 80]]);
});

test('frames stopping mid-swipe: touchmoves again; frames back: after a touch pause', () => {
  const steps = [[0, { frame: frame(null, [300, 80]) }], [5, T('touchstart', [[1, 300, 80]], [[1, 300, 80]])]];
  for (let t = 11; t <= 110; t += 11) steps.push([t, { frame: frame(null, [300 + t, 80]) }]);   // to 410
  steps.push([140, T('touchmove', [[1, 405, 80]], [[1, 405, 80]])]);                             // frames still fresh: dropped
  steps.push([200, T('touchmove', [[1, 420, 80]], [[1, 420, 80]])]);                             // 90 ms without frames
  steps.push([216, T('touchmove', [[1, 440, 80]], [[1, 440, 80]])]);
  steps.push([230, { frame: frame(null, [445, 80]) }]);                                           // touch flowing: ignored
  steps.push([300, { frame: frame(null, [470, 80]) }]);                                           // touch paused 84 ms
  steps.push([310, T('touchend', [], [[1, 472, 80]])]);
  const [p] = runT(steps);
  assert.equal(p.hand, 'right');
  assert.deepEqual(p.pts.map(([x]) => x), [300, 366, 377, 388, 399, 410, 420, 440, 470, 472]);
});

test("touchmoves on the other hand's laser move the attribution", () => {
  const [p] = runT([
    [0, { frame: frame([300, 80], [310, 90]) }],             // both near the press: left (nearest)
    [5, T('touchstart', [[1, 302, 82]], [[1, 302, 82]])],
    [11, { frame: frame([300, 80], [330, 90]) }],
    [16, T('touchmove', [[1, 330, 91]], [[1, 330, 91]])],    // still near both
    [22, { frame: frame([300, 80], [380, 92]) }],
    [27, T('touchmove', [[1, 381, 92]], [[1, 381, 92]])],    // 81 px from left, on right
    [33, { frame: frame([300, 80], [420, 94]) }],
    [100, { frame: frame([300, 80], [470, 96]) }],
    [110, T('touchend', [], [[1, 302, 82]])],
  ]);
  assert.equal(p.stats.switches, 1);
  assert.deepEqual(p.pts, [[302, 82], [330, 91], [381, 92], [470, 96], [470, 96]]);
});

test('bridge swipe: a second press and the other hover are ignored, the next press is attributed anew', () => {
  const paths = runT([
    [0, { frame: frame([100, 50], [300, 80]) }],
    [5, T('touchstart', [[1, 300, 80]], [[1, 300, 80]])],                 // right presses
    [8, ev.pointer('pointermove', 'mouse', 1, 102, 50)],                  // left's hover
    [80, { frame: frame([102, 50], [340, 80]) }],
    [85, T('touchstart', [[1, 300, 80], [2, 102, 50]], [[2, 102, 50]])], // left presses: Steam's
    [90, T('touchend', [[1, 300, 80]], [[2, 102, 50]])],
    [91, { frame: frame([102, 50], [380, 80]) }],
    [100, T('touchend', [], [[1, 300, 80]])],
    [200, { frame: frame([102, 50], [380, 80]) }],
    [205, T('touchstart', [[3, 101, 51]], [[3, 101, 51]])],               // left swipes alone
    [290, { frame: frame([150, 52], [380, 80]) }],
    [300, T('touchend', [], [[3, 101, 51]])],
  ]);
  assert.deepEqual(paths.map((p) => [p.id, p.hand, p.pts]), [
    ['t1', 'right', [[300, 80], [340, 80], [380, 80], [380, 80]]],
    ['t3', 'left', [[101, 51], [150, 52], [150, 52]]],
  ]);
});

console.log(`gesture-input: ${passed} tests passed`);
