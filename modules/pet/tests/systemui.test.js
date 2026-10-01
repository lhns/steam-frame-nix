// Headless tests of the SteamVR adapter (systemui.js) in a fake systemui page:
// a minimal DOM, VRHTML (poses, sgids), SGApp's embedded-UV table, the scene
// graph module (slow send) and mailbox (captured socket: fast send), the
// steam-ui-patches store, and fake timers (virtual clock).
// usage: node systemui.test.js <models.json>   (exit 1 on failure)
// Run by the flake check `pet` (package.nix `tests`).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));   // index.py's models.json
const baked0 = catalog.frameSets[catalog.models[catalog.default].frames];
const src = ['core.js', 'systemui.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
const PREFIX = 'mailbox_send vrcompositor_systemlayer ';

// ---- fake DOM ----
class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.attrs = {}; this.children = []; this.parent = null; this.style = {}; this.listeners = {}; this.id = ''; this.textContent = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceWith(n) { const p = this.parent, i = p.children.indexOf(this); n.remove(); p.children[i] = n; n.parent = p; this.parent = null; }
  get firstChild() { return this.children[0] ?? null; }
  get parentNode() { return this.parent; }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e === this.doc.body; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter((g) => g !== f); }
  getBoundingClientRect() {
    if (!this.isConnected || this.style.position !== 'fixed') return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const x = parseFloat(this.style.left), y = parseFloat(this.style.top), w = parseFloat(this.style.width), h = parseFloat(this.style.height);
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
  }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  // A laser event, as the browser runs it: window's capture listeners first
  // (whatever the target does), then the target and its ancestors, then
  // window's bubbling listeners, unless stopped.
  dispatch(type, mods = {}) {
    const e = { type, target: this, stopped: false, stopPropagation() { this.stopped = true; }, getModifierState: (k) => !!mods[k] };
    const win = this.doc.win.listeners[type] ?? [];
    for (const [f, capture] of win) if (capture) f(e);
    for (let n = this; n && !e.stopped; n = n.parent) for (const f of n.listeners[type] ?? []) f(e);
    if (!e.stopped) for (const [f, capture] of win) if (!capture) f(e);
    return e;
  }
}

function page({ store = {}, sgQuery = true, setup = null } = {}) {
  // virtual clock and timers
  const clock = { now: 0, id: 0, timers: new Map(), scheduled: 0 };
  const setT = (f, ms, every) => { const id = ++clock.id; clock.scheduled++; clock.timers.set(id, { f, at: clock.now + Math.max(0, ms || 0), every: every ? Math.max(1, ms) : 0 }); return id; };
  const advance = async (ms) => {
    const end = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of clock.timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      clock.now = t.at;
      if (t.every) t.at += t.every; else clock.timers.delete(id);
      t.f();
      await new Promise((r) => setImmediate(r));   // promise callbacks (where()) between timers
    }
    clock.now = end;
    await new Promise((r) => setImmediate(r));
  };

  const doc = { };
  const win = { listeners: {}, addEventListener(t, f, capture = false) { (this.listeners[t] ??= []).push([f, !!(capture?.capture ?? capture)]); },
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter(([g]) => g !== f); } };
  doc.win = win;
  doc.all = [];   // every element made (also those out of the page: a hidden cat's)
  doc.createElement = (t) => { const e = new El(t, doc); doc.all.push(e); return e; };
  doc.body = new El('body', doc);
  doc.head = new El('head', doc);
  doc.querySelectorAll = (sel) => {
    const m = /^\[([\w-]+)="([^"]+)"\]$/.exec(sel);
    return [...doc.body.walk()].filter((e) => m && e.getAttribute(m[1]) === m[2]);
  };
  // A dashboard panel at the top of the page (the free spot must avoid it).
  const dash = doc.createElement('vsg-node');
  dash.setAttribute('vsg-type', 'panel');
  const dashContent = doc.createElement('div');
  Object.assign(dashContent.style, { position: 'fixed', left: '0px', top: '0px', width: '1280px', height: '600px' });
  dash.getBoundingClientRect = () => dashContent.getBoundingClientRect();
  dash.appendChild(dashContent);
  doc.body.appendChild(dash);

  const stats = { slow: 0, fast: 0, force: 0, get total() { return this.slow + this.fast + this.force; }, lastFast: null };
  let sgid = 1000;
  const poses = { '/user/head': { p: [0, 1.6, 1.6], q: [1, 0, 0, 0] }, '/user/hand/left': null, '/user/hand/right': null };
  const nodePoses = {};   // sg query answers by id (default: its pose in the DOM, as vrcompositor has it at rest)
  const embedded = [];
  // The scene graph mailbox and its socket; the dashboard's send (slow path)
  // walks the DOM: our root's node is in the message only while connected.
  const sock = { readyState: 1, send(str) { if (str.startsWith(PREFIX)) stats.fast++; stats.lastSent = str; } };
  class Mailbox { SendMessage() {} SendMessageAndWaitForResponse() {} RegisterHandler() {} }
  const mailbox = new Mailbox();
  mailbox.m_wsWebSocketToServer = sock;
  const slowSend = function update_scene_graph() {
    stats.slow++; stats.fast--;   // the socket counts it too
    const root = [...doc.body.children].find((e) => e.id === 'sfui-vr-pet');
    mailbox.SendMessage('vrcompositor_systemlayer', { type: 'update_scene_graph' });
    const msg = { type: 'update_scene_graph', scene_graph: { properties: { eDashboardRelatch: 0 }, children: root ? [{ type: 'transform', properties: { id: `system.systemui::${root.id}`, sgid: +root.getAttribute('sgid') }, children: [] }] : [] } };
    mailbox.m_wsWebSocketToServer.send(PREFIX + JSON.stringify(msg));
  };
  const req = {};
  const find = {
    getWebpackRequire: () => req,
    findModule(r, spec, label) {
      if (label === 'scene graph module') return { exports: { send: slowSend } };
      if (label === 'mailbox module') return { exports: { Mailbox } };
      throw new Error(`no ${label}`);
    },
    findExport(exports, spec) {
      const v = Object.values(exports).find((x) => typeof x === 'function');
      return { value: v };
    },
  };
  const hooks = {
    before(obj, m, name, f) { const orig = obj[m]; obj[m] = function (...a) { f.call(this, a); return orig.apply(this, a); }; obj[m].__orig = orig; },
    remove(obj, m) { if (obj[m].__orig) obj[m] = obj[m].__orig; },
  };
  const xf = (p) => ({ translation: { x: p.p[0], y: p.p[1], z: p.p[2] }, rotation: { w: p.q[0], x: p.q[1], y: p.q[2], z: p.q[3] } });
  const G = {
    window: null, document: doc, innerWidth: 1280, innerHeight: 1440,
    performance: { now: () => clock.now },
    setTimeout: (f, ms) => setT(f, ms, false), clearTimeout: (id) => clock.timers.delete(id),
    setInterval: (f, ms) => setT(f, ms, true), clearInterval: (id) => clock.timers.delete(id),
    queueMicrotask, Promise, JSON, Math, Object, Array, Set, Map, Number, String, Error, console,
    addEventListener: (t, f, c) => win.addEventListener(t, f, c), removeEventListener: (t, f, c) => win.removeEventListener(t, f, c),
    forceLayoutUpdate: () => { stats.force++; G.SGApp.updateAllPanelBounds(); },
    VRHTML: {
      NextSGID: () => ++sgid,
      GetPose: (p) => [poses[p] ? { bPoseIsValid: true, xfDeviceToAbsoluteTracking: xf(poses[p]), vVelocity: { x: 0, y: 0, z: 0 } } : { bPoseIsValid: false }],
      VROverlay: { ThisOverlayKey: () => 'system.systemui' },
    },
    // SGApp: its panels by sgid (the embedded ones too); a layout measures
    // every panel (updateLayoutValues: its m_Rect, the slot's rect).
    SGApp: {
      m_mapPanels: new Map(),
      addEmbeddedPanelUVs(fp) { embedded.push(fp); this.m_mapPanels.set(fp.getSGID(), fp); return embedded.length - 1; },
      removeEmbeddedPanelUVs(fp) { const i = embedded.indexOf(fp); if (i >= 0) embedded[i] = null; this.m_mapPanels.delete(fp.getSGID()); },
      updateAllPanelBounds() { this.m_mapPanels.forEach((fp) => fp.updateLayoutValues?.()); },
    },
    __sfuiStore: { data: { 'vr-pet': store }, get(n) { return this.data[n]; }, set(n, v) { this.data[n] = v; return true; } },
  };
  // A node's world pose from the DOM's translation / rotation attributes.
  const domPose = (id) => {
    const local = id.split('::').pop();
    let e = [...doc.body.walk()].find((n) => n.id === local), w = { p: [0, 0, 0], q: [1, 0, 0, 0] };
    for (; e && e !== doc.body; e = e.parent) {
      const t = e.getAttribute('translation'), r = e.getAttribute('rotation');
      if (t || r) w = qc({ p: t ? t.split(' ').map(Number) : [0, 0, 0], q: r ? r.split(' ').map(Number) : [1, 0, 0, 0] }, w);
    }
    return w;
  };
  // vrcompositor, as far as the cat relies on it: the world poses of the last
  // sent scene graph. A transform with a parent-path: that device's pose · its
  // own, rigidly (its ancestors ignored), as SteamVR's floating windows use it;
  // a grab-scale: its children pushed along its -Z by `vrc.push` (the
  // thumbstick) while active, back to 0 on a new reset-generation.
  const vrc = { push: 0, gens: new Map() };
  vrc.world = () => {
    const out = new Map();
    const msg = stats.lastSent ? JSON.parse(stats.lastSent.slice(PREFIX.length)) : null;
    const visit = (n, parent) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((c) => visit(c, parent)); return; }
      const P = n.properties ?? {}, local = { p: P.translation ?? [0, 0, 0], q: P.rotation ?? [1, 0, 0, 0] };
      const dev = P['parent-path'] ? poses[P['parent-path']] : null;
      let w = parent;
      if (n.type === 'transform') w = qc(dev ?? parent, local);
      else if (n.type === 'grab-scale') {
        if (vrc.gens.has(P.sgid) && vrc.gens.get(P.sgid) !== P['reset-generation']) vrc.push = 0;
        vrc.gens.set(P.sgid, P['reset-generation']);
        w = P['is-active'] ? qc(parent, { p: [0, 0, -vrc.push], q: [1, 0, 0, 0] }) : parent;
      }
      if (P.sgid != null) out.set(P.sgid, w);
      if (P.id) out.set(P.id, w);
      visit(n.children, w);
    };
    visit(msg?.scene_graph, { p: [0, 0, 0], q: [1, 0, 0, 0] });
    return out;
  };
  const sgPoseOf = (id) => nodePoses[id] ?? vrc.world().get(id) ?? domPose(id);
  if (sgQuery) {
    G.SGQueryService = {
      requestSGTransform: (id) => Promise.resolve(xf(sgPoseOf(id))),
      requestSGTransformRelative: (from, id) => Promise.resolve({ ...xf(qc(qinv(sgPoseOf(from)), sgPoseOf(id))), scale: { x: 1, y: 1, z: 1 } }),
    };
  }
  G.window = G;
  const ctx = vm.createContext(G);
  vm.runInContext(`${src}\n;globalThis.vrPetSystemui = vrPetSystemui;`, ctx);
  const opts = { fps: 24, mount: 'dynamic', cat: {} };
  const inject = () => ctx.vrPetSystemui(opts, catalog, find, hooks);
  setup?.(G, doc);
  return {
    G, doc, clock, advance, stats, poses, nodePoses, domPose, vrc, embedded, mailbox, sock, inject,
    // the patch's unpatch expression (unpatch.js), as the injector runs it when the service stops
    unpatch: () => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'unpatch.js'), 'utf8'), ctx),
    listeners: () => Object.values(win.listeners).reduce((n, l) => n + l.length, 0),
    get S() { return G.__sfuiPet; },
    get stored() { return G.__sfuiStore.data['vr-pet']; },
    activeTimers: () => clock.timers.size,
    // A layout (the page's own, not a send), and whether a panel's embedded-UV slot holds a rect.
    layout: () => G.SGApp.updateAllPanelBounds(),
    slotValid: (fp) => !!fp && fp.idx != null && !fp.isExternal && fp.m_Rect.width > 0 && fp.m_Rect.height > 0,
    fpOf: (id) => G.SGApp.m_mapPanels.get(+(doc.all.find((e) => e.id === id)?.getAttribute('sgid'))),
    // A laser click on an element (mousedown, mouseup, click; hand in the modifier state).
    click(el, hand = 'right') {
      const mods = hand === 'left' ? { NumLock: true } : { CapsLock: true, NumLock: true };
      el.dispatch('mousedown', mods); el.dispatch('mouseup', mods); return el.dispatch('click', mods);
    },
    byId: (id) => [...doc.body.walk()].find((e) => e.id === id) ?? doc.all.find((e) => e.id === id) ?? null,
    byAttr: (k, v) => doc.all.find((e) => e.getAttribute(k) === v) ?? null,
    dash: dashContent,
    lastMsg: () => (stats.lastSent ? JSON.parse(stats.lastSent.slice(PREFIX.length)) : null),
  };
}

