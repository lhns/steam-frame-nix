// patch.js in a fake SharedJSContext page: g_PopupManager with dock bar
// popups (each its own window, as on the device) and a look-alike "+" menu
// popup, a React-fiber-shaped room-view button whose stock click flips the
// action's `active` a little later (as SteamVR does), a fake helper behind
// window.__sfuiPassthroughCall answering through window.__sfuiPassthrough.reply
// like relay.mjs, and a fake clock.
// usage: node patch.test.mjs <patch.js> <unpatch.js> <finders.js>
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const [, , patchPath, unpatchPath, findersPath] = process.argv;
const PATCH = readFileSync(patchPath, 'utf8');
const UNPATCH = readFileSync(unpatchPath, 'utf8');
const FINDERS = readFileSync(findersPath, 'utf8');
let passed = 0;
const test = async (name, f) => { await f(); passed++; console.log(`ok ${name}`); };

const OPTS = { invocation: 2, icon: 2, iconActive: 1 };
const ATTR = 'data-sfui-passthrough';
const STOCK_TOGGLE_MS = 150;   // SteamVR's lag between the stock click and `active` flipping
const HELPER_MS = 30;          // helper round trip

function page({ helperSource = 'mono', arcturus = true, relay = true } = {}) {
  let now = 1000, nextTimerId = 1;
  const timers = new Map();
  const setTimeout = (fn, ms) => { const id = nextTimerId++; timers.set(id, { at: now + Math.max(0, +ms || 0), fn }); return id; };
  const observers = [];
  const action = { invocation: 2, icon: { enum: 2 }, icon_active: { enum: 1 }, enabled: true, active: false };
  const helper = { source: helperSource, arcturus, calls: [], stockClicks: 0 };

  function fakeWindow(buttons) {   // capture listeners + a stylesheet slot
    const listeners = {};
    const styles = new Map();
    const w = {
      closed: false,
      listeners,
      buttons,
      addEventListener: (type, fn, capture) => { listeners[type] = { fn, capture }; },
      removeEventListener: (type, fn) => { if (listeners[type]?.fn === fn) delete listeners[type]; },
      document: {
        documentElement: {},
        head: { appendChild: (el) => styles.set(el.id, el) },
        createElement: () => ({ id: '', textContent: '', remove() { styles.delete(this.id); } }),
        getElementById: (id) => styles.get(id) ?? null,
        querySelectorAll: (sel) => (sel === '[role="button"]' ? w.buttons : []),
      },
      styles,
    };
    return w;
  }

  // A [role=button] with a React fiber (memoizedProps.action) and a stock
  // click() that dispatches to its window's capture listener and, unless
  // prevented, toggles room view after STOCK_TOGGLE_MS.
  function fakeButton(act, win) {
    const attrs = { role: 'button' };
    const el = {
      nodeType: 1,   // findFiberUp only reads __reactFiber$* off a real node
      attrs,
      getAttribute: (n) => attrs[n] ?? null,
      setAttribute: (n, v) => { attrs[n] = String(v); },
      removeAttribute: (n) => { delete attrs[n]; },
      contains: (other) => other === el,
      __reactFiber$x: { memoizedProps: { action: act }, return: null },
      click: () => {
        const event = { target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
        win().listeners.click?.fn(event);
        if (!event.defaultPrevented && act === action) {
          helper.stockClicks++;
          setTimeout(() => { action.active = !action.active; }, STOCK_TOGGLE_MS);
        }
        return event;
      },
    };
    return el;
  }

  // A dock bar popup whose room-view button carries the shared action.
  function barPopup(n) {
    const win = fakeWindow([]);
    win.buttons.push(fakeButton({ invocation: 1 }, () => win), fakeButton(action, () => win));
    return { m_strName: `valve.steam.gamepadui.bar.${n}_uid0`, window: win };
  }
  const decoyWin = fakeWindow([]);
  decoyWin.buttons.push(fakeButton({ ...action }, () => decoyWin));
  const popups = [barPopup(7600000), { m_strName: 'valve.steam.gamepadui.barpopup.7600001.7600001_uid0', window: decoyWin }];

  const w = {
    g_PopupManager: { GetPopups: () => popups },
    document: { documentElement: {} },
    listeners: {},
    setTimeout,
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = nextTimerId++; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (id) => timers.delete(id),
    console,
    Date,
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } },
  };
  w.addEventListener = (type, fn, capture) => { w.listeners[type] = { fn, capture }; };
  w.removeEventListener = (type) => { delete w.listeners[type]; };
  if (relay) {
    w.__sfuiPassthroughCall = (json) => {
      const req = JSON.parse(json);
      helper.calls.push(req.op === 'set' ? `set ${req.source}` : req.op);
      setTimeout(() => {
        if (req.op === 'set') helper.source = req.source === 'rgb' && !helper.arcturus ? helper.source : req.source;
        w.__sfuiPassthrough?.reply(req.id, { ok: true, enabled: 1, source: helper.source, arcturus: helper.arcturus });
      }, HELPER_MS);
    };
  }
  w.window = w;
  vm.createContext(w);

  const env = {
    w, action, helper, popups, observers, barPopup,
    bar: () => popups[0].window,
    button: () => popups[0].window.buttons[1],
    shown: (p = popups[0]) => p.window.buttons[1].getAttribute(ATTR),
    // Runs due timers up to now + ms, in time order, settling promises in between.
    advance: async (ms) => {
      const end = now + ms;
      for (;;) {
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
    run: (src) => vm.runInContext(src, w),
    inject: () => vm.runInContext(PATCH, w)(vm.runInContext(FINDERS, w), {}, OPTS),
  };
  assert.equal(env.inject(), 'patched');
  env.state = w.__sfuiPassthrough;
  return env;
}

await test("listens on the bar popup's own window, not SharedJSContext's or the \"+\" menu's", async () => {
  // Regression: the listener used to sit on SharedJSContext's window, which
  // a click inside the bar popup (a separate window) never reaches.
  const p = page();
  assert.equal(p.w.listeners.click, undefined);
  assert.ok(p.bar().listeners.click?.capture);
  assert.equal(p.popups[1].window.listeners.click, undefined, '"+" menu popup left alone');
  assert.ok(p.bar().styles.get('sfui-passthrough-style')?.textContent.includes(`[${ATTR}="rgb"]`));
});

await test('full cycle off -> colour -> mono -> off, each state its own visual', async () => {
  const p = page();
  await p.advance(0);
  assert.equal(p.shown(), 'off');
  p.button().click(); await p.advance(2000);
  assert.equal(p.action.active, true);
  assert.equal(p.shown(), 'rgb');
  p.button().click(); await p.advance(2000);
  assert.equal(p.action.active, true, 'colour -> mono keeps room view on');
  assert.equal(p.shown(), 'mono');
  p.button().click(); await p.advance(2000);
  assert.equal(p.action.active, false);
  assert.equal(p.shown(), 'off');
});

await test('scan refreshes stale state: a bar reappearing while off, and room view turned on elsewhere', async () => {
  // Regression: the refresh on a newly visible bar set the mode from the
  // source byte alone (rgb survives room view off), so the icon showed
  // colour while off and the next press was swallowed as colour -> mono.
  const p = page({ helperSource: 'rgb' });
  p.popups[0].window.closed = true;
  p.popups[0] = p.barPopup(7600010);
  await p.advance(1000);
  assert.equal(p.shown(), 'off', 'no colour visual while room view is off');
  p.button().click(); await p.advance(2000);
  assert.equal(p.action.active, true, 'the press turned room view on');
  assert.equal(p.shown(), 'rgb');
  // Room view then toggled off and on by something else entirely (e.g. a
  // controller binding): the icon still follows, from a fresh status read-back.
  p.action.active = false;
  await p.advance(1000);
  assert.equal(p.shown(), 'off');
  p.action.active = true;
  await p.advance(1100);
  assert.equal(p.helper.calls.at(-1), 'status');
  assert.equal(p.shown(), 'rgb');
});

await test('quick presses are queued, not dropped, and each one advances exactly one state', async () => {
  const p = page();
  await p.advance(0);
  p.button().click(); p.button().click();     // off -> colour -> mono, before anything settles
  await p.advance(3000);
  assert.equal(p.action.active, true);
  assert.equal(p.shown(), 'mono');
  assert.deepEqual(p.helper.calls.filter((c) => c.startsWith('set')), ['set rgb', 'set mono']);
  p.button().click(); p.button().click();     // mono -> off -> colour
  await p.advance(3000);
  assert.equal(p.action.active, true);
  assert.equal(p.shown(), 'rgb');
  assert.equal(p.helper.stockClicks, 3);
});

await test('off press: colour is set before the stock click; purple within one fast tick of active', async () => {
  for (const helperSource of ['rgb', 'mono']) {
    const p = page({ helperSource });
    await p.advance(0);
    p.button().click();
    await p.advance(HELPER_MS);                 // set rgb answered; stock click replayed now
    assert.deepEqual(p.helper.calls.filter((c) => c !== 'status'), ['set rgb']);
    assert.equal(p.helper.stockClicks, 1, 'stock click only after the colour read-back');
    assert.equal(p.shown(), 'off', 'still off until SteamVR reports active');
    await p.advance(STOCK_TOGGLE_MS);           // room view now reports active
    assert.equal(p.action.active, true);
    await p.advance(50);                        // one fast poll tick
    assert.equal(p.shown(), 'rgb', `purple within 50 ms of active (source was ${helperSource})`);
  }
});

await test("a stale fiber on the button (React's alternate) still sees `active` within one tick", async () => {
  // Regression: the button's __reactFiber$ can be the uncommitted alternate,
  // whose props lag a render; `active` then showed up only ~1 s later.
  const p = page({ helperSource: 'rgb' });
  await p.advance(0);
  // Two fiber trees, as React keeps them: committed (A, root R) and the
  // alternate (A2, root R2). The DOM node points at A2.
  const root = { tag: 3, return: null }, root2 = { tag: 3, return: null };
  root.stateNode = root2.stateNode = { current: root };
  const staleAction = { ...p.action, active: false };
  const A = { memoizedProps: { action: p.action }, return: root };
  const A2 = { memoizedProps: { action: staleAction }, return: root2, alternate: A };
  A.alternate = A2;
  p.button().__reactFiber$x = A2;
  p.button().click();
  await p.advance(HELPER_MS + STOCK_TOGGLE_MS);   // committed tree now active; the stale one isn't
  assert.equal(p.action.active, true);
  assert.equal(staleAction.active, false);
  await p.advance(50);
  assert.equal(p.shown(), 'rgb', 'purple within one 50 ms tick');
});

await test('SteamVR resetting the source after colour was set: the icon follows the re-read', async () => {
  const p = page();
  await p.advance(0);
  p.button().click();
  await p.advance(HELPER_MS + STOCK_TOGGLE_MS + 50);   // colour on, purple shown
  assert.equal(p.shown(), 'rgb');
  p.helper.source = 'mono';                  // the renderer reverted it
  await p.advance(1500);
  assert.equal(p.shown(), 'mono');
  p.button().click(); await p.advance(2000); // decided from the read-back: mono -> off
  assert.equal(p.action.active, false);
});

await test('degraded modes still complete the cycle: no Arcturus camera, and no relay', async () => {
  for (const opts of [{ arcturus: false }, { relay: false }]) {
    const p = page(opts);
    await p.advance(0);
    p.button().click(); await p.advance(2000);
    assert.equal(p.action.active, true);
    assert.equal(p.shown(), 'mono');
    p.button().click(); await p.advance(2000);
    assert.equal(p.action.active, false);
    assert.equal(p.shown(), 'off');
  }
});

await test('redraw resilience: survives a re-render, covers every bar window, a dead window does not block new ones', async () => {
  const p = page();
  await p.advance(0);
  p.button().click(); await p.advance(2000);
  assert.equal(p.shown(), 'rgb');
  // React replaces the button element: the observer re-marks the new one.
  const bar = p.bar();
  const fresh = p.barPopup(0).window.buttons[1];
  bar.buttons[1] = fresh;
  for (const o of p.observers) if (o.on) o.cb([]);
  assert.equal(fresh.getAttribute(ATTR), 'rgb');
  // Regression: the stale-window cleanup read w.closed unguarded; one popup
  // throwing there (as a torn-down one might) broke attach() for the whole
  // tick, so a new bar never got its listener or stylesheet.
  Object.defineProperty(bar, 'closed', { get() { throw new Error('disposed'); } });
  const second = p.barPopup(7600020);
  p.popups.push(second);
  await p.advance(1000);
  assert.equal(p.shown(second), 'rgb', 'second bar window decorated despite the first throwing');
  assert.ok(second.window.styles.has('sfui-passthrough-style'));
  assert.ok(second.window.listeners.click?.capture);
});

await test('re-injection: same id just rescans; unpatch removes listener, style, attribute', async () => {
  const p = page();
  p.button().click(); await p.advance(2000);
  assert.equal(p.inject(), 'unchanged');
  assert.equal(p.run(UNPATCH), 'unpatched');
  assert.equal(p.bar().listeners.click, undefined);
  assert.equal(p.bar().styles.size, 0);
  assert.equal(p.shown(), null);
  assert.equal(p.w.__sfuiPassthrough, undefined);
  assert.equal(p.run(UNPATCH), 'not patched');
});

await test('unpatched mid-press: no stock click replayed afterwards', async () => {
  const p = page();
  p.action.active = true;
  await p.advance(1100);
  p.helper.source = 'mono';
  p.button().click();                 // mono -> off: status first, then the stock click
  p.run(UNPATCH);
  await p.advance(2000);
  assert.equal(p.helper.stockClicks, 0);
  assert.equal(p.action.active, true);
});

await test('g_PopupManager missing: left unpatched', async () => {
  const w = { console };
  w.window = w;
  vm.createContext(w);
  const find = vm.runInContext(FINDERS, w);
  assert.equal(vm.runInContext(PATCH, w)(find, {}, OPTS), 'g_PopupManager missing');
  assert.equal(w.__sfuiPassthrough, undefined);
});

console.log(`${passed} tests passed`);
