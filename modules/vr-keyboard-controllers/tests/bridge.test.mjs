// bridge-patch.js's tick loop in a fake systemui page (VRHTML poses, the
// keyboard's mount, SGQueryService) with a fake clock: the distance-adaptive
// tick, demand, opts.continuous, the hidden keyboard; a fast approach fed
// through vr-keyboard-touch's tracker.js.
// usage: node bridge.test.mjs <bridge-patch.js> <geometry.js> <tracker.js>
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SRC = readFileSync(process.argv[2], 'utf8');
const GEO = (0, eval)(readFileSync(process.argv[3], 'utf8'));
const TR = (0, eval)(readFileSync(process.argv[4], 'utf8'));
let passed = 0;
const test = async (name, f) => { await f(); passed++; console.log(`ok ${name}`); };

// The keyboard: identity pose at the origin, 0.738 m wide (+z toward the viewer).
const KB = { translation: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 }, width: 0.738 };
const at = (u, v, front) => ({ x: (u - 0.5) * KB.width, y: -v * KB.width, z: front });   // tip in tracking space

// A systemui page: tips by hand (fn of time -> point | null), the keyboard
// shown or not, a fake clock (timers run in time order by advance()).
function page({ continuous, tips = {}, shown = true }) {
  let now = 1000, nextId = 1;
  const timers = new Map();                       // id -> { at, fn, every }
  const env = { shown, tips, trigger: {}, frames: [], poses: 0 };
  const scaled = { tagName: 'VSG-TRANSFORM', appendChild(c) { c.parentElement = scaled; } };
  const mount = { __reactFiber$x: { memoizedProps: { mountedId: 'valve.steam.gamepadui.keyboard' } }, parentElement: scaled };
  Object.defineProperty(scaled, 'isConnected', { get: () => env.shown });
  const w = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(nextId, { at: now + Math.max(0, +ms || 0), fn }); return nextId++; },
    setInterval: (fn, ms) => { timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId++; },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    document: {
      querySelectorAll: () => (env.shown ? [mount] : []),
      createElement: () => ({ setAttribute() {}, remove() { this.parentElement = null; } }),
    },
    forceLayoutUpdate() {},
    SGQueryService: { requestSGTransform: async () => ({ translation: KB.translation, rotation: KB.rotation, scale: { x: KB.width } }) },
    VRHTML: {
      GetPose(path) {
        env.poses++;
        const p = env.tips[path.split('/').pop()]?.(now);
        return [p ? { bPoseIsValid: true, xfDeviceToAbsoluteTracking: { translation: p, rotation: { w: 1, x: 0, y: 0, z: 0 } } } : { bPoseIsValid: false }];
      },
      NextSGID: () => 7,
      VROverlay: { ThisOverlayKey: () => 'systemui', GetWidthInMeters: () => 1, FindOverlay: () => 1 },
      VRProperties: { GetStringProperty: () => 'frame' },
      VRRenderModels: {                           // no tip component; the trigger at env.trigger[hand] degrees
        GetComponentStateForDevicePath(rm, c, path) {
          const deg = env.trigger[path.split('/').pop()];
          if (c !== 'trigger' || deg === undefined) return null;
          const h = (deg * Math.PI) / 360;
          return { xfTrackingToComponentRenderModel: { rotation: { w: Math.cos(h), x: Math.sin(h), y: 0, z: 0 } } };
        },
      },
    },
    __sfuiCtlOut: (s) => env.frames.push(JSON.parse(s)),
  };
  w.window = w;
  vm.createContext(w);
  const status = vm.runInContext(SRC, w)(null, {}, { continuous }, null, GEO);
  assert.equal(status, 'patched');
  env.S = w.__sfuiCtl;
  env.now = () => now;
  // Runs timers due until now + ms (and the promises they start).
  env.advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    now = end;
    await new Promise((r) => setImmediate(r));
  };
  // Tick times (ms) in the next ms.
  env.ticksIn = async (ms) => {
    const t0 = env.S.ticks, times = [];
    const end = now + ms;
    while (now < end) {
      const before = env.S.ticks;
      await env.advance(1);
      if (env.S.ticks > before) times.push(now);
    }
    assert.ok(env.S.ticks - t0 >= times.length);
    return times;
  };
  return env;
}
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

