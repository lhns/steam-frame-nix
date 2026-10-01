// VR pet, SteamVR adapter: draws the core's pet (core.js) in SteamVR's
// systemui page (DevTools 127.0.0.1:8087). steam-ui-patches injects
//   ((opts, baked, find, hooks) => { <core.js> <this file> return vrPetSystemui(…); })(…)
// every 15 s (find, hooks: steam-frame-nix's finders.js, hooks.js); an
// unchanged pet returns "unchanged".
//
// Frames: systemui builds vrcompositor's scene graph from its DOM, and a
// "rendermodel" node draws an OBJ (absolute path). Render models are static,
// so every baked frame is its own OBJ under one world-locked root (standing
// space, y = 0 the floor). vrcompositor loads a model when its node appears
// (3-8 ms each, one after the other), drops it when it goes, reloads it when
// its source changes, and draws every mounted one (hidden ones at scale ~0
// too). So frames are mounted gradually and kept while they may be needed:
//   opts.mount "dynamic"  the clips the core prefetches, LOADS_PER_TICK frames
//                         per tick, most urgent clip first; a clip shows once
//                         mounted SETTLE_MS; unused clips stay KEEP_MS, fewer
//                         beyond CAP frames (actions first, then the least
//                         recently used);
//              "all"      every frame (gradually), all the time.
// Sends: every change resends the whole scene graph (~65 kB). The scene graph
// module's send walks the DOM (~16 ms), the public forceLayoutUpdate also
// re-measures and repaints the page (at 12 Hz it lagged the dashboard), so
// the pet resends the dashboard's last message itself with only its subtree
// replaced (fastSend); the DOM is kept in sync for the dashboard's own sends.
// At most one send per tick, only on a change, deferred while the head turns
// fast (TURN_*) or the pet is out of view (VIEW_DEFER_MS; mounts still go
// out); a drag's start and end at once. Input is read-only: the head and hand
// poses once per tick, the laser's mouse events on the pet's own panels; no
// buttons, nothing synthesized.
//
// Laser drag: a grip bar panel above the pet (only-visible-with-laser, a grab
// handle like a window's). Pressing it parents the root to that hand
// (parent-path; the hand is in the event's CapsLock / NumLock state, as in
// SteamVR's GrabHandle) at the grab point's pose in the controller's frame,
// so vrcompositor carries it rigidly every display frame, like SteamVR's
// floating windows (the dashboard's grab-transform would re-aim it at the
// head instead). A grab-scale under the root (its event panel the bar) is the
// thumbstick push; on release its distance is asked (SGQueryService) and the
// pet falls from there. The body (frames and bar) is set once per tick:
// upright below the grab point, turned with the controller's heading.
// Controls: ⋯ and X below the bar, the ⋯ menu above it (the models, then
// Summon / Sit / Lie down / Sleep); sizes in VrPetCore.ui. Their textures are
// regions of this page (window.__sfuiRegions, a shared allocator, if there
// is one; else free spots clear of the other panels and the keyboard strip's
// band). Buttons act only on a press and a release both on them (a stray
// release does nothing), never during a drag or AFTER_DRAG_MS after. The
// menu's panel is in the scene graph only while open, but its DOM is laid out
// all along, so its embedded-UV slot is valid when it opens (no layout then).
//
// window.__sfuiPet (S):
//   api { version, show, hide, status, models, setModel }   for cli.mjs
//   cat   the core: cat.command('sit' | 'summon' | …), cat.state() (DevTools)
//   debug: stats(), log, drag('left' | 'right' | null), where(id) (a node's
//   pose in vrcompositor), dragTrace (4 Hz while dragged), pause(), resume()
// Hidden: no timers, no sends; `hidden` and `model` are kept in the patch's
// store next to the core's spot and pose, so a fresh page builds a hidden pet
// without putting it in the page.
function vrPetSystemui(opts, catalog, find, hooks) {
  const VERSION = 16;
  const G = window;
  const KEY = 'vr-pet';
  const old = G.__sfuiPet;
  const sig = JSON.stringify([VERSION, opts, catalog]);
  // (a hidden cat's root is out of the page on purpose: unchanged too)
  if (old?.sig === sig && (old.hidden || old.root?.isConnected)) return 'unchanged';
  if (typeof G.VRHTML?.NextSGID !== 'function' || typeof G.VRHTML?.GetPose !== 'function' || typeof G.forceLayoutUpdate !== 'function')
    return 'SteamVR internals changed, no cat: missing VRHTML.NextSGID / VRHTML.GetPose / forceLayoutUpdate';
  const M = VrPetCore.math, UI = VrPetCore.ui;
  try { old?.dispose?.(); } catch { /* gone */ }

  // Scene graph updates. Fast path: resend the dashboard's last scene graph
  // message (captured, with the other patches' rewrites already applied) with
  // only the cat's subtree replaced, straight to the mailbox's websocket; no
  // DOM walk. Slow path (until a message is captured, and whenever the cat's
  // root is not in it): the dashboard's own send function. Last resort:
  // forceLayoutUpdate.
  const PREFIX = 'mailbox_send vrcompositor_systemlayer ';
  const HEAD = PREFIX + '{"type":"update_scene_graph"';
  let slowSend = null, sender = 'forceLayoutUpdate (fallback)', proto = null;
  try {
    const req = find.getWebpackRequire('webpackChunkvrwebui');
    const mod = find.findModule(req, { includes: ['update_scene_graph', 'sg_mailbox'] }, 'scene graph module');
    slowSend = find.findExport(mod.exports, { type: 'function', includes: ['update_scene_graph'] }, 'scene graph send').value;
    sender = 'scene graph send';
    const mb = find.findModule(req, { includes: ['"mailbox_send "', 'WebSocketSend(', '"vrcompositor_systemlayer"'] }, 'mailbox module');
    proto = find.findExport(mb.exports, { type: 'class', protoMethods: ['SendMessage', 'SendMessageAndWaitForResponse', 'RegisterHandler'] }, 'Mailbox').value.prototype;
  } catch (e) { sender += `: ${e.message}`; }
  // The scene graph mailbox's websocket (its WebSocketSend is a read-only
  // bound method, so the socket's send is wrapped; re-wrapped on reconnect).
  const cap = { sock: null, send: null, str: null, parsed: null, node: null, pre: '', post: '', seen: 0 };
  const capture = (mailbox) => {
    const sock = mailbox?.m_wsWebSocketToServer;
    if (!sock || cap.sock === sock || typeof sock.send !== 'function') return;
    const orig = sock.send.__sfuiPetOrig ?? sock.send;
    const wrapper = function (str) {
      if (typeof str === 'string' && str.startsWith(HEAD)) G.__sfuiPet?.onSceneGraph?.(str);
      return orig.apply(this, arguments);
    };
    wrapper.__sfuiPetOrig = orig;
    sock.send = wrapper;
    Object.assign(cap, { sock, send: (str) => sock.readyState === 1 && (orig.call(sock, str), true) });
  };
  if (proto && hooks) {
    hooks.before(proto, 'SendMessage', 'vr-pet', function (args) {
      cap.seen++;
      if (args[1]?.type === 'update_scene_graph' && cap.sock !== this.m_wsWebSocketToServer) capture(this);
    });
  }
  let sends = 0, fast = 0;
  let fastSend = () => false;   // set below, once the cat's nodes exist
  const update = () => {
    sends++;
    if (fastSend()) { fast++; return; }
    slowSend ? slowSend() : G.forceLayoutUpdate();
  };

  const HIDDEN = '0.0001 0.0001 0.0001', SHOWN = '1 1 1';
  const S = G.__sfuiPet = { version: VERSION, sig, log: [], hidden: false };
  const log = (...a) => { S.log.push([Math.round(performance.now()), ...a]); if (S.log.length > 80) S.log.shift(); };
  const setAttrs = (e, o) => { for (const [k, v] of Object.entries(o)) e.setAttribute(k, String(v)); };
  // The persistent value (steam-ui-patches' store): the core's spot and pose
  // plus `hidden`; every write merges (the core's save() writes its own keys only).
  const stored = () => { try { const v = G.__sfuiStore?.get?.(KEY); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const store = (patch) => { try { G.__sfuiStore?.set?.(KEY, { ...stored(), ...patch }); } catch { /* no store */ } };
  const startHidden = stored().hidden === true;
  // ---- the model (catalog: index.py's models.json; its frame set is the core's baked data) ----
  const models = catalog.models;
  let modelId = models[stored().model] ? stored().model : catalog.default;
  const unknownModel = stored().model != null && !models[stored().model] ? stored().model : null;
  let baked = catalog.frameSets[models[modelId].frames];

  // ---- scene graph: root (position + yaw) > one transform per frame > rendermodel ----
  const root = document.createElement('vsg-transform');
  root.id = 'sfui-vr-pet';
  setAttrs(root, { translation: '0 0 0', rotation: '1 0 0 0', scale: '1 1 1', sgid: G.VRHTML.NextSGID() });
  // ---- laser drag: root (carried: parent-path the hand) > push (grab-scale) > turn > frames, and > barBody > the handle ----
  let overlayKey = 'system.systemui';
  try { overlayKey = G.VRHTML.VROverlay.ThisOverlayKey() || overlayKey; } catch { /* default */ }
  // The thumbstick push / pull while dragged: a grab-scale, as SteamVR's
  // floating windows (min / max distance from the hand, scroll speed).
  const PUSH = { 'min-distance': 0.25, 'max-distance': 5, 'scroll-speed': 10 };
  const PUSHED_ID = 'sfui-vr-pet-pushed';
  const xform = (id) => {
    const t = document.createElement('vsg-transform');
    setAttrs(t, { translation: '0 0 0', rotation: '1 0 0 0', scale: '1 1 1', sgid: G.VRHTML.NextSGID() });
    t.sg = { type: 'transform', properties: { sgid: +t.getAttribute('sgid'), translation: [0, 0, 0], rotation: [1, 0, 0, 0], scale: [1, 1, 1] }, children: [] };
    if (id) { t.id = id; t.sg.properties.id = `${overlayKey}::${id}`; }
    return t;
  };
  // (no DOM tag of its own: a node built by buildNode, its children walked)
  const push = document.createElement('vsg-node');
  const pushSgid = G.VRHTML.NextSGID();
  let pushGen = 0;
  push.setAttribute('sgid', String(pushSgid));
  push.sg = { type: 'grab-scale', properties: { sgid: pushSgid, 'is-active': false, 'reset-generation': 0, ...PUSH }, children: [] };
  push.buildNode = (ctx) => [ctx, { type: 'grab-scale', properties: { ...push.sg.properties } }];
  root.appendChild(push);
  // `pushed`: where the push has the carried frame (asked on release);
  // `turn` (the frames) and `barBody` (the handle): the cat's upright body,
  // identity unless dragged (then below the grab point, see dragBody()).
  const pushed = xform(PUSHED_ID), turn = xform(), barBody = xform();
  push.appendChild(pushed);
  push.appendChild(turn);
  push.appendChild(barBody);
  let bodyQ = [1, 0, 0, 0], bodyP = [0, 0, 0];
  const setBody = (q, p) => {   // -> changed
    const home = q[0] === 1 && p.every((v) => v === 0);
    if (!(home && (bodyQ[0] !== 1 || bodyP.some((v) => v !== 0)))
      && M.qdiffDeg(q, bodyQ) < 0.2 && Math.hypot(...p.map((v, k) => v - bodyP[k])) < 5e-4) return false;
    bodyQ = q; bodyP = p;
    for (const t of [turn, barBody]) {
      t.setAttribute('rotation', fmt(q, 5)); t.setAttribute('translation', fmt(p, 5));
      t.sg.properties.rotation = q; t.sg.properties.translation = p;
    }
    return true;
  };
  const setShown = (xf, on) => { xf.setAttribute('scale', on ? SHOWN : HIDDEN); xf.sg.properties.scale = on ? [1, 1, 1] : [1e-4, 1e-4, 1e-4]; };
  let frames = {};   // clip -> [transform]
  // One transform + rendermodel per baked frame of the model's frame set.
  const buildFrames = (dir) => {
    frames = {};
    for (const [name, c] of Object.entries(baked.clips)) {
      frames[name] = [];
      for (let i = 0; i < c.frames; i++) {
        const xf = document.createElement('vsg-transform');
        setAttrs(xf, { translation: '0 0 0', rotation: '1 0 0 0', scale: HIDDEN, sgid: G.VRHTML.NextSGID() });
        const node = document.createElement('vsg-node');
        const sgid = G.VRHTML.NextSGID();
        node.setAttribute('sgid', String(sgid));
        const rm = { type: 'rendermodel', properties: { sgid, source: `${dir}/${name}_${i}.obj`, culling: 0 } };
        node.buildNode = (ctx) => [ctx, { type: rm.type, properties: { ...rm.properties } }];
        xf.appendChild(node);
        // The same node as the dashboard's DOM walk builds it, for the fast path.
        xf.sg = { type: 'transform', properties: { sgid: +xf.getAttribute('sgid'), translation: [0, 0, 0], rotation: [1, 0, 0, 0], scale: [1e-4, 1e-4, 1e-4], 'parent-id': null },
          children: [rm] };
        xf.rm = rm; xf.file = `${name}_${i}.obj`;   // (its source: the model's directory + file)
        frames[name].push(xf);
      }
    }
  };
  buildFrames(models[modelId].dir);
  // ---- mounted frames (see the header) ----
  const LOADS_PER_TICK = 3, SETTLE_MS = 150, KEEP_MS = 60000;
  const all = opts.mount === 'all';
  const CAP = all ? Infinity : 170;
  // one-shot actions (the cat's, an animal's own): evicted before the poses' clips
  const rareOf = () => new Set([...Object.keys(VrPetCore.ACTIONS), ...Object.keys(baked.species?.actions ?? {})]);
  let RARE = rareOf();
  const mounted = new Map();   // clip -> { n: frames mounted (in order), last: time of the last mount, used }
  let want = new Set(), nMounted = 0, loads = 0, evictions = 0;
  function pump(now) {   // mount the wanted clips' next frames, most urgent clip first
    let budget = LOADS_PER_TICK, changed = false;
    for (const name of want) {
      let m = mounted.get(name);
      if (!m) mounted.set(name, m = { n: 0, last: now, used: now });
      m.used = now;
      const fr = frames[name];
      while (budget > 0 && m.n < fr.length) { turn.appendChild(fr[m.n++]); m.last = now; budget--; nMounted++; loads++; changed = true; }
    }
    return changed;
  }
  function evict(now) {   // unused clips after KEEP_MS; beyond CAP actions first, then the least recently used
    const idle = [...mounted].filter(([name]) => !want.has(name) && !frames[name].includes(shown))
      .sort((a, b) => RARE.has(b[0]) - RARE.has(a[0]) || a[1].used - b[1].used);
    let changed = false;
    for (const [name, m] of idle) {
      if (now - m.used < KEEP_MS && nMounted <= CAP) continue;
      for (let i = 0; i < m.n; i++) frames[name][i].remove();
      nMounted -= m.n; evictions++;
      mounted.delete(name);
      changed = true;
    }
    return changed;
  }

  const rootSgid = +root.getAttribute('sgid');
  S.onSceneGraph = (str) => { cap.str = str; };
  // A captured message is parsed once into the text before and after the
  // pet's node (cap.pre / cap.post); a send serializes only the pet's node.
  const HOLE = '"__sfuiPetNode__"';
  fastSend = () => {
    if (!cap.send || !cap.str || !root.isConnected) return false;
    if (cap.parsed !== cap.str) {
      cap.parsed = cap.str;
      cap.node = null;
      const msg = JSON.parse(cap.str.slice(PREFIX.length));
      msg.retired_sgids = [];
      if (msg.scene_graph?.properties && 'eDashboardRelatch' in msg.scene_graph.properties)
        msg.scene_graph.properties.eDashboardRelatch = 0;   // None: never repeat a relatch request
      const walk = (n, parent, k) => {
        if (cap.node || !n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((c, i) => walk(c, n, i)); return; }
        if (n.properties?.sgid === rootSgid) { cap.node = n; parent[k] = JSON.parse(HOLE); return; }
        if (n.children) walk(n.children);
      };
      walk(msg.scene_graph);
      if (cap.node) [cap.pre, cap.post] = JSON.stringify(msg).split(HOLE);
    }
    if (!cap.node) return false;
    const p = cap.node.properties;
    p.translation = lastT.split(' ').map(Number);
    p.rotation = lastR.split(' ').map(Number);
    const pp = root.getAttribute('parent-path');
    if (pp) p['parent-path'] = pp; else delete p['parent-path'];
    turn.sg.children = [...turn.children].map((xf) => xf.sg).filter(Boolean);
    barBody.sg.children = handle ? [handle.sg()] : [];
    push.sg.children = [pushed.sg, turn.sg, barBody.sg];
    cap.node.children = [push.sg];
    return cap.send(PREFIX + cap.pre + JSON.stringify(cap.node) + cap.post);
  };

  // ---- the grip bar, the controls and the menu (sizes: VrPetCore.ui) ----
  const { HANDLE, CONTROLS, MENU } = UI;
  const liftOf = () => UI.liftOf(baked.height);
  // drag: { hand, phase: 'drag' | 'ending' (let go) | 'asking' (how far
  // pushed?) | 'done', w0: the pet's pose at the grab, rel: the grab point in
  // the controller's frame, push, want: the body's orientation } while the
  // laser drags the pet
  let drag = null;
  // A button's press (X, ⋯, the menu's rows): armed by a press on it (not
  // while dragged or just after), carried to the release by the window's
  // capture listener, which runs before the button's own mouseup: it acts
  // only if the release is on the button that was pressed.
  let armed = null, upArmed = null, dragEndAt = -Infinity;
  const dragBusy = () => !!drag || performance.now() - dragEndAt < UI.AFTER_DRAG_MS;
  const handSide = (e) => ({ 2: 'left', 3: 'right' })[(e.getModifierState?.('CapsLock') ? 1 : 0) | (e.getModifierState?.('NumLock') ? 2 : 0)];
  // SteamVR's scene graph query service (looked up once).
  let sgq = null;
  const sgQuery = () => {
    if (sgq) return sgq;
    if (G.SGQueryService?.requestSGTransform) return (sgq = G.SGQueryService);
    try {
      const req = find.getWebpackRequire('webpackChunkvrwebui');
      const mod = find.findModule(req, { includes: ['requestSGTransform', '"sgqueryservice"'] }, 'scene graph query module');
      return (sgq = find.findExport(mod.exports, { type: 'class', protoMethods: ['requestSGTransform'] }, 'SGQueryService').value.getInstance());
    } catch (e) { log('no SGQueryService', String(e)); return null; }
  };
  // A promise, rejected after ms (its timer cleared once it settles).
  const within = (promise, ms) => {
    let timer;
    return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), ms); })])
      .finally(() => clearTimeout(timer));
  };
  // Where vrcompositor has a node of ours: its world pose (standing space).
  const where = (id, timeoutMs = 600) => {
    const q = sgQuery();
    if (!q) return Promise.reject(new Error('no SGQueryService'));
    return within(q.requestSGTransform(`${overlayKey}::${id}`, 0).then(toPose), timeoutMs);
  };
  // How far the thumbstick pushed the carried frame (m, along its -Z): the
  // pushed origin in the root's frame, as SteamVR's floating windows ask it.
  const pushOf = (timeoutMs = 250) => {
    const q = sgQuery();
    if (typeof q?.requestSGTransformRelative !== 'function') return Promise.reject(new Error('no SGQueryService'));
    return within(q.requestSGTransformRelative(`${overlayKey}::${root.id}`, `${overlayKey}::${PUSHED_ID}`, 0).then((t) => {
      const z = -t?.translation?.z;
      if (!Number.isFinite(z)) throw new Error('no push');
      S.pushSeen = { z: +z.toFixed(4), scale: t.scale ? [t.scale.x, t.scale.y, t.scale.z].map((v) => +(+v).toFixed(4)) : null };
      return z;
    }), timeoutMs);
  };
  const startDrag = (side) => {
    if (!side || drag || !handle || S.hidden || S.cat?.state().falling) return;   // (a falling cat is not caught)
    drag = { hand: side, phase: 'drag', w0: null, rel: null, push: 0, want: null, psi0: null };
    disarm(); barActive(true);
    log('drag', side);
  };
  const endDrag = () => {
    barActive(false);
    if (drag?.phase !== 'drag') return;
    drag.phase = 'ending'; dragEndAt = performance.now(); log('drag end');
  };
  // The bar's dragging look ([data-active], as the stock GrabHandle's ForceActive): from the press to the release.
  const barActive = (on) => { const el = handle?.barContent; if (on) el?.setAttribute('data-active', ''); else el?.removeAttribute('data-active'); };
  const disarm = () => { armed?.removeAttribute('data-armed'); armed = null; };
  // A button (X, ⋯, a menu row): press and release on it -> act() (not while dragged or just after).
  const button = (el, act) => {
    el.addEventListener('mousedown', () => { disarm(); if (!dragBusy()) { armed = el; el.setAttribute('data-armed', ''); } });
    el.addEventListener('mouseup', () => { const ok = upArmed === el; upArmed = null; if (ok && !dragBusy()) act(); });
    el.addEventListener('mouseleave', () => { if (armed === el) disarm(); });
  };
  const div = (parent, css, text) => {
    const e = document.createElement('div');
    if (css) e.setAttribute('class', css);
    if (text != null) e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  const inside = (t, el) => { for (let n = t; n; n = n.parentNode) if (n === el) return true; return false; };
  function makeHandle() {
    const app = G.SGApp;
    if (typeof app?.addEmbeddedPanelUVs !== 'function') { log('no drag handle: SGApp.addEmbeddedPanelUVs missing'); return null; }
    // Page regions for the textures: the bar with the controls centred below
    // it (vr-pet:bar), the menu (vr-pet:menu). Claimed from the shared page
    // region allocator when there is one (window.__sfuiRegions);
    // else free spots of the page (from the bottom right, 4 px apart) clear of
    // the page's other panels (SGApp.m_mapPanels' non-external ones and every
    // [vsg-type=panel]), the keyboard suggestions strip's band (the bottom
    // 120 px, up to 1706 px across; it is only in the page while shown) and
    // row 0 (the embedded-data scanline).
    const R = G.__sfuiRegions ?? null;
    const claimed = [];
    const GAP = 4, STRIP = { w: 1706, h: 120 };
    const rs = [];
    const occupy = (x, y, w, h) => { if (w > 0 && h > 0) rs.push({ left: x, top: y, right: x + w, bottom: y + h }); };
    const ours = (name) => String(name ?? '').startsWith('sfui-vr-pet');
    const mp = app.m_mapPanels;
    for (const fp of (mp?.values ? [...mp.values()] : Object.values(mp ?? {}))) {
      if (!fp || fp.isExternal || fp.props?.overlay_key || ours(fp.props?.debug_name)) continue;
      let r = null;
      try { r = fp.getCurrentRootElement?.()?.getBoundingClientRect?.(); } catch { /* gone */ }
      if (r?.width > 0 && r?.height > 0) occupy(r.left ?? r.x, r.top ?? r.y, r.width, r.height);
      else if (fp.m_Rect) occupy(fp.m_Rect.x, fp.m_Rect.y, fp.m_Rect.width, fp.m_Rect.height);
    }
    for (const p of document.querySelectorAll('[vsg-type="panel"]')) {
      if (ours(p.id)) continue;
      const r = p.getBoundingClientRect();
      occupy(r.left, r.top, r.width, r.height);
    }
    occupy(0, innerHeight - STRIP.h, Math.min(STRIP.w, innerWidth), STRIP.h);
    occupy(0, 0, innerWidth, 1);
    const freeSpot = (W, H) => {
      for (let y = innerHeight - H - GAP; y >= GAP; y -= 8) {
        for (let x = innerWidth - W - GAP; x >= GAP; x -= 8) {
          if (!rs.some((r) => r.top < y + H + GAP && r.bottom > y - GAP && r.left < x + W + GAP && r.right > x - GAP)) {
            occupy(x, y, W, H);
            return { x, y };
          }
        }
      }
      return null;
    };
    // -> { x, y } of the region (onMove(spot): the allocator moved it)
    const region = (owner, W, H, onMove) => {
      if (R) {
        const at = (r) => r && { x: r.x ?? r.left, y: r.y ?? r.top };
        try {
          const r = at(R.claim(owner, W, H, { onMove: (nr) => { const s = at(nr); if (s) onMove(s); } }));
          claimed.push(owner);
          if (!r) log(`${owner}: no region`);
          return r;
        } catch (e) { log(`regions.claim ${owner}`, String(e)); }
      }
      return freeSpot(W, H);
    };
    const moved = () => { try { G.forceLayoutUpdate(); } catch { /* next layout */ } };
    const moveTo = (el, x, y) => { if (el) Object.assign(el.style, { left: `${x}px`, top: `${y}px` }); };
    let bar = null, ctl = null, menu = null, menuOpen = false;
    const W = Math.max(HANDLE.widthPx, CONTROLS.widthPx), H = HANDLE.heightPx + 4 + CONTROLS.heightPx;
    const barSpot = (s) => ({ x: s.x + (W - HANDLE.widthPx) / 2, y: s.y }), ctlSpot = (s) => ({ x: s.x + (W - CONTROLS.widthPx) / 2, y: s.y + HANDLE.heightPx + 4 });
    const spot = region('vr-pet:bar', W, H, (s) => {
      if (bar) { const b = barSpot(s); moveTo(bar.content, b.x, b.y); }
      if (ctl) { const c = ctlSpot(s); moveTo(ctl.content, c.x, c.y); }
      log('bar region moved', s.x, s.y); moved();
    });
    if (!spot) { log('no drag handle: no free spot'); return null; }
    const { ids, breaks, px: menuPx } = UI.menuLayout(catalog);
    const mspot = region('vr-pet:menu', MENU.widthPx, menuPx, (s) => { if (menu) moveTo(menu.content, s.x, s.y); log('menu region moved', s.x, s.y); moved(); });
    if (!mspot) log('no menu: no free spot');
    // An embedded panel: `content` (fixed at `rect` of the page) is its
    // texture, registered in SGApp's embedded-UV table. With `when`: in the
    // scene graph only while when() (its node stays in the page, so its slot
    // is measured all along).
    const embed = (id, rect, props, when = null) => {
      const content = document.createElement('div');
      content.id = `${id}-content`;
      Object.assign(content.style, { position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', zIndex: 1, pointerEvents: 'auto' });
      for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'wheel'])
        content.addEventListener(t, (e) => e.stopPropagation());   // nothing reaches the dashboard's handlers
      const node = document.createElement('vsg-node');
      node.id = id;
      node.setAttribute('vsg-type', 'panel');
      const sgid = G.VRHTML.NextSGID();
      node.setAttribute('sgid', String(sgid));
      node.appendChild(content);
      const fp = {   // what SGApp's embedded-UV table reads of a panel
        props: { debug_name: id }, isExternal: false, m_Rect: { x: 0, y: 0, width: 0, height: 0 }, idx: undefined,
        getSGID: () => sgid, getEmbeddedIndex: () => fp.idx, getCurrentRootElement: () => node,
        updateLayoutValues() { const r = content.getBoundingClientRect(); fp.m_Rect = { x: r.x, y: r.y, width: r.width, height: r.height }; },
      };
      fp.idx = app.addEmbeddedPanelUVs(fp);
      if (fp.idx == null) { log(`${id}: no embedded UV slot`); return null; }
      const panel = () => {
        const r = content.getBoundingClientRect(), PW = innerWidth, PH = innerHeight;
        return { type: 'panel', properties: {
          id: `${overlayKey}::${id}`, sgid, key: overlayKey, debug_name: id, origin: [0, -1], visibility: 0, 'lasermouse-filtering': 0,
          'can-take-keyboard-focus': false, 'sort-depth-bias': -1, 'scale-index': 0, ...props,
          'embedded-uv-index': fp.idx, uv_min: [r.x / PW, r.y / PH], uv_max: [(r.x + r.width) / PW, (r.y + r.height) / PH],
        } };
      };
      node.buildNode = (ctx) => (when && !when() ? [ctx, null] : [{ ...ctx, currentPanel: fp, bInsideReparentedPanel: false }, panel()]);
      return { content, node, sgid, panel, dispose() { content.remove(); try { app.removeEmbeddedPanelUVs(fp); } catch { /* gone */ } } };
    };
    // The grip bar (like SteamVR's window grab handles): the push's event panel.
    bar = embed('sfui-vr-pet-handle', { ...barSpot(spot), w: HANDLE.widthPx, h: HANDLE.heightPx },
      { width: HANDLE.widthM, interactive: true, scrollable: true, 'only-visible-with-laser': true, 'is-grab-handle': true, 'hide-laser-when-clicking': true });
    if (!bar) { for (const o of claimed) { try { R.release?.(o); } catch { /* gone */ } } return null; }
    div(bar.content, 'sfui-vr-pet-grip');
    bar.content.addEventListener('mousedown', (e) => startDrag(handSide(e)));
    // Every release (capture phase: before the target's own handlers, even
    // those that stop it): hand the armed button over to its mouseup, end a drag.
    const onUp = () => { upArmed = armed; disarm(); endDrag(); };
    G.addEventListener('mouseup', onUp, true);
    // The controls row below the bar: ⋯ (the menu) and X (hide). The stock
    // window bar's look (legacydashboardframecontrols_*: one #23262E section,
    // buttons hover #3D4450, pressed #67707b, .6 opacity until hovered).
    ctl = embed('sfui-vr-pet-controls', { ...ctlSpot(spot), w: CONTROLS.widthPx, h: CONTROLS.heightPx },
      { width: CONTROLS.widthM, interactive: true, scrollable: false, 'only-visible-with-laser': true, 'is-grab-handle': false, 'hide-laser-when-clicking': false });
    const css = document.createElement('style');
    // The grip: the stock GrabHandleBar (grabhandle_*: a 12 px #3d4450 pill at
    // 1/1.1 width; hovered or dragged (ForceActive): white at full width, .08 s).
    css.textContent = '.sfui-vr-pet-grip{width:84%;height:12px;background-color:var(--dashboard-control-bar-button-color-a,#3d4450);border-radius:20px;'
      + 'transition:transform .08s ease-out,background-color .08s ease-out;transform-origin:center;transform:scaleX(calc(1 / 1.1))}'
      + '#sfui-vr-pet-handle-content:hover .sfui-vr-pet-grip,#sfui-vr-pet-handle-content[data-active] .sfui-vr-pet-grip{background-color:#fff;transform:scaleX(1)}'
      + '#sfui-vr-pet-controls-content{background:#23262E;border-radius:10px;opacity:.6;transition:opacity .4s ease-out;overflow:hidden}'
      + '#sfui-vr-pet-controls-content:hover{opacity:1;transition:opacity 0s}'
      + '.sfui-vr-pet-btn{flex:1;height:100%;display:flex;align-items:center;justify-content:center}'
      + '.sfui-vr-pet-btn:hover{background:#3D4450}.sfui-vr-pet-btn[data-armed]{background:#67707b}'
      + '#sfui-vr-pet-menu-content{display:block;background:#2d3239;border-radius:10px;overflow:hidden;color:#fff;'
      + `font:22px/1.2 "Motiva Sans",Arial,sans-serif;padding:${MENU.padPx}px 0}`
      + '.sfui-vr-pet-row{display:flex;align-items:center;gap:16px;padding:8px 24px 8px 20px;box-sizing:border-box;white-space:nowrap}'
      + '.sfui-vr-pet-row:hover{background:#3d4450}.sfui-vr-pet-row[data-armed]{background:#67707b}'
      + '.sfui-vr-pet-row img{width:32px;height:32px;flex:none}.sfui-vr-pet-name{flex:1}'
      + '.sfui-vr-pet-check{color:#1a9fff;font-weight:bold;visibility:hidden}.sfui-vr-pet-check[data-on]{visibility:visible}'
      + '.sfui-vr-pet-sep{height:1px;margin:4px 0;background:rgba(255,255,255,.07)}';
    document.head?.appendChild(css);
    const icon = (el, path) => el.insertAdjacentHTML?.('beforeend', `<svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">${path}</svg>`);
    let more = null, x = null;
    if (ctl) {
      more = div(ctl.content, 'sfui-vr-pet-btn');
      more.setAttribute('data-act', 'menu');
      icon(more, '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.6"/>');
      x = div(ctl.content, 'sfui-vr-pet-btn');
      x.setAttribute('data-act', 'close');
      icon(x, '<path d="M6 6L18 18M18 6L6 18"/>');
      button(x, () => hide());
      button(more, () => (menuOpen ? closeMenu() : openMenu()));
    }
    // The ⋯ menu: the models (thumbnail, name, a check on the current one), then commands.
    menu = mspot && ctl && embed('sfui-vr-pet-menu', { x: mspot.x, y: mspot.y, w: MENU.widthPx, h: menuPx },
      { width: MENU.widthM, interactive: true, scrollable: false, 'only-visible-with-laser': true, 'is-grab-handle': false, 'hide-laser-when-clicking': false },
      () => menuOpen);
    const checks = {};
    if (menu) {
      menu.content.style.display = 'block';   // rows one below the other (embed() centres a flex row)
      menu.content.style.visibility = 'hidden';   // while closed (laid out all along: its UV slot stays valid)
      for (const id of ids) {
        if (breaks.includes(id)) div(menu.content, 'sfui-vr-pet-sep');
        const row = div(menu.content, 'sfui-vr-pet-row');
        row.setAttribute('data-model', id);
        row.style.height = `${MENU.modelRowPx}px`;
        const img = document.createElement('img');
        img.setAttribute('src', models[id].thumb ?? '');
        row.appendChild(img);
        div(row, 'sfui-vr-pet-name', models[id].name);
        checks[id] = div(row, 'sfui-vr-pet-check', '✓');
        button(row, () => { closeMenu(); setModel({ id }); });
      }
      div(menu.content, 'sfui-vr-pet-sep');
      for (const [cmd, label] of UI.MENU_CMDS) {
        const row = div(menu.content, 'sfui-vr-pet-row', label);
        row.setAttribute('data-cmd', cmd);
        row.style.height = `${MENU.cmdRowPx}px`;
        button(row, () => { closeMenu(); S.cat.command(cmd); log('menu', cmd); });
      }
    }
    const markModel = () => { for (const [id, c] of Object.entries(checks)) { if (id === modelId) c.setAttribute('data-on', ''); else c.removeAttribute('data-on'); } };
    markModel();
    // Closing: a press outside the menu and the controls (capture: every
    // press on this page), or the laser away from both for MENU.leaveMs.
    let leaveTimer = null;
    const stay = () => { clearTimeout(leaveTimer); leaveTimer = null; };
    const leave = () => { stay(); if (menuOpen) leaveTimer = setTimeout(() => { leaveTimer = null; closeMenu(); }, MENU.leaveMs); };
    for (const c of [ctl?.content, menu?.content].filter(Boolean)) { c.addEventListener('mouseenter', stay); c.addEventListener('mouseleave', leave); }
    const onDown = (e) => { if (menuOpen && !inside(e.target, menu?.content) && !inside(e.target, ctl?.content)) closeMenu(); };
    G.addEventListener('mousedown', onDown, true);

    // lift above the cat > facing the user > the bar; the controls CTL_Y below
    // it, the menu (in the scene graph while open) MENU_Y above it and MENU.forwardM nearer
    const outer = document.createElement('vsg-transform'), facing = document.createElement('vsg-head-facing-transform');
    const osgid = G.VRHTML.NextSGID(), fsgid = G.VRHTML.NextSGID();
    let lift = liftOf();
    setAttrs(outer, { translation: `0 ${lift} 0`, rotation: '1 0 0 0', scale: '1 1 1', sgid: osgid });
    facing.setAttribute('sgid', String(fsgid));
    facing.appendChild(bar.node);
    const sub = (y, z, node) => {   // a transform under `facing` holding one panel
      const t = document.createElement('vsg-transform'), sgid = G.VRHTML.NextSGID();
      setAttrs(t, { translation: `0 ${y} ${z}`, rotation: '1 0 0 0', scale: '1 1 1', sgid });
      t.appendChild(node);
      return { t, sg: (panel) => ({ type: 'transform', properties: { sgid, translation: [0, y, z], rotation: [1, 0, 0, 0], scale: [1, 1, 1] }, children: [panel] }) };
    };
    const ctlH = CONTROLS.widthM * CONTROLS.heightPx / CONTROLS.widthPx;
    const CTL_Y = -(CONTROLS.gapM + ctlH);   // its bottom (origin [0, -1]): its top gapM below the bar
    const MENU_Y = HANDLE.widthM * HANDLE.heightPx / HANDLE.widthPx + MENU.gapM;   // its bottom: gapM above the bar's top
    const below = ctl && sub(CTL_Y, 0, ctl.node);
    if (below) facing.appendChild(below.t);
    // The menu's transform stays in the page (its panel is built only while
    // open); opening / closing shows / hides its content and sends once.
    const above = menu && sub(MENU_Y, MENU.forwardM, menu.node);
    if (above) facing.appendChild(above.t);
    const openMenu = () => {
      if (menuOpen || !above || S.hidden) return;
      menuOpen = true; markModel(); stay();
      menu.content.style.visibility = '';
      update();
      log('menu open');
    };
    const closeMenu = ({ send = true } = {}) => {
      stay();
      if (!menuOpen) return;
      menuOpen = false; disarm();
      menu.content.style.visibility = 'hidden';
      if (send) update();
      log('menu closed');
    };
    outer.appendChild(facing);
    barBody.appendChild(outer);
    return {
      sgid: bar.sgid, barContent: bar.content,
      closeMenu, markModel, isOpen: () => menuOpen, lift: () => lift,
      setLift(y) {   // -> changed
        if (y === lift) return false;
        lift = y; outer.setAttribute('translation', `0 ${y} 0`);
        return true;
      },
      sg: () => ({ type: 'transform', properties: { sgid: osgid, translation: [0, lift, 0], rotation: [1, 0, 0, 0], scale: [1, 1, 1] },
        children: [{ type: 'head-facing-transform', properties: { sgid: fsgid },
          children: [bar.panel(), ...(below ? [below.sg(ctl.panel())] : []), ...(menuOpen ? [above.sg(menu.panel())] : [])] }] }),
      dispose() {
        stay(); outer.remove(); bar.dispose(); ctl?.dispose(); menu?.dispose(); css.remove();
        for (const o of claimed) { try { R.release?.(o); } catch { /* gone */ } }
        G.removeEventListener('mouseup', onUp, true); G.removeEventListener('mousedown', onDown, true);
      },
    };
  }
  let handle = null;
  try { handle = makeHandle(); } catch (e) { log('no drag handle', String(e)); }
  // once (when shown): the page writes the panels' UV slots
  const layoutHandle = () => { if (handle) { try { G.forceLayoutUpdate(); } catch { /* next layout */ } } };

  // ---- world interface ----
  const pose = (path) => {
    try {
      const [p] = G.VRHTML.GetPose(path, 1);   // standing space
      return p?.bPoseIsValid ? p : null;
    } catch { return null; }
  };
  const toPose = (xf) => ({ p: [xf.translation.x, xf.translation.y, xf.translation.z], q: [xf.rotation.w, xf.rotation.x, xf.rotation.y, xf.rotation.z] });
  let handPoses = { left: null, right: null };   // { p, q } per hand, this tick
  // The hands for petting and startling: position and velocity only.
  const readHands = () => {
    handPoses = { left: null, right: null };
    const hand = (side) => {
      const p = pose(`/user/hand/${side}`);
      if (!p) return null;
      handPoses[side] = toPose(p.xfDeviceToAbsoluteTracking);
      const t = p.xfDeviceToAbsoluteTracking.translation, v = p.vVelocity ?? { x: 0, y: 0, z: 0 };
      return { x: t.x, y: t.y, z: t.z, vx: v.x, vy: v.y, vz: v.z };
    };
    return { left: hand('left'), right: hand('right') };
  };
  let hands = { left: null, right: null }, held = null;   // sampled once per tick (run below); held: the laser drag
  let shown = null, lastT = '', lastR = '', dirty = false;

  // Send gating: head pose once per tick; the head's turn rate; the cat in view.
  const TURN_DEG_S = 60, TURN_DEFER_MS = 250, VIEW_DEFER_MS = 1000;
  let headPose = null, headPrev = null, turnRate = 0, lastSend = 0;
  const deferred = { turn: 0, view: 0 };
  const readHead = (dt) => {
    const p = pose('/user/head');
    headPrev = headPose;
    headPose = p ? toPose(p.xfDeviceToAbsoluteTracking) : null;
    if (headPose && headPrev && dt > 0) {
      const d = Math.abs(headPose.q.reduce((s, v, i) => s + v * headPrev.q[i], 0));
      turnRate = 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI / dt;
    } else turnRate = 0;
  };
  const inView = (at) => !headPose || UI.inView(headPose.p, M.qrot(headPose.q, [0, 0, -1]), at);
  const fmt = (v, d) => v.map((x) => +x.toFixed(d)).join(' ');
  const heading = (q) => { const f = M.qrot(q, [0, 0, -1]); return Math.hypot(f[0], f[2]) > 0.05 ? Math.atan2(f[0], f[2]) : null; };
  // The carried frame F (the root while dragged: parent-path the hand, its
  // pose rel = hand⁻¹ · F0, as SteamVR's floating windows): F0 at the bar's
  // origin (the grab point) when pressed, its -Z along the line from the
  // controller (the push's direction), level. vrcompositor draws it rigidly
  // in the controller's frame, so the grab point stays put on the laser.
  const lookFrom = (from, to) => {
    const d = to.map((v, k) => v - from[k]), l = Math.hypot(...d) || 1;
    const pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / l)));
    return M.qnorm(M.qmul(M.qyaw(Math.atan2(-d[0], -d[2])), [Math.cos(pitch / 2), Math.sin(pitch / 2), 0, 0]));
  };
  const carried = (h, d = drag) => M.compose(M.compose(h, d.rel), { p: [0, 0, -d.push], q: [1, 0, 0, 0] });
  // The dragged cat's body under F: upright, its orientation at the grab
  // turned by the laser hand's heading change since; its root lift straight
  // below the grab point (the bar's origin stays at F's). From this tick's
  // hand pose (vrcompositor turns F with the controller every frame; this
  // undoes it once per tick). -> { q, p (in F), F, want } or null (no pose)
  const dragBody = () => {
    const h = handPoses[drag.hand];
    if (!h) return null;
    drag.lastHand = h;
    const psi = heading(h.q);
    if (psi != null && drag.psi0 == null) drag.psi0 = psi;
    if (psi != null) drag.want = M.qmul(M.qyaw(psi - drag.psi0), drag.w0.q);
    const want = drag.want ?? drag.w0.q, F = carried(h), c = M.qconj(F.q);
    return { q: M.qnorm(M.qmul(c, want)), p: M.qrot(c, [0, -handle.lift(), 0]), F, want };
  };
  // Back in the world: no parent, the push inactive and reset (next drag from 0).
  const endCarry = () => {
    root.removeAttribute('parent-path');
    const pp = push.sg.properties;
    pp['is-active'] = false; pp['reset-generation'] = ++pushGen; delete pp['event-panel-sgid']; delete pp['base-distance'];
    setBody([1, 0, 0, 0], [0, 0, 0]);
  };

  const world = {
    prefetch(clips) {
      want = all ? new Set([...clips, ...Object.keys(frames)]) : new Set([...clips].filter((c) => frames[c]));
    },
    ready(clip) {
      const m = mounted.get(clip);
      return !!m && m.n === frames[clip]?.length && performance.now() - m.last >= SETTLE_MS;
    },
    head() {
      if (!headPose) return null;
      const [x, y, z] = headPose.p, f = M.qrot(headPose.q, [0, 0, -1]);   // forward (-Z) on the floor plane
      const fl = Math.hypot(f[0], f[2]) || 1;
      return { x, y, z, fx: f[0] / fl, fz: f[2] / fl };
    },
    hands: () => hands,
    held: () => held,
    heldPose() {
      if (!drag?.rel) return null;
      // where it is drawn: the carried frame (this tick's hand, the last
      // push; on release the push asked then), the root lift below it
      const h = handPoses[drag.hand] ?? drag.lastHand, F = carried(h);
      return { x: F.p[0], y: F.p[1] - handle.lift(), z: F.p[2], q: drag.want ?? drag.w0.q };
    },
    show(clip, i, at) {
      if (S.hidden) return;
      const now = performance.now();
      const mounts = pump(now) | evict(now);
      let changed = dirty || !!mounts;
      dirty = false;
      const xf = world.ready(clip) ? frames[clip]?.[i] : null;   // else: keep the last frame
      if (xf && xf !== shown) {
        if (shown) setShown(shown, false);
        setShown(xf, true);
        shown = xf; changed = true;
      }
      // The handle just above the cat: over the scruff of a dangling cat (the dangle frames hang from it).
      if (handle?.setLift(frames.dangle?.includes(shown) ? HANDLE.liftDangle : liftOf())) changed = true;
      // World pose; dragged: the root carried by the hand (rel, constant).
      const W = { p: [at.x, at.y, at.z], q: at.q ?? M.qyaw(at.yaw) };
      let dragChanged = false;
      if (drag && !drag.w0) {
        drag.w0 = W; dragChanged = true;
        const h = handPoses[drag.hand];
        if (h) {   // the grab point (the bar's origin) rigid in the controller's frame from here
          const g = M.compose(W, { p: [0, handle.lift(), 0], q: [1, 0, 0, 0] }).p;
          drag.rel = M.compose(M.invert(h), { p: g, q: lookFrom(h.p, g) });
          drag.lastHand = h;
          root.setAttribute('parent-path', `/user/hand/${drag.hand}`);
          Object.assign(push.sg.properties, { 'is-active': true, 'event-panel-sgid': handle.sgid, 'base-distance': +Math.hypot(...drag.rel.p).toFixed(4) });
          log('carried', drag.hand, `${Math.hypot(...drag.rel.p).toFixed(3)} m from the controller`);
        } else { drag.phase = 'done'; log('drag: no hand pose'); }
      } else if (drag?.phase === 'ending') {   // ask how far it was pushed; carried until the answer (let go there)
        drag.phase = 'asking';
        const d = drag;
        if (d.rel) queueMicrotask(() => pushOf().then((z) => { d.push = z; }, (e) => log('drag: push?', String(e))).finally(() => { d.phase = 'done'; }));
        else d.phase = 'done';
      } else if (drag?.phase === 'done' && !held) {   // released (the core falls from heldPose()): back in the world, there
        if (drag.rel) endCarry();
        log('dragged to', fmt(W.p, 3), `push ${drag.push.toFixed(3)}`);
        drag = null; dragChanged = true; barActive(false);
      }
      const carry = drag?.rel;
      const place = { pose: carry ? drag.rel : W, changed: dragChanged };
      // Carried: the body upright below the grab point, turned with the controller's heading.
      if (carry) { const b = dragBody(); if (b && setBody(b.q, b.p)) changed = true; }
      const T = fmt(place.pose.p, 4), R = fmt(place.pose.q, 5);   // w x y z
      if (T !== lastT || R !== lastR) {
        root.setAttribute('translation', T); root.setAttribute('rotation', R);
        lastT = T; lastR = R; changed = true;
      }
      if (!root.isConnected) { document.body.appendChild(root); changed = true; }
      if (!changed) return;
      // Defer (keep it dirty) while the head turns fast or the cat is out of view (not while dragged).
      if (!place.changed && !drag) {
        if (turnRate > TURN_DEG_S && now - lastSend < TURN_DEFER_MS) { deferred.turn++; dirty = true; return; }
        if (!mounts && now - lastSend < VIEW_DEFER_MS && !inView(at)) { deferred.view++; dirty = true; return; }
      }
      lastSend = now;
      update();
    },
    load: () => { try { return G.__sfuiStore?.get?.(KEY); } catch { return undefined; } },
    save: (v) => store(v),
    log,
  };

  // ---- run ----
  S.root = root;
  S.frames = frames;
  S.cat = VrPetCore.create(world, opts.cat, baked);
  if (unknownModel) log('unknown stored model', unknownModel, '->', modelId);
  S.drag = (side) => { if (side) startDrag(side); else endDrag(); return !!drag; };   // debug
  S.where = (id) => where(id);   // debug
  // While dragged: the push (thumbstick), asked once per tick (heldPose());
  // also a trace (debug, 4 Hz): [ms, the grab point as computed (hand · rel ·
  // push), as vrcompositor has it (the pushed origin), laser hand pose, push].
  S.dragTrace = [];
  let traceAt = 0;
  const askPush = (now) => {
    if (drag?.phase !== 'drag' || !drag.rel || drag.asking) return;
    const d = drag, h = handPoses[d.hand], r = (v) => v.map((x) => +x.toFixed(3));
    d.asking = true;
    const trace = now - traceAt >= 250 && h;
    if (trace) traceAt = now;
    Promise.all([pushOf().then((z) => { if (drag === d) d.push = z; }, () => {}), trace ? where(PUSHED_ID).catch(() => null) : null]).then(([, w]) => {
      if (!trace) return;
      S.dragTrace.push([Math.round(now), r(carried(h, d).p), w ? r(w.p) : null, r(h.p), r(h.q), +d.push.toFixed(3)]);
      if (S.dragTrace.length > 80) S.dragTrace.shift();
    }).finally(() => { d.asking = false; });
  };
  let last = performance.now();
  const run = () => {
    const now = performance.now();
    try {
      readHead((now - last) / 1000);
      hands = readHands();
      held = drag && drag.phase !== 'done' ? { source: 'laser', hand: drag.hand } : null;
      S.cat.tick((now - last) / 1000);
      askPush(now);
    } catch (e) { log('tick', String(e)); }
    last = now;
  };
  const start = () => { last = performance.now(); S.timer = setInterval(run, 1000 / opts.fps); };

  // ---- hide / show (the X; the "+" menu's Pet entry via cli.mjs) ----
  // hide(): the cat leaves the scene at once: a drag is let go, the
  // core stands where it is (a dragged cat: below where it was carried), every frame
  // is unmounted, one scene graph send without it; no timers, no sends until
  // shown again. Persisted (hidden: true), so a SteamVR restart keeps it hidden.
  // Every frame out of the scene graph (sent with the next update()).
  const unmountAll = () => {
    for (const [name, m] of mounted) for (let i = 0; i < m.n; i++) frames[name][i].remove();
    mounted.clear(); nMounted = 0;
    if (shown) { setShown(shown, false); shown = null; }
  };
  // Let go of a drag and of anything that holds the pet: the core stands it where it is.
  const letGo = () => {
    if (drag) { if (drag.rel) endCarry(); drag = null; barActive(false); }
    disarm(); upArmed = null; held = null;
    try { S.cat.settle(); } catch (e) { log('settle', String(e)); }
  };
  const hide = () => {
    if (S.hidden) return { hidden: true, was: 'hidden' };
    S.hidden = true;
    clearInterval(S.timer); S.timer = null;
    letGo();
    handle?.closeMenu({ send: false });   // (the send below goes without it)
    unmountAll();
    want = new Set();
    root.remove();
    update();
    store({ hidden: true });
    log('hidden');
    return { hidden: true, was: 'shown' };
  };
  // show({ summon }): back at its spot while that is near and in view, else
  // 1 m in front of the user (core reveal(); summon: always). Idempotent: a
  // shown cat only gets the same rule (not while held or falling).
  const show = ({ summon = false } = {}) => {
    const reveal = () => {
      const st = S.cat.state(), h = world.head();
      const r = VrPetCore.reveal(st, h, { inView: inView({ x: st.x, y: 0, z: st.z }), force: !!summon });
      if (r === 'summon' && h) { S.cat.command('summon'); return true; }
      return false;
    };
    if (!S.hidden) {
      const st = S.cat.state();
      const summoned = !st.held && !st.falling && !drag && reveal();
      return { hidden: false, was: 'shown', summoned };
    }
    S.hidden = false;
    held = null; drag = null;
    endCarry();   // (also a fresh push)
    lastT = ''; lastR = ''; dirty = true;
    readHead(0);
    const summoned = reveal();
    store({ hidden: false });
    document.body.appendChild(root);
    layoutHandle();
    start();
    run();   // frames mount gradually from here (LOADS_PER_TICK per tick)
    log('shown', summoned ? 'summoned' : 'at its spot');
    return { hidden: false, was: 'hidden', summoned };
  };
  const status = () => {
    const st = S.cat.state(), h = world.head();
    return { hidden: !!S.hidden, pose: st.pose, activity: st.activity, x: +st.x.toFixed(3), z: +st.z.toFixed(3),
      distance: h ? +Math.hypot(st.x - h.x, st.z - h.z).toFixed(2) : null, held: st.held, falling: st.falling,
      dragging: !!drag, frames: nMounted, sends, version: VERSION, model: modelId };
  };
  // ---- models (coats and animals) ----
  const listModels = () => ({ current: modelId, default: catalog.default,
    models: (catalog.order ?? Object.keys(models)).map((id) => ({ id, name: models[id].name })) });
  const setModel = ({ id } = {}) => {
    const m = models[id];
    if (!m) return { error: `unknown model ${JSON.stringify(id)}`, model: modelId, models: listModels().models.map((x) => x.id) };
    const was = modelId;
    if (id === was) return { model: id, was, name: m.name };
    const other = catalog.frameSets[m.frames] !== baked;   // another animal: its own frames and core
    modelId = id;
    if (!S.hidden) unmountAll();   // the old model out at once (sent below), then the new frames load gradually
    if (other) {
      letGo();
      S.cat.save();   // its spot and heading (and pose, if the new one has it) go over to the new core
      baked = catalog.frameSets[m.frames];
      RARE = rareOf();
      buildFrames(m.dir);
      S.frames = frames;
      want = new Set();
      S.cat = VrPetCore.create(world, opts.cat, baked);
    } else {
      for (const fr of Object.values(frames)) for (const xf of fr) xf.rm.properties.source = `${m.dir}/${xf.file}`;
    }
    store({ model: id });
    handle?.markModel();
    log('model', id, other ? `(frames ${m.frames})` : '');
    if (S.hidden) return { model: id, was, name: m.name, hidden: true };
    update();
    dirty = true;
    return { model: id, was, name: m.name };
  };
  // Stable API for cli.mjs (bump API_VERSION on incompatible changes).
  const API_VERSION = 2;
  S.api = { version: API_VERSION, show, hide, status, models: listModels, setModel };

  S.pause = () => { clearInterval(S.timer); S.timer = null; };   // debug
  S.resume = () => { if (!S.timer && !S.hidden) start(); };
  S.dispose = () => {
    clearInterval(S.timer); root.remove(); handle?.dispose();
    if (proto && hooks) hooks.remove(proto, 'SendMessage', 'vr-pet');
    if (cap.sock?.send?.__sfuiPetOrig) cap.sock.send = cap.sock.send.__sfuiPetOrig;
    delete S.onSceneGraph;
    slowSend ? slowSend() : G.forceLayoutUpdate();
  };
  S.stats = () => ({ sender, sends, fast, deferred: { ...deferred }, captured: !!cap.str, hookCalls: cap.seen, wrapped: !!cap.sock?.send?.__sfuiPetOrig,
    mounted: [...mounted].map(([k, m]) => (m.n === frames[k].length ? k : `${k} ${m.n}/${frames[k].length}`)), frames: nMounted, loads, evictions,
    turnRate: Math.round(turnRate), rootSent: cap.node && { ...cap.node.properties },
    handle: !!handle, menuOpen: !!handle?.isOpen(), drag: drag && { hand: drag.hand, phase: drag.phase, push: drag.push },
    carry: root.getAttribute('parent-path'), pushSent: { ...push.sg.properties }, pushSeen: S.pushSeen ?? null, hidden: !!S.hidden });
  // Hidden (stored): everything is built, nothing is in the page, no timers, no sends.
  if (startHidden) { S.hidden = true; return 'hidden'; }
  document.body.appendChild(root);
  layoutHandle();
  start();
  readHead(0);
  S.cat.tick(0);
  return `patched (${modelId}, ${Object.values(baked.clips).reduce((s, c) => s + c.frames, 0)} frames, mount ${opts.mount}, via ${sender})`;
}