// Pose maths (w x y z quaternions): compose, invert, rotate.
const qm = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
const qr = (q, v) => qm(qm(q, [0, ...v]), qconj(q)).slice(1);
const qaxis = (ax, deg) => { const h = deg * Math.PI / 360; return [Math.cos(h), ...ax.map((v) => v * Math.sin(h))]; };
function qc(a, b) { const r = qr(a.q, b.p); return { p: a.p.map((v, k) => v + r[k]), q: qm(a.q, b.q) }; }
const qinv = (a) => { const c = qconj(a.q); return { p: qr(c, a.p).map((v) => -v), q: c }; };
const sgPose = (n) => ({ p: n.properties.translation ?? [0, 0, 0], q: n.properties.rotation ?? [1, 0, 0, 0] });

let failed = 0;
const tests = [];
const test = (name, f) => tests.push([name, f]);
function assert(c, msg) { if (!c) throw new Error(msg); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Find a node by sgid in a scene graph message.
function findSg(n, pred) {
  if (!n || typeof n !== 'object') return null;
  if (Array.isArray(n)) { for (const c of n) { const r = findSg(c, pred); if (r) return r; } return null; }
  if (pred(n)) return n;
  return findSg(n.children, pred) ?? findSg(n.scene_graph, pred);
}
// A page with the cat running for `s` seconds (frames mounted, fast path captured).
async function running(s = 3, o) {
  const p = page(o);
  const r = p.inject();
  assert(/^patched/.test(r), `injected (${r})`);
  await p.advance(s * 1000);
  return p;
}

// ---------------------------------------------------------------------------

test('injects: root in the page, timer, fast sends, api', async () => {
  const p = await running();
  assert(p.S.root.isConnected, 'root in the page');
  assert(p.S.timer != null, 'timer running');
  assert(p.stats.fast > 0, `fast sends (${JSON.stringify(p.S.stats().deferred)}, fast ${p.stats.fast})`);
  assert(p.S.api?.version === 2 && ['show', 'hide', 'status', 'models', 'setModel'].every((k) => typeof p.S.api[k] === 'function'), 'api { version, show, hide, status, models, setModel }');
  assert(p.inject() === 'unchanged', 're-inject of a shown cat: unchanged');
});

test('controls row (⋯ X): centred below the bar, laser-only, not a grab handle, in the fast send', async () => {
  const p = await running();
  const msg = p.lastMsg();
  const sg = (id) => findSg(msg.scene_graph, (n) => n.properties?.id === `system.systemui::${id}`);
  const bar = sg('sfui-vr-pet-handle'), x = sg('sfui-vr-pet-controls');
  assert(bar && x, 'bar and controls panels in the fast send');
  assert(!sg('sfui-vr-pet-menu'), 'no menu while closed');
  assert(p.byAttr('data-act', 'menu') && p.byAttr('data-act', 'close'), 'buttons ⋯ and X');
  assert(!findSg(msg.scene_graph, (n) => n.type === 'grab-transform'), 'no grab-transform (the dashboard\'s drag: not rigid on the laser)');
  const push = findSg(msg.scene_graph, (n) => n.type === 'grab-scale');
  assert(push && push.properties['is-active'] === false && !('event-panel-sgid' in push.properties), 'the push: inactive, no event panel at rest');
  assert(findSg(push, (n) => n === x) && findSg(push, (n) => n === bar), 'the bar and the X hang under the push (carried with the drag)');
  const lift = findSg(push, (n) => n.type === 'transform' && findSg(n.children, (c) => c === bar) && n.properties.translation[1] > 0.3);
  assert(near(lift.properties.translation[1], 0.40, 1e-9), `lift 0.40 (${lift.properties.translation})`);
  const facing = lift.children[0];
  assert(facing.type === 'head-facing-transform' && facing.children[0] === bar, 'bar under the head-facing transform');
  const below = facing.children[1];
  assert(below.type === 'transform' && below.children[0] === x, 'X under the same head-facing transform');
  const XP = x.properties, BP = bar.properties;
  assert(near(below.properties.translation[1], -(0.008 + 0.04), 1e-9) && below.properties.translation[0] === 0, `controls 8 mm below the bar, centred (${below.properties.translation})`);
  assert(XP.width === 0.08 && XP.origin[0] === 0 && XP.origin[1] === -1, 'controls 0.08 m, bottom-centre origin');
  assert(XP['only-visible-with-laser'] === true && XP['is-grab-handle'] === false && XP['hide-laser-when-clicking'] === false && XP.interactive === true,
    'X: laser-only, no grab handle, laser kept, interactive');
  assert(BP['is-grab-handle'] === true, 'bar: grab handle');
  // Textures: one free spot, the X's rect centred below the bar's, not overlapping, below the dashboard's panel.
  const bu = [BP.uv_min, BP.uv_max].map(([u, v]) => [u * 1280, v * 1440]), xu = [XP.uv_min, XP.uv_max].map(([u, v]) => [u * 1280, v * 1440]);
  assert(xu[0][1] >= bu[1][1], 'X texture below the bar texture');
  assert(near((xu[0][0] + xu[1][0]) / 2, (bu[0][0] + bu[1][0]) / 2, 1e-6), 'X texture centred under the bar texture');
  assert(near(xu[1][0] - xu[0][0], 96, 1e-6) && near(xu[1][1] - xu[0][1], 48, 1e-6), 'controls texture 96 x 48 px');
  assert(bu[0][1] >= 600, 'free spot below the dashboard panel');
  assert(p.embedded.length === 3 && XP['embedded-uv-index'] !== BP['embedded-uv-index'], 'three embedded UV slots (bar, controls, menu)');
  // Dangling: the handle drops to liftDangle.
  p.S.cat.command('dangle');
  await p.advance(500);
  const d = findSg(p.lastMsg().scene_graph, (n) => n.type === 'transform' && n.properties.sgid === lift.properties.sgid);
  assert(near(d.properties.translation[1], 0.15, 1e-9), `dangle lift 0.15 (${d.properties.translation})`);
});

test('X click hides: one send, then no sends and no timers for 10 s; persisted', async () => {
  const p = await running();
  const before = p.stats.total, sched = p.clock.scheduled;
  const e = p.click(p.byAttr('data-act', 'close'));
  assert(e.stopped, 'the click does not reach the dashboard');
  assert(p.S.hidden && !p.S.root.isConnected, 'hidden, root out of the page');
  assert(p.stats.total - before === 1, `one send (${p.stats.total - before})`);
  const m = p.lastMsg();
  assert(!findSg(m.scene_graph, (n) => n.properties?.sgid === +p.S.root.getAttribute('sgid')), 'that send has no cat');
  assert(p.S.stats().frames === 0 && ![...p.S.root.walk()].some((n) => n.buildNode?.({})?.[1]?.type === 'rendermodel'), 'frames unmounted');
  assert(p.activeTimers() === 0, `no timers (${p.activeTimers()})`);
  await p.advance(10000);
  assert(p.stats.total - before === 1, `still one send after 10 s (${p.stats.total - before})`);
  assert(p.clock.scheduled === sched, `no timer scheduled while hidden (${p.clock.scheduled - sched})`);
  assert(p.stored.hidden === true && Number.isFinite(p.stored.x), `stored hidden with the spot (${JSON.stringify(p.stored)})`);
  assert(p.inject() === 'unchanged', 're-inject while hidden: unchanged (not resurrected)');
  assert(!p.S.root.isConnected, 'still out of the page');
  assert(p.S.api.hide().was === 'hidden', 'hide again: already hidden');
  assert(p.stats.total - before === 1, 'hide again: no send');
});

test('show: back at its spot (near, in view), gradual remount, fresh mover, persisted', async () => {
  const p = await running();
  p.S.cat.command('sit');   // stays put (a wandering cat's stored spot lags behind)
  await p.advance(4000);
  const at = p.S.cat.state();
  const gen = p.S.stats().pushSent['reset-generation'];
  p.S.api.hide();
  const r = p.S.api.show();
  assert(r.was === 'hidden' && !r.summoned && !p.S.hidden, `shown (${JSON.stringify(r)})`);
  const st = p.S.cat.state();
  assert(near(st.x, at.x, 1e-9) && near(st.z, at.z, 1e-9), 'at its spot');
  assert(p.S.root.isConnected && p.S.timer != null, 'root and timer back');
  assert(p.S.stats().pushSent['reset-generation'] > gen && !p.S.stats().carry, 'a fresh push (reset), not carried');
  assert(p.S.stats().frames <= 3, `frames mount gradually (${p.S.stats().frames} on the first tick)`);
  await p.advance(3000);
  assert(p.S.stats().frames > 3, 'frames mounted again');
  assert(p.stored.hidden === false && near(p.stored.x, p.S.cat.state().x, 0.5), `stored hidden: false, spot kept (${JSON.stringify(p.stored)})`);
  const again = p.S.api.show();
  assert(again.was === 'shown' && !again.summoned, 'show again: idempotent');
  assert(p.inject() === 'unchanged', 'shown again: unchanged');
});

test('show: summoned when far or out of view, or forced', async () => {
  const p = await running();
  const head = p.poses['/user/head'];
  // far: the cat 5 m away
  p.S.api.hide();
  p.poses['/user/head'] = { p: [0, 1.6, 6.6], q: [1, 0, 0, 0] };
  let r = p.S.api.show();
  let st = p.S.cat.state();
  assert(r.summoned && near(st.x, 0, 1e-6) && near(st.z, 5.6, 1e-6), `far: summoned 1 m in front (${st.x}, ${st.z})`);
  // behind the user: near but out of view
  await p.advance(500);
  p.S.api.hide();
  p.poses['/user/head'] = { p: [0, 1.6, st.z - 1.2], q: [1, 0, 0, 0] };   // stepped past it, looking away
  r = p.S.api.show();
  assert(r.summoned, 'out of view: summoned');
  // forced
  await p.advance(500);
  p.S.api.hide();
  r = p.S.api.show({ summon: true });
  assert(r.summoned, '--summon: summoned');
  p.poses['/user/head'] = head;
});

test('X during a laser drag: inert (also released over it, and 300 ms after)', async () => {
  const p = await running();
  p.poses['/user/hand/right'] = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] };
  const R = { CapsLock: true, NumLock: true };
  const bar = p.byId('sfui-vr-pet-handle-content'), x = p.byAttr('data-act', 'close');
  const at = p.S.cat.state();
  assert(!bar.hasAttribute('data-active') && bar.children[0]?.getAttribute('class') === 'sfui-vr-pet-grip', 'the bar: idle look, the grip');
  bar.dispatch('mousedown', R);
  await p.advance(300);
  assert(p.S.stats().drag?.phase === 'drag' && p.S.stats().carry === '/user/hand/right', `dragging (${JSON.stringify(p.S.stats().drag)})`);
  assert(p.S.cat.state().held?.source === 'laser', 'held by the laser');
  assert(bar.hasAttribute('data-active'), 'the bar: dragging look during the drag');
  // a press and release on the X while dragging (the other hand's laser): nothing
  p.click(x, 'left');
  assert(!p.S.hidden && p.S.stats().drag, 'X during the drag: still shown, still dragged');
  assert(!x.hasAttribute('data-armed'), 'X not armed during the drag');
  // the drag released over the X: ends the drag, does not hide
  x.dispatch('mouseup', R); x.dispatch('click', R);
  assert(!p.S.hidden, 'drag released over the X: shown');
  // right after the drag: still inert
  await p.advance(100);
  p.click(x);
  assert(!p.S.hidden, 'X 100 ms after the drag: shown');
  await p.advance(1500);
  assert(!p.S.stats().drag, 'drag over');
  assert(!bar.hasAttribute('data-active'), 'the bar: dragging look gone after the release');
  void at;
});