await test('the tick interval shrinks as a tip approaches; full rate within NEAR', async () => {
  let front = 1;
  const p = page({ continuous: true, tips: { left: () => at(0.5, 0.15, front), right: () => null } });
  await p.advance(600);                           // shown, keyboard pose read
  const intervals = [];
  for (front of [1, 0.6, 0.35, 0.2, 0.12, 0.08, 0.02]) {
    await p.advance(300);
    intervals.push(p.S.delay);
  }
  assert.deepEqual(intervals.map(Math.round), [250, 200, 100, 40, 11, 11, 11]);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i] <= intervals[i - 1]);
  // beside the keyboard: the distance to its rect (plus margin), not the plane
  front = 0;
  p.tips.left = () => at(1.2 + 0.5 / KB.width, 0.15, 0);   // 0.5 m right of the margin
  await p.advance(300);
  assert.equal(Math.round(p.S.delay), 160);
});

await test('both hands untracked or far: SLOW_MS, frames every second', async () => {
  const p = page({ continuous: true, tips: { left: () => null, right: () => at(0.5, 0.2, 2) } });
  await p.advance(500);
  const ts = await p.ticksIn(2000);
  assert.ok(gaps(ts).every((g) => g === 250), gaps(ts).join());
  const fs = p.frames.filter((f) => f.keyboard);
  assert.ok(fs.length >= 2 && fs.length <= 3, `${fs.length} frames`);
});

await test('a fast approach (1 m at 2.5 m/s) is sampled within NEAR before contact and presses the key', async () => {
  for (const offset of [0, 37, 101, 180]) {          // phases of the slow loop
    let start = Infinity;
    // From 1 m in front at 2.5 m/s straight through the keyboard (key at u 0.42, v 0.14).
    const p = page({ continuous: true, tips: { right: (t) => at(0.42, 0.14, t < start ? 1 : 1 - (t - start) * 0.0025), left: () => null } });
    await p.advance(500 + offset);
    start = p.now();
    const tr = TR.createTracker();
    let down = null;
    const contact = start + 400;                   // 1 m / 2.5 m/s
    while (p.now() < contact + 40) {
      const n = p.frames.length;
      await p.advance(1);
      for (const f of p.frames.slice(n)) {
        if (!f.keyboard) continue;
        const ev = tr.update(f.hands.right?.tip ?? null, f.t);
        if (ev?.phase === 'down') down = { ...ev, t: f.t };
      }
    }
    const before = p.frames.filter((f) => f.keyboard && f.t < contact).map((f) => -f.hands.right.tip.d);
    assert.ok(before.some((d) => d > 0 && d <= 0.1), `offset ${offset}: sampled in front within NEAR: ${before.map((d) => d.toFixed(3))}`);
    assert.ok(Math.min(...before.filter((d) => d > 0)) <= 0.0275 + 1e-9, `offset ${offset}: last sample before contact within one tick`);
    assert.ok(down, `offset ${offset}: pressed`);
    assert.ok(Math.abs(down.u - 0.42) < 1e-6 && Math.abs(down.v - 0.14) < 1e-6);
    assert.ok(down.t - contact <= 11 + 1e-9, `offset ${offset}: pressed ${down.t - contact} ms after contact`);
  }
});

await test('demand: full rate regardless of distance, then back to adaptive', async () => {
  const p = page({ continuous: true, tips: { left: () => at(0.5, 0.15, 1.5), right: () => null } });
  await p.advance(1000);
  const t0 = p.S.ticks;
  p.S.demand(300);
  assert.equal(p.S.ticks, t0 + 1, 'ticks at once');
  const ts = await p.ticksIn(290);
  assert.ok(gaps(ts).every((g) => g === 11), gaps(ts).join());
  const sent = p.frames.filter((f) => f.keyboard && f.t >= p.now() - 290);
  assert.ok(sent.length >= 25, `frames at full rate: ${sent.length}`);
  await p.advance(300);
  assert.equal(p.S.delay, 250);
  // demand(0) ends a lease
  p.S.demand(2000);
  await p.advance(50);
  p.S.demand(0);
  await p.advance(20);
  assert.equal(p.S.delay, 250);
});