test('api.hide during a laser drag: drag cancelled, stands where it was carried (the hand still: the start); show: a fresh push', async () => {
  const p = await running();
  p.poses['/user/hand/right'] = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] };
  const at = p.S.cat.state();
  const gen = p.S.stats().pushSent['reset-generation'];
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', { CapsLock: true, NumLock: true });
  await p.advance(300);
  assert(p.S.stats().drag?.phase === 'drag' && p.S.stats().carry, 'dragging, carried');
  p.S.api.hide();
  const st = p.S.cat.state();
  assert(p.S.hidden && !p.S.stats().drag && p.S.root.getAttribute('parent-path') === null && !p.S.stats().pushSent['is-active'],
    'drag cancelled (root back in the world, push inactive)');
  assert(!st.held && !st.falling && st.pose === 'stand', `settled (${st.pose}, held ${JSON.stringify(st.held)})`);
  // (settle(): a dangling cat stands below its scruff, up to the scruff's
  // offset from the feet away from where it was picked up)
  const off = Math.hypot(...baked0.poseZones.stand.scruff.filter((_, k) => k !== 1)) + 0.02;
  assert(Math.hypot(st.x - at.x, st.z - at.z) < off, `at the drag's start (${st.x.toFixed(3)} ${st.z.toFixed(3)} vs ${at.x.toFixed(3)} ${at.z.toFixed(3)})`);
  await p.advance(2000);
  p.S.api.show();
  assert(p.S.stats().pushSent['reset-generation'] > gen && !p.S.stats().carry, 'fresh push, not carried');
  await p.advance(500);
  assert(!p.S.cat.state().held, 'not held after show');
});

// A laser drag of the bar by the right hand, pressed at H0, checked against
// the vrcompositor model (p.vrc): dr.move(H) sets the hand, runs 300 ms and
// checks what is drawn: the bar's origin fixed in the controller's frame (its
// place on the laser and its distance; pushed along the line from the
// controller by the push), the cat upright, its scruff straight below the
// bar, turned by the controller's heading since the grab. dr.release() lets
// go: the fall starts where it was drawn, the root back in the world there.
async function pressBar(p, H0 = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] }) {
  p.poses['/user/hand/right'] = H0;
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', { CapsLock: true, NumLock: true });
  await p.advance(500);
  assert(p.S.stats().drag?.phase === 'drag' && p.S.stats().carry === '/user/hand/right', 'dragging, carried by the right hand');
  const heading = (q) => { const f = qr(q, [0, 0, -1]); return Math.atan2(f[0], f[2]) * 180 / Math.PI; };
  const wrap = (a) => ((a + 540) % 360) - 180;
  const drawn = (w) => {
    const sg = p.lastMsg().scene_graph;
    const frame = findSg(sg, (n) => n.type === 'transform' && n.properties.scale?.[0] === 1 && n.children?.[0]?.type === 'rendermodel');
    const outer = findSg(sg, (n) => n.type === 'transform' && n.children?.[0]?.type === 'head-facing-transform');
    return { bar: w.get('system.systemui::sfui-vr-pet-handle').p, cat: w.get(frame.properties.sgid), lift: outer.properties.translation[1] };
  };
  const dr = { H0, g0: null, cat0: null, last: null };
  dr.check = (H, w, label, { body = true, push = 0 } = {}) => {
    const d = drawn(w);
    const g = qc(qinv(H), { p: d.bar, q: [1, 0, 0, 0] }).p;   // the bar's origin in the controller's frame
    dr.g0 ??= g;
    const l0 = Math.hypot(...dr.g0), want = dr.g0.map((v) => v * (1 + push / l0));
    const off = Math.hypot(...g.map((v, k) => v - want[k]));
    assert(off < 0.002, `${label}: the bar keeps its place on the laser (${(off * 1000).toFixed(1)} mm off in the controller's frame; ${Math.hypot(...g).toFixed(3)} m from it, want ${Math.hypot(...want).toFixed(3)})`);
    if (!body) return d;
    assert(near(d.lift, 0.15, 1e-9), `${label}: dangling, the bar at liftDangle (${d.lift})`);
    dr.cat0 ??= { yaw: heading(d.cat.q), hand: heading(H.q) };
    const up = qr(d.cat.q, [0, 1, 0]);
    assert(up[1] > Math.cos(Math.PI / 180), `${label}: the cat upright (tilt ${(Math.acos(Math.min(1, up[1])) * 180 / Math.PI).toFixed(1)} deg)`);
    const dx = Math.hypot(d.cat.p[0] - d.bar[0], d.cat.p[2] - d.bar[2]);
    assert(dx < 0.002 && near(d.bar[1] - d.cat.p[1], 0.15, 0.002), `${label}: the scruff straight below the bar (${(dx * 1000).toFixed(1)} mm aside, ${(d.bar[1] - d.cat.p[1]).toFixed(3)} m below)`);
    const dyaw = wrap(heading(d.cat.q) - dr.cat0.yaw - (heading(H.q) - dr.cat0.hand));
    assert(Math.abs(dyaw) < 1, `${label}: turned by the controller's heading (off by ${dyaw.toFixed(1)} deg)`);
    dr.last = d;
    return d;
  };
  dr.check(H0, p.vrc.world(), 'grabbed', { body: false });
  dr.move = async (H, label, o) => { p.poses['/user/hand/right'] = H; await p.advance(300); return dr.check(H, p.vrc.world(), label, o); };
  dr.release = async () => {
    const d = dr.last;
    p.byId('sfui-vr-pet-handle-content').dispatch('mouseup', { CapsLock: true, NumLock: true });
    await p.advance(1000 / 24 * 3);
    const st = p.S.cat.state();   // (falling, or landed already when let go low)
    assert(!st.held && !p.S.stats().drag && Math.hypot(st.x - d.cat.p[0], st.z - d.cat.p[2]) < 0.15,
      `released below where it was drawn (${st.x.toFixed(3)} ${st.z.toFixed(3)} vs ${d.cat.p[0].toFixed(3)} ${d.cat.p[2].toFixed(3)})`);
    const root = p.vrc.world().get('system.systemui::sfui-vr-pet');
    assert(!p.S.stats().carry && Math.hypot(root.p[0] - st.x, root.p[2] - st.z) < 0.05, `the root back in the world at the cat (${root.p.map((v) => v.toFixed(3))})`);
  };
  return dr;
}

// The drag twist test for a model: the cat (the default) or another animal
// (switched to first; its bar stands higher, the grab point is the same).
const twistTest = (model) => async () => {
  const p = await running();
  if (model !== catalog.default) {
    assert(catalog.models[model], `${model} in the catalog (${catalog.order})`);
    const r = p.S.api.setModel({ id: model });
    assert(r.model === model && !r.error, JSON.stringify(r));
    await p.advance(4000);
  }
  const dr = await pressBar(p);
  const tw = [[[0, 1, 0], 40], [[1, 0, 0], 35], [[0, 0, 1], 70], [[1, 0, 0], -50], [[0, 1, 0], -60], [[0, 0, 1], -80]];
  let H = dr.H0;
  for (let i = 0; i <= tw.length * 2; i++) {
    // twists about the controller (yaw, pitch, roll), each step also carried along a little
    if (i > 0) { const [ax, deg] = tw[(i - 1) % tw.length]; H = { p: H.p.map((v, k) => v + [0.03, -0.02, -0.04][k]), q: qm(H.q, qaxis(ax, deg)) }; }
    await dr.move(H, `step ${i}`);
  }
  // let go: the fall starts where it was drawn
  await dr.release();
};
test('laser drag: the grab point stays put on the laser through controller twists; the cat hangs upright below it, turned by the heading', twistTest(catalog.default));
test('laser drag of the Shiba: the grab point stays put through the twists, it hangs upright below it', twistTest('shiba'));