await test('a pulled trigger: full rate', async () => {
  const p = page({ continuous: true, tips: { left: () => at(0.5, 0.15, 1.5), right: () => null } });
  await p.advance(600);
  assert.equal(p.S.delay, 250);
  p.trigger.left = 10;                            // 0.8 of its travel
  await p.advance(300);
  assert.equal(p.S.delay, 11);
  assert.ok(p.now() - p.frames.at(-1).t < 11);
  p.trigger.left = 2;
  await p.advance(300);
  assert.equal(p.S.delay, 250);
});

await test('touch typing off: no ticks while shown until a demand, the first at once', async () => {
  const p = page({ continuous: false, tips: { left: () => at(0.5, 0.15, 0.02), right: () => at(0.5, 0.15, 1) } });
  await p.advance(3000);
  assert.equal(p.S.ticks, 0);
  assert.equal(p.poses, 0);
  assert.equal(p.S.delay, null);
  p.S.demand(800);
  assert.equal(p.S.ticks, 1, 'the first demand ticks at once');
  assert.equal(p.frames.length, 1);
  const ts = await p.ticksIn(780);
  assert.ok(gaps(ts).every((g) => g === 11), gaps(ts).join());
  p.S.demand(800);                                // renewed: no extra tick
  const n = p.S.ticks;
  p.S.demand(800);
  assert.equal(p.S.ticks, n);
  p.S.demand(0);
  await p.advance(1000);
  const end = p.S.ticks;
  await p.advance(3000);
  assert.equal(p.S.ticks, end, 'stopped after the lease');
  assert.equal(p.S.delay, null);
});

await test('touch typing off: a demand before the keyboard pose is known ticks once it is', async () => {
  const p = page({ continuous: false, tips: { left: () => at(0.5, 0.15, 0.3), right: () => null } });
  await p.advance(240);                           // not found yet (the first DOM poll at 250 ms)
  p.S.demand(800);
  assert.equal(p.S.ticks, 0);
  await p.advance(15);                            // first poll -> pose -> tick
  assert.ok(p.S.ticks >= 1);
  assert.equal(p.frames[0].hands.left.tip.d, -0.3);
});

await test('hidden keyboard: no loop, no frames; one keyboard: null frame when it goes', async () => {
  const p = page({ continuous: true, shown: false, tips: { left: () => at(0.5, 0.15, 0.02), right: () => null } });
  await p.advance(3000);
  p.S.demand(800);
  await p.advance(500);
  assert.equal(p.S.ticks, 0);
  assert.equal(p.poses, 0);
  assert.equal(p.frames.length, 0);
  p.shown = true;
  await p.advance(600);
  assert.ok(p.S.ticks > 20, 'shown, tip near: full rate');
  p.shown = false;
  await p.advance(300);
  const n = p.S.ticks;
  assert.equal(p.frames.at(-1).keyboard, null);
  await p.advance(3000);
  assert.equal(p.S.ticks, n);
  assert.equal(p.S.delay, null);
});

// Simulated cost: ticks per second (each ~0.15 ms in-page) in typical states.
{
  const rate = async (continuous, front) => {
    const p = page({ continuous, tips: { left: () => at(0.5, 0.15, front), right: () => at(0.6, 0.15, front + 0.1) } });
    await p.advance(1000);
    const t0 = p.S.ticks;
    await p.advance(10000);
    return (p.S.ticks - t0) / 10;
  };
  console.log(`ticks/s (was 91 while shown): hands far ${await rate(true, 1)}, 30 cm ${await rate(true, 0.3)},` +
    ` 5 cm ${await rate(true, 0.05)}; touch typing off ${await rate(false, 0.05)}`);
}

console.log(`${passed} tests passed`);