test('laser drag, pure pitch ±40°: the bar keeps its place on the laser and its distance from the controller (also between ticks)', async () => {
  const p = await running();
  const dr = await pressBar(p, { p: [0.1, 1.1, 1.0], q: qaxis([1, 0, 0], -30) });   // pointing down at the cat
  // tilted at the wrist (10 cm behind the controller's origin, 3 cm below):
  // the controller's origin moves a little too, as a real tilt does
  const wrist = qc(dr.H0, { p: [0, -0.03, 0.10], q: [1, 0, 0, 0] });
  for (const deg of [10, 20, 30, 40, 20, 0, -10, -20, -30, -40, -20, 0, 40, -40, 0]) {
    const H = qc(qc(wrist, { p: [0, 0, 0], q: qaxis([1, 0, 0], deg) }), qc(qinv(wrist), dr.H0));
    // as vrcompositor draws it with the new pose, before the next tick
    p.poses['/user/hand/right'] = H;
    dr.check(H, p.vrc.world(), `pitch ${deg}° (before the tick)`, { body: false });
    await dr.move(H, `pitch ${deg}°`);
  }
  await dr.release();
});

test('laser drag: the thumbstick push moves it along the laser; let go, it falls from the pushed point; the push resets', async () => {
  const p = await running();
  const dr = await pressBar(p);
  const gen = p.S.stats().pushSent['reset-generation'];
  assert(p.S.stats().pushSent['is-active'] === true && p.S.stats().pushSent['base-distance'] > 0.3,
    `push active while dragged, its base distance the grab point's (${JSON.stringify(p.S.stats().pushSent)})`);
  const bar = findSg(p.lastMsg().scene_graph, (n) => n.properties?.id === 'system.systemui::sfui-vr-pet-handle');
  assert(p.S.stats().pushSent['event-panel-sgid'] === bar.properties.sgid, 'the push\'s event panel: the bar');
  p.vrc.push = 0.6;   // pushed away 0.6 m (vrcompositor, the thumbstick)
  const H = { p: dr.H0.p.map((v, k) => v + [0.05, 0, -0.05][k]), q: qm(dr.H0.q, qaxis([0, 1, 0], 25)) };
  await dr.move(H, 'pushed', { push: 0.6 });
  assert(near(p.S.stats().drag.push, 0.6, 1e-3),`the push known (${p.S.stats().drag.push})`);
  await dr.release();
  assert(p.S.stats().pushSent['reset-generation'] > gen && p.S.stats().pushSent['is-active'] === false && !p.S.stats().carry, 'push reset, inactive; not carried');
  assert(p.vrc.push === 0, 'vrcompositor: the push back to 0');
});

test('X: press and release on it hide; a press released elsewhere or leaving it does not', async () => {
  const p = await running();
  const R = { CapsLock: true, NumLock: true };
  const x = p.byAttr('data-act', 'close'), bar = p.byId('sfui-vr-pet-handle-content');
  // pressed, released elsewhere (the bar)
  x.dispatch('mousedown', R);
  assert(x.hasAttribute('data-armed'), 'pressed look while pressed');
  bar.dispatch('mouseup', R);
  assert(!x.hasAttribute('data-armed'), 'pressed look gone on release');
  x.dispatch('click', R);
  assert(!p.S.hidden, 'released elsewhere: shown (a stray click does nothing)');
  // pressed, left, released on it
  x.dispatch('mousedown', R); x.dispatch('mouseleave', R); x.dispatch('mouseup', R); x.dispatch('click', R);
  assert(!p.S.hidden, 'left before the release: shown');
  // a release on it without a press on it
  x.dispatch('mouseup', R);
  assert(!p.S.hidden, 'release without a press: shown');
  // press and release on it
  const e = p.click(x);
  assert(p.S.hidden && e.stopped, 'press + release on the X: hidden (the click does not reach the dashboard)');
});

test('only the laser drag holds it: hands at the scruff do not, a falling cat is not caught', async () => {
  const p = page();
  p.inject();
  await p.advance(500);
  const sc = p.S.cat.zone('scruff');
  p.poses['/user/hand/left'] = { p: [sc.x, sc.y, sc.z], q: [1, 0, 0, 0] };
  p.poses['/user/hand/right'] = { p: [sc.x, sc.y + 0.02, sc.z], q: [1, 0, 0, 0] };
  await p.advance(2000);
  assert(!p.S.cat.state().held && p.S.root.getAttribute('parent-path') === null, 'not held, root in the world');
  // a falling cat: a press on the bar does not catch it
  p.poses['/user/hand/left'] = p.poses['/user/hand/right'] = null;
  p.S.cat.command('drop');
  await p.advance(100);
  assert(p.S.cat.state().falling, 'falling');
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', { CapsLock: true, NumLock: true });
  assert(!p.S.stats().drag, 'no drag of a falling cat');
});

test('fresh page with a stored hidden cat: built but not in the page, no timers, no sends', async () => {
  const p = page({ store: { x: 0.3, z: 0.2, yaw: 0, pose: 'sit', hidden: true } });
  const r = p.inject();
  assert(r === 'hidden', `result hidden (${r})`);
  assert(p.S.hidden && !p.S.root.isConnected, 'root out of the page');
  assert(p.activeTimers() === 0 && p.stats.total === 0, `no timers (${p.activeTimers()}), no sends (${p.stats.total})`);
  await p.advance(10000);
  assert(p.stats.total === 0 && p.activeTimers() === 0, 'still nothing after 10 s');
  assert(p.inject() === 'unchanged', 'next injection: unchanged');
  const s = p.S.api.show();
  assert(s.was === 'hidden' && !s.summoned, `shown at its spot (${JSON.stringify(s)})`);
  assert(near(p.S.cat.state().x, 0.3, 1e-9) && p.S.cat.state().pose === 'sit', 'stored spot and pose');
  await p.advance(2000);
  assert(p.stats.total > 0 && p.S.root.isConnected, 'sending once shown');
  assert(p.stored.hidden === false && p.stored.pose === 'sit', `store: hidden false, pose kept (${JSON.stringify(p.stored)})`);
});

test('store round-trip: core saves merge, hidden kept', async () => {
  const p = await running();
  p.S.api.hide();
  assert(p.stored.hidden === true, 'hidden stored');
  const saved = { ...p.stored };
  // A new page (SteamVR restart) seeded from that value.
  const q = page({ store: saved });
  assert(q.inject() === 'hidden', 'restart: still hidden');
  q.S.api.show();
  await q.advance(1000);
  q.S.cat.command('sit');
  await q.advance(4000);
  assert(q.stored.hidden === false && q.stored.pose === 'sit', `core save merged (${JSON.stringify(q.stored)})`);
  assert(q.S.api.status().hidden === false && q.S.api.status().pose === 'sit', 'status');
});

// The menu: its panel in the last message, its transform.
const menuSg = (p) => findSg(p.lastMsg().scene_graph, (n) => n.properties?.id === 'system.systemui::sfui-vr-pet-menu');
const menuXf = (p) => findSg(p.lastMsg().scene_graph, (n) => n.type === 'transform' && n.children?.[0]?.properties?.id === 'system.systemui::sfui-vr-pet-menu');
const checkOf = (p, id) => p.byAttr('data-model', id).children.find((c) => c.getAttribute('class') === 'sfui-vr-pet-check');

test('⋯ opens the menu above the bar (one send), again closes it (one send)', async () => {
  const p = await running();
  const more = p.byAttr('data-act', 'menu');
  let n = p.stats.total;
  p.click(more);
  assert(p.S.stats().menuOpen && p.stats.total - n === 1, `open, one send (${p.stats.total - n})`);
  const msg = p.lastMsg();
  const m = findSg(msg.scene_graph, (x) => x.properties?.id === 'system.systemui::sfui-vr-pet-menu');
  const t = findSg(msg.scene_graph, (x) => x.type === 'transform' && x.children?.[0] === m);
  assert(m && t && menuXf(p), 'menu panel in the send');
  const M = m.properties;
  assert(near(t.properties.translation[1], 0.11 * 30 / 132 + 0.01, 1e-9) && near(t.properties.translation[2], 0.02, 1e-9), `1 cm above the bar, 2 cm nearer (${t.properties.translation})`);
  assert(M.width === 0.13 && M.origin[1] === -1 && M['only-visible-with-laser'] === true && M.interactive === true && M['is-grab-handle'] === false, 'menu panel props');
  const facing = findSg(msg.scene_graph, (x) => x.type === 'head-facing-transform');
  assert(facing.children.includes(t), 'under the head-facing transform (carried with the drag)');
  const rows = catalog.order.map((id) => p.byAttr('data-model', id));
  assert(rows.every(Boolean), 'a row per coat');
  const img = rows[0].children.find((c) => c.tagName === 'IMG');
  assert(img?.getAttribute('src').startsWith('data:image/png;base64,'), 'thumbnail');
  assert(checkOf(p, catalog.default).hasAttribute('data-on') && !checkOf(p, 'tuxedo').hasAttribute('data-on'), 'check on the current coat');
  assert(['summon', 'sit', 'lie', 'sleep'].every((c) => p.byAttr('data-cmd', c)), 'Summon, Sit, Lie, Sleep');
  // a line between the coats and the animals, one before the commands
  const kids = p.byId('sfui-vr-pet-menu-content').children, cls = (e) => e.getAttribute('class');
  const seps = kids.map((e, i) => (cls(e) === 'sfui-vr-pet-sep' ? i : -1)).filter((i) => i >= 0);
  const groups = catalog.order.map((id) => catalog.models[id].group);
  assert(seps.length === new Set(groups).size, `a separator per group (${seps.length}, groups ${[...new Set(groups)]})`);
  for (const i of seps.slice(0, -1)) {
    const before = kids[i - 1].getAttribute('data-model'), after = kids[i + 1].getAttribute('data-model');
    assert(catalog.models[before].group !== catalog.models[after].group, `between groups (${before} | ${after})`);
  }
  n = p.stats.total;
  p.click(more);
  assert(!p.S.stats().menuOpen && p.stats.total - n === 1 && !menuSg(p), 'closed, one send, gone from the scene graph');
  const content = p.byId('sfui-vr-pet-menu-content');
  assert(content.isConnected && content.style.visibility === 'hidden', 'closed: still in the page (its transform too), hidden');
  assert(p.byId('sfui-vr-pet-menu').parent.parent?.tagName === 'VSG-HEAD-FACING-TRANSFORM', 'its transform under the head-facing one');
});

test("the menu's UV slot is valid when it opens, without a layout at open", async () => {
  const p = page();
  assert(/^patched/.test(p.inject()), 'injected');
  const menu = p.byId('sfui-vr-pet-menu-content'), fp = p.fpOf('sfui-vr-pet-menu');
  assert(fp && p.slotValid(fp), `valid from the first layout (${JSON.stringify(fp?.m_Rect)})`);
  await p.advance(3000);
  assert(!p.S.stats().menuOpen && menu.isConnected && menu.style.visibility === 'hidden', 'closed: connected, hidden');
  const r = menu.getBoundingClientRect();
  assert(r.width === 240 && r.height > 0, `a non-zero rect (${r.width} x ${r.height})`);
  p.layout();
  assert(p.slotValid(fp) && fp.m_Rect.width === r.width && fp.m_Rect.height === r.height, 'valid after a layout while closed');
  const more = p.byAttr('data-act', 'menu');
  let n = p.stats.total, f = p.stats.force;
  p.click(more);
  assert(p.S.stats().menuOpen && p.stats.total - n === 1 && p.stats.force === f, `open: one send, no forced layout (${p.stats.total - n}, force ${p.stats.force - f})`);
  assert(menu.style.visibility === '' && p.slotValid(fp), 'visible, slot valid');
  const M = menuSg(p).properties;
  assert(M['embedded-uv-index'] === fp.idx && near(M.uv_max[0] - M.uv_min[0], 240 / 1280, 1e-9), 'its panel: the slot, its rect');
  n = p.stats.total;
  p.click(more);
  assert(!p.S.stats().menuOpen && p.stats.total - n === 1 && p.stats.force === f && !menuSg(p), 'close: one send, out of the scene graph');
  assert(menu.isConnected && menu.style.visibility === 'hidden', 'close: hidden, still connected');
  p.layout();
  assert(p.slotValid(fp), 'still valid while closed');
  p.click(more);
  assert(p.S.stats().menuOpen && menuSg(p) && p.slotValid(fp) && p.stats.force === f, 'reopened: in the send, valid');
});

// The page rects (left, top, right, bottom) of our textures: the bar with the controls, the menu.
const rectOf = (p, id) => { const r = p.byId(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const ownRects = (p) => {
  const b = rectOf(p, 'sfui-vr-pet-handle-content'), c = rectOf(p, 'sfui-vr-pet-controls-content');
  return { bar: { left: Math.min(b.left, c.left), top: b.top, right: Math.max(b.right, c.right), bottom: c.bottom }, menu: rectOf(p, 'sfui-vr-pet-menu-content') };
};

test('page regions: clear of foreign panels, the keyboard strip band, each other; inside the page', async () => {
  const foreign = [];
  const p = page({ setup(G, doc) {
    const fp = (name, rect, extra = {}) => {
      const el = doc.createElement('div');
      const f = { props: { debug_name: name }, isExternal: false, m_Rect: rect, getSGID: () => name, getEmbeddedIndex: () => 900, getCurrentRootElement: () => el, ...extra };
      G.SGApp.m_mapPanels.set(name, f);
      return f;
    };
    // where the bar would go (bottom right, above the band), measured by m_Rect only (its root 0 x 0)
    foreign.push(fp('foreign-bar-spot', { x: 1080, y: 1150, width: 200, height: 160 }).m_Rect);
    // a panel with a root element rect, where the menu would go next
    const el = doc.createElement('div');
    Object.assign(el.style, { position: 'fixed', left: '700px', top: '640px', width: '300px', height: '500px' });
    doc.body.appendChild(el);
    fp('foreign-menu-spot', { x: 0, y: 0, width: 0, height: 0 }, { getCurrentRootElement: () => el });
    foreign.push({ x: 700, y: 640, width: 300, height: 500 });
    // ignored: an external panel and another overlay's popup covering the page
    fp('external', { x: 0, y: 0, width: 1280, height: 1440 }, { isExternal: true });
    fp('popup', { x: 0, y: 0, width: 1280, height: 1440 }, { props: { debug_name: 'popup', overlay_key: 'valve.steam.gamepadui.bar' } });
    // a panel node in the keyboard strip band
    const strip = doc.createElement('vsg-node');
    strip.setAttribute('vsg-type', 'panel');
    const sc = doc.createElement('div');
    Object.assign(sc.style, { position: 'fixed', left: '2px', top: '1326px', width: '1274px', height: '110px' });
    strip.getBoundingClientRect = () => sc.getBoundingClientRect();
    strip.appendChild(sc);
    doc.body.appendChild(strip);
    foreign.push({ x: 2, y: 1326, width: 1274, height: 110 });
  } });
  assert(/^patched/.test(p.inject()), 'injected');
  await p.advance(1000);
  const { bar, menu } = ownRects(p);
  const band = { left: 0, top: 1440 - 120, right: 1280, bottom: 1440 };
  const others = [...foreign.map((r) => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height })), band, { left: 0, top: 0, right: 1280, bottom: 600 }];
  for (const [name, r] of Object.entries({ bar, menu })) {
    assert(r.right > r.left && r.left >= 0 && r.top >= 1 && r.right <= 1280 && r.bottom <= 1440, `${name} inside the page (${JSON.stringify(r)})`);
    for (const o of others) assert(!overlaps(r, o), `${name} ${JSON.stringify(r)} clear of ${JSON.stringify(o)}`);
  }
  assert(!overlaps(bar, menu), `bar and menu apart (${JSON.stringify(bar)} ${JSON.stringify(menu)})`);
  assert(p.slotValid(p.fpOf('sfui-vr-pet-menu')) && p.slotValid(p.fpOf('sfui-vr-pet-handle')), 'slots valid');
});

test('page regions: claimed from a shared allocator when there is one; moved by it; released on dispose', async () => {
  const claims = new Map(), released = [];
  const p = page({ setup(G) {
    G.__sfuiRegions = {
      claim(owner, w, h, o) { const r = { x: owner === 'vr-pet:bar' ? 40 : 300, y: 700, w, h }; claims.set(owner, { r, o }); return r; },
      release(owner) { released.push(owner); },
    };
  } });
  assert(/^patched/.test(p.inject()), 'injected');
  await p.advance(500);
  assert(claims.has('vr-pet:bar') && claims.has('vr-pet:menu'), `claimed (${[...claims.keys()]})`);
  const b = claims.get('vr-pet:bar').r;
  assert(near(rectOf(p, 'sfui-vr-pet-handle-content').top, 700, 1e-9) && near(rectOf(p, 'sfui-vr-pet-controls-content').bottom, 700 + b.h, 1e-9), 'the bar and controls in the bar claim');
  assert(near(rectOf(p, 'sfui-vr-pet-menu-content').left, 300, 1e-9), 'the menu in its claim');
  claims.get('vr-pet:menu').o.onMove({ x: 500, y: 100, w: 240, h: 10 });
  assert(near(rectOf(p, 'sfui-vr-pet-menu-content').left, 500, 1e-9) && near(rectOf(p, 'sfui-vr-pet-menu-content').top, 100, 1e-9), 'moved by onMove');
  assert(p.fpOf('sfui-vr-pet-menu').m_Rect.x === 500, 'laid out again after the move');
  p.S.dispose();
  assert(released.includes('vr-pet:bar') && released.includes('vr-pet:menu'), `released (${released})`);
});

test('menu picks: a coat (setModel, check moves), a command; each closes the menu', async () => {
  const p = await running();
  const more = p.byAttr('data-act', 'menu');
  p.click(more);
  p.click(p.byAttr('data-model', 'cream'));
  assert(!p.S.stats().menuOpen && p.S.api.status().model === 'cream' && p.stored.model === 'cream', 'coat picked, closed');
  assert(checkOf(p, 'cream').hasAttribute('data-on') && !checkOf(p, catalog.default).hasAttribute('data-on'), 'check moved');
  await p.advance(500);
  p.click(more);
  p.click(p.byAttr('data-cmd', 'sit'));
  assert(!p.S.stats().menuOpen, 'closed after the command');
  await p.advance(4000);
  assert(p.S.cat.state().pose === 'sit', `sits (${p.S.cat.state().pose})`);
  // a row pressed but released on another does nothing
  p.click(more);
  const R = { CapsLock: true, NumLock: true };
  p.byAttr('data-cmd', 'lie').dispatch('mousedown', R);
  p.byAttr('data-cmd', 'sleep').dispatch('mouseup', R);
  assert(p.S.stats().menuOpen && p.S.cat.state().goal === 'sit', 'press on one row, release on another: nothing');
});

test('menu closes: a press elsewhere on the page, 1 s after the laser left, on hide; ⋯ inert while dragged', async () => {
  const p = await running();
  const more = p.byAttr('data-act', 'menu'), menu = p.byId('sfui-vr-pet-menu-content'), ctl = p.byId('sfui-vr-pet-controls-content');
  const R = { CapsLock: true, NumLock: true };
  p.click(more);
  p.dash.dispatch('mousedown', R);
  assert(!p.S.stats().menuOpen, 'a press on a dashboard panel closes it');
  p.click(more);
  p.byAttr('data-model', 'blue').dispatch('mousedown', R);
  assert(p.S.stats().menuOpen, 'a press inside does not');
  p.byAttr('data-model', 'blue').dispatch('mouseleave', R);   // (disarmed)
  menu.dispatch('mouseleave', R);
  await p.advance(900);
  assert(p.S.stats().menuOpen, 'still open 0.9 s after the laser left');
  ctl.dispatch('mouseenter', R);
  await p.advance(500);
  assert(p.S.stats().menuOpen, 'back on the controls: stays');
  ctl.dispatch('mouseleave', R);
  await p.advance(1100);
  assert(!p.S.stats().menuOpen, 'closed 1 s after the laser left');
  p.click(more);
  const n = p.stats.total;
  p.S.api.hide();
  assert(!p.S.stats().menuOpen && p.stats.total - n === 1, `hide: closed, one send (${p.stats.total - n})`);
  p.S.api.show();
  await p.advance(1000);
  assert(!p.S.stats().menuOpen && !menuSg(p), 'shown again: closed');
  p.poses['/user/hand/right'] = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] };
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', R);
  await p.advance(200);
  p.click(more, 'left');
  assert(!p.S.stats().menuOpen, '⋯ during a drag: nothing');
});

// The rendermodel sources in the last message (mounted frames).
const sources = (p) => {
  const out = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.type === 'rendermodel') out.push(n.properties.source); walk(n.children); };
  walk(p.lastMsg()?.scene_graph);
  return out;
};
const dirOf = (id) => catalog.models[id].dir;

test('models: the catalog, default coat mounted; api v2', async () => {
  const p = await running();
  assert(p.S.api.version === 2 && typeof p.S.api.models === 'function' && typeof p.S.api.setModel === 'function', 'api v2 { models, setModel }');
  const l = p.S.api.models();
  assert(l.current === catalog.default && l.models.length === catalog.order.length && l.models[0].id === catalog.order[0], JSON.stringify(l));
  const src = sources(p);
  assert(src.length > 0 && src.every((x) => x.startsWith(`${dirOf(catalog.default)}/`)), `default coat's frames (${src[0]})`);
  assert(p.S.api.status().model === catalog.default, 'status.model');
});

test('setModel: one send without frames, then gradual remount from the new dir; stored; the core goes on', async () => {
  const p = await running();
  const before = p.stats.total, st0 = p.S.cat.state();
  const r = p.S.api.setModel({ id: 'tuxedo' });
  assert(r.model === 'tuxedo' && r.was === catalog.default && !r.error, JSON.stringify(r));
  assert(p.stats.total - before === 1 && sources(p).length === 0, `one send without frames (${p.stats.total - before}, ${sources(p).length})`);
  assert(p.stored.model === 'tuxedo', `stored (${JSON.stringify(p.stored)})`);
  await p.advance(1000 / 24 + 1);
  const n1 = p.S.stats().frames;
  assert(n1 > 0 && n1 <= 3, `at most 3 mounts per tick (${n1})`);
  await p.advance(3000);
  const src = sources(p);
  assert(src.length > 3 && src.every((x) => x.startsWith(`${dirOf('tuxedo')}/`)), `tuxedo's frames (${src.length}, ${src.find((x) => !x.startsWith(dirOf('tuxedo')))})`);
  const st = p.S.cat.state();
  assert(Math.hypot(st.x - st0.x, st.z - st0.z) < 1.5 && p.S.api.status().model === 'tuxedo', 'same cat (spot), model in status');
  // the slow path (the dashboard's DOM walk) builds the same source
  const node = [...p.S.root.walk()].find((n) => n.buildNode?.({})?.[1]?.type === 'rendermodel');
  assert(node.buildNode({})[1].properties.source.startsWith(`${dirOf('tuxedo')}/`), 'DOM node source');
  const again = p.S.api.setModel({ id: 'tuxedo' });
  assert(again.was === 'tuxedo', 'same model: no-op');
});

test('setModel: unknown -> error, unchanged; hidden -> only stored, shown with it', async () => {
  const p = await running();
  const n = p.stats.total;
  const bad = p.S.api.setModel({ id: 'lion' });
  assert(bad.error && bad.model === catalog.default && p.stats.total === n, `unknown: error, no send (${JSON.stringify(bad)})`);
  p.S.api.hide();
  const sent = p.stats.total;
  const r = p.S.api.setModel({ id: 'snow' });
  assert(r.model === 'snow' && r.hidden && p.stats.total === sent && p.activeTimers() === 0, 'hidden: no send, no timers');
  assert(p.stored.model === 'snow' && p.stored.hidden === true, JSON.stringify(p.stored));
  p.S.api.show();
  await p.advance(3000);
  assert(sources(p).length > 0 && sources(p).every((x) => x.startsWith(`${dirOf('snow')}/`)), 'shown as snow');
});

test('stored model at injection; an unknown stored model falls back to the default (logged)', async () => {
  const p = page({ store: { model: 'blue' } });
  assert(/^patched \(blue,/.test(p.inject()), 'patched with blue');
  await p.advance(2000);
  assert(sources(p).every((x) => x.startsWith(`${dirOf('blue')}/`)) && sources(p).length > 0, 'blue frames');
  const q = page({ store: { model: 'dragon' } });
  assert(new RegExp(`^patched \\(${catalog.default},`).test(q.inject()), 'default');
  assert(q.S.log.some((l) => l.includes('unknown stored model')), 'logged');
});

// Another animal (a frame set of its own): the first one in the catalog.
const animal = catalog.order.find((id) => catalog.models[id].frames !== catalog.models[catalog.default].frames);
// The grip bar's lift above the frames' origin in the last message.
const liftSent = (p) => findSg(p.lastMsg().scene_graph, (n) => n.type === 'transform' && n.children?.[0]?.type === 'head-facing-transform')?.properties.translation[1];

test('setModel to another animal: its own frames and core at the same spot, one send, gradual remount, bar at its height', async () => {
  assert(animal, `an animal in the catalog (${catalog.order})`);
  const p = await running();
  p.S.cat.command('sit');
  await p.advance(4000);
  const st0 = p.S.cat.state(), core0 = p.S.cat, before = p.stats.total;
  assert(near(liftSent(p), 0.40, 1e-9), `cat: bar 0.40 m up (${liftSent(p)})`);
  const r = p.S.api.setModel({ id: animal });
  assert(r.model === animal && !r.error, JSON.stringify(r));
  assert(p.stats.total - before === 1 && sources(p).length === 0, `one send without frames (${p.stats.total - before})`);
  const bk = catalog.frameSets[catalog.models[animal].frames];
  assert(p.S.cat !== core0 && Object.keys(p.S.frames).sort().join() === Object.keys(bk.clips).sort().join(), 'its frames, a new core');
  const st = p.S.cat.state();
  assert(near(st.x, st0.x, 1e-3) && near(st.z, st0.z, 1e-3) && near(st.yaw, st0.yaw, 1e-3), 'same spot and heading');
  assert(st.pose === (bk.clips.sit ? 'sit' : 'stand'), `its pose if it has it (${st.pose})`);
  assert(p.stored.model === animal, 'stored');
  for (let i = 0; i < 20 && !p.S.stats().frames; i++) await p.advance(5);   // up to the first tick that mounts
  assert(p.S.stats().frames > 0 && p.S.stats().frames <= 3, `at most 3 mounts per tick (${p.S.stats().frames})`);
  await p.advance(4000);
  const src = sources(p);
  assert(src.length > 3 && src.every((x) => x.startsWith(`${dirOf(animal)}/`) && bk.clips[x.slice(dirOf(animal).length + 1).replace(/_\d+\.obj$/, '')]),
    `its frames (${src.length}, ${src.find((x) => !x.startsWith(dirOf(animal)))})`);
  assert(near(liftSent(p), bk.height + 0.10, 1e-9), `bar at its height + 0.10 m (${liftSent(p)})`);
  assert(p.S.api.status().model === animal, 'status.model');
  // the menu's commands drive the new core
  p.click(p.byAttr('data-act', 'menu'));
  p.click(p.byAttr('data-cmd', 'lie'));
  await p.advance(5000);
  assert(p.S.cat.state().pose === 'lie', `lies (${p.S.cat.state().pose})`);
  // and back to the cat
  const back = p.S.api.setModel({ id: catalog.default });
  await p.advance(4000);
  assert(back.model === catalog.default && sources(p).every((x) => x.startsWith(`${dirOf(catalog.default)}/`)) && sources(p).length > 3, 'back to the cat');
  assert(near(liftSent(p), 0.40, 1e-9), 'bar 0.40 m up again');
});

test('setModel to another animal during a laser drag: the drag is let go, it stands where it was lifted', async () => {
  const p = await running();
  const st0 = p.S.cat.state();
  p.poses['/user/hand/right'] = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] };
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', { CapsLock: true, NumLock: true });
  await p.advance(300);
  assert(p.S.stats().drag, 'dragging');
  p.S.api.setModel({ id: animal });
  const st = p.S.cat.state();
  assert(!p.S.stats().drag && !st.held && !st.falling && st.pose === 'stand', `let go, standing (${st.pose})`);
  assert(Math.hypot(st.x - st0.x, st.z - st0.z) < 0.2, 'where it was lifted');
  await p.advance(3000);
  assert(sources(p).length > 0, 'shown');
});

test('setModel to another animal while hidden: switched, no sends; shown as it; stored at injection', async () => {
  const p = await running();
  p.S.api.hide();
  const n = p.stats.total;
  const r = p.S.api.setModel({ id: animal });
  assert(r.hidden && p.stats.total === n && p.activeTimers() === 0, 'hidden: no send, no timers');
  p.S.api.show();
  await p.advance(3000);
  assert(sources(p).length > 0 && sources(p).every((x) => x.startsWith(`${dirOf(animal)}/`)), `shown as ${animal}`);
  const q = page({ store: { model: animal } });
  assert(new RegExp(`^patched \\(${animal},`).test(q.inject()), 'patched with it');
  await q.advance(3000);
  assert(sources(q).every((x) => x.startsWith(`${dirOf(animal)}/`)) && sources(q).length > 0, 'its frames');
});

test('re-injection of a new version: the old one disposed (no second listener, timer, hook, style or panel)', async () => {
  const p = await running();
  const base = { listeners: p.listeners(), timers: p.activeTimers(), styles: p.doc.head.children.length, slots: p.embedded.filter(Boolean).length };
  const old = p.S;
  old.sig = 'an older version';
  assert(/^patched/.test(p.inject()), 'injected again');
  await p.advance(2000);
  assert(p.S !== old && !old.root.isConnected, 'the old root gone');
  const now = { listeners: p.listeners(), timers: p.activeTimers(), styles: p.doc.head.children.length, slots: p.embedded.filter(Boolean).length };
  assert(JSON.stringify(now) === JSON.stringify(base), `the same as one injection (${JSON.stringify(now)} vs ${JSON.stringify(base)})`);
  assert(p.doc.body.children.filter((e) => e.id === 'sfui-vr-pet').length === 1, 'one root');
  const send = Object.getPrototypeOf(p.mailbox).SendMessage;
  assert(send.__orig && !send.__orig.__orig, 'SendMessage hooked once');
  assert(p.sock.send.__sfuiPetOrig && !p.sock.send.__sfuiPetOrig.__sfuiPetOrig, 'the socket wrapped once');
  assert(p.stats.fast > 0 && p.S.stats().captured, 'fast sends again');
});

test('unpatch.js during a drag: the pet, its listeners, timers, hook, socket wrapper, style and panels gone; one send without it', async () => {
  const p = await running();
  const R = { CapsLock: true, NumLock: true };
  p.poses['/user/hand/right'] = { p: [0.2, 1.2, 1.2], q: [1, 0, 0, 0] };
  p.byId('sfui-vr-pet-handle-content').dispatch('mousedown', R);
  p.click(p.byAttr('data-act', 'menu'), 'left');
  await p.advance(300);
  const root = p.S.root, n = p.stats.total;
  assert(p.unpatch() === 'unpatched' && !('__sfuiPet' in p.G), 'unpatched, global gone');
  assert(!root.isConnected && p.listeners() === 0 && p.activeTimers() === 0, `nothing left (${p.listeners()} listeners, ${p.activeTimers()} timers)`);
  assert(!Object.getPrototypeOf(p.mailbox).SendMessage.__orig && !p.sock.send.__sfuiPetOrig, 'hook and socket wrapper removed');
  assert(p.doc.head.children.length === 0 && p.embedded.every((e) => e === null), 'style and embedded panels removed');
  assert(!p.doc.all.some((e) => e.id?.startsWith('sfui-vr-pet') && e.isConnected), 'no element of ours in the page');
  assert(p.stats.total - n === 1 && !findSg(p.lastMsg().scene_graph, (x) => x.properties?.sgid === +root.getAttribute('sgid')), 'one send without the pet');
  await p.advance(5000);
  assert(p.stats.total - n === 1, 'no sends after');
});

(async () => {
  for (const [name, f] of tests) {
    try { await f(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack}`); }
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('all passed');
})();
