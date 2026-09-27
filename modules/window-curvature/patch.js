// window-curvature: adjustable curvature per SteamVR dashboard window. The
// stock "Toggle Curvature" control becomes a wheel wherever it is shown: the
// row of a window's More Options (three-dot) menu (with the value on the
// right of the row) and, when the control sits in the window's bottom bar
// (e.g. moved there by frame-controls), that bar button (no value shown:
// the steps and snap points are felt as controller haptics). Click toggles
// (curved -> flat, flat -> stock curve), dragging up/down with the laser sets
// the curvature live.
//
// Target: SteamVR's dashboard page (vrwebhelper, DevTools 127.0.0.1:8087,
// title "systemui"). This file is a function expression, called by the file
// lib/default.nix (mkPatch) generates: (<this file>)(find, sigs, opts, hooks),
// with find the finder library (lib/finders.js), sigs this patch's module
// signatures (lib/signatures.json, "window-curvature"), opts the options from
// window-curvature.nix and hooks the shared method hooks (lib/hooks.js).
//
// How stock curvature works (systemui's `curvature` frame component, found
// by signature; frame.curvature):
//   shouldCurve   on/off: m_bCurveOverride (set by ToggleCurvature(), cleared
//                 when the dock location changes), else the stock default:
//                 curved when docked in the dashboard, theater per setting,
//                 flat elsewhere (world, hands).
//   curvatureOriginDistance = shouldCurve ? DashboardStore.curvatureDistance
//                 (dashboard distance + 1.8 m, e.g. 2.95) : 1000.
//   The frame renders a transform node with id curvatureTransformOriginID
//   ("frame:<id>:curvature-origin") at translation z = that distance, and
//   every panel of the frame references it as "curvature-origin-id";
//   vrcompositor bends the panels onto a cylinder around that point. So
//   curvature = 1 / radius, and "flat" is just a very distant origin (1000).
// Those computed properties can't be overridden (non-configurable MobX
// instance properties), so this patch hooks the mailbox's SendMessage
// (lib/hooks.js, shared with dashboard-windows) and rewrites the origin's
// translation in outgoing scene graphs: distance = stock distance / value,
// value 1 = SteamVR's stock curve, 2 = twice as curved (half the radius),
// 0 = flat (the stock toggle off). On/off stays the stock state
// (ToggleCurvature), so the stock toggle and this control always agree.
//
// Values are kept per window (key: the frame's first overlay key) in
// window.__sfuiWindowCurvatureState (schema 1: { values, log }), which
// unpatch and upgrades leave in place (not persisted across a dashboard
// reload / SteamVR restart). A window without its own value uses
// opts.default when placed in the world or on a hand, and 1 (stock) when
// docked in the dashboard or the theater, so the docked Steam window stays
// concentric with the dashboard bar.
//
// Bar button: the bar panel (vsg-node#legacy-frame-controls-<frameID>,
// origin TopCenter) is one button high, and the laser's position stops at
// the edge of the pressed panel. While a drag on the bar button runs, the
// panel gets opts.barDragRoom px of transparent padding above and below
// (stock window.forceLayoutUpdate() re-measures it), and the panel's origin
// is moved by the same amount in outgoing scene graphs, so the bar stays
// where it is in VR. The padding moves the bar down in page coordinates;
// laser events the compositor still maps with the old layout are recognised
// (the laser moves continuously) and shifted. opts.barDragPixelsPerUnit
// sets the drag speed there.
//
// Haptics (opts.haptics): VRHTML.VROverlay.TriggerOverlayHapticEffect with
// the stock EOverlayHapticEffect values (sigs.hapticEffects): SlidingEdge at
// 0 and max, Snap at a snap point, Sliding for other steps (at most every
// 30 ms).
//
// Contract with other patches (e.g. a long press on frame controls): this
// patch owns press-and-drag on its controls.
//   - Every element it drives has the class `sfui-curv-ctl`.
//   - When a press on one becomes a drag (opts.dragThreshold px vertical),
//     it dispatches a bubbling CustomEvent `sfui-curv-dragstart` on the
//     element (detail { frameID, where: 'menu' | 'bar' }); when that drag
//     ends (release or cancelPress), `sfui-curv-dragend`.
//   - window.__sfuiWindowCurvature.cancelPress() ends the current press on
//     any of its controls without its click (a drag stays at its value);
//     returns whether a press was active.
// A patch with its own gesture on these elements lets mousemove through
// while that gesture is undecided, drops it on `sfui-curv-dragstart`, and
// calls cancelPress() when it takes the press over. Neither side reads the
// other's thresholds or restores the other's state afterwards.
//
// Debugging: window.__sfuiWindowCurvature: dump() (per frame: dock, on/off,
// stored/applied value, distances, controls), hits (scene-graph rewrite and
// haptic counters), log (last events, also in the state), setValue(frameID,
// v), controls(), cancelPress().
((find, sigs, opts, hooks) => {
  const NAME = 'window-curvature';
  const VERSION = 11;
  const FLAT = 999;                               // origin distances >= this are "flat"
  const ICON_OFF = 40, ICON_ON = 39;              // Toggle Curvature action icons (sigs.curvatureAction)
  const HAPTIC = { Snap: 3, Sliding: 4, SlidingEdge: 5 };   // EOverlayHapticEffect (sigs.hapticEffects)

  const o = {
    default: 1, max: 3, step: 0.05, snap: 0.15, snapPoints: [0, 1], dragThreshold: 8, dragPixelsPerUnit: 60,
    barDragPixelsPerUnit: 30, barDragRoom: 160, haptics: true, ...opts,
  };
  if (!(o.max > 0 && o.step > 0 && o.step <= o.max && o.default >= 0 && o.default <= o.max && o.snap >= 0 &&
      Array.isArray(o.snapPoints) && o.snapPoints.every((p) => p >= 0 && p <= o.max) &&
      o.dragThreshold >= 0 && o.dragPixelsPerUnit > 0 && o.barDragPixelsPerUnit > 0 &&
      Number.isInteger(o.barDragRoom) && o.barDragRoom >= 0 && typeof o.haptics === 'boolean'))
    return `invalid options ${JSON.stringify(opts)}`;
  const id = JSON.stringify([VERSION, o]);

  const prev = window.__sfuiWindowCurvature;
  if (prev?.version === VERSION && prev.id === id) return prev.check();

  const DS = window.DashboardStore, FS = window.FrameStore;
  if (!DS || !FS) return 'not patched: window.DashboardStore/FrameStore missing';
  let mods;
  try {
    mods = find.resolveAll(find.getWebpackRequire('webpackChunkvrwebui'), sigs);
  } catch (e) {
    return `signature not found, dashboard left unpatched: ${e.message}`;
  }
  const mx = mods.mobx.module;
  if (typeof mx.reaction !== 'function') return 'signature not found, dashboard left unpatched: mobx.reaction';
  const proto = mods.mailbox.exports.Mailbox.prototype;
  const resendStock = mods.sceneGraph.exports.resend;
  const Curvature = mods.curvature.exports.Curvature;
  const actions = mods.actions.exports.store;
  const DOCK = mods.dock.exports.EDockLocation;
  const CLS = mods.frameControlsClasses.exports;  // { row, label }: CSS module class names

  prev?.teardown?.();                             // older VERSION or other options

  // ---- state + log ---------------------------------------------------------------
  let S = window.__sfuiWindowCurvatureState;
  if (S?.schema !== 1) S = window.__sfuiWindowCurvatureState = { schema: 1, values: {} };
  const logBuf = S.log ??= [];
  const log = (msg, data) => {
    logBuf.push({ t: new Date().toISOString().slice(11, 23), msg, ...(data ? { data } : {}) });
    if (logBuf.length > 200) logBuf.splice(0, logBuf.length - 200);
  };
  const hits = { sends: 0, origins: 0, scaled: 0, roomOrigins: 0, haptics: 0 };

  // ---- values ------------------------------------------------------------------------
  const round = (v) => +(Math.round(v / o.step) * o.step).toFixed(6);
  const clamp = (v) => Math.min(o.max, Math.max(0, v));
  const fmt = (v) => (v <= 0 ? '0' : v.toFixed(o.step < 0.1 ? 2 : 1));
  const curvatureOf = (f) => (f?.curvature instanceof Curvature ? f.curvature : null);
  const keyOf = (f) => f.associatedSummonOverlayKeys?.[0] ?? `frame:${f.frameID}`;
  const dockOf = (f) => f.docking?.visualDockLocation ?? f.docking?.dockLocation;
  const strength = (f) => S.values[keyOf(f)] ??
    ([DOCK.LeftHand, DOCK.RightHand, DOCK.World].includes(dockOf(f)) ? o.default : 1);
  const curved = (f) => !!curvatureOf(f)?.shouldCurve;
  const shown = (f) => (curved(f) ? strength(f) : 0);

  // Value for a drag position (target: unrounded value under the pointer),
  // or null to keep the current one: within +-snap of a snap point the value
  // is that point, else target rounded to step; a change of less than 0.6
  // steps away from cur is ignored (laser jitter at a step boundary).
  const dragValue = (target, cur) => {
    const snapped = o.snapPoints.find((p) => Math.abs(target - p) <= o.snap);
    const v = clamp(snapped ?? round(target));
    if (v === cur || (snapped === undefined && Math.abs(target - cur) < o.step * 0.6)) return null;
    return v;
  };

  // ---- haptics -------------------------------------------------------------------------
  let lastHaptic = -Infinity;
  const haptic = (effect) => {
    if (!o.haptics) return;
    const ov = window.VRHTML?.VROverlay;
    if (typeof ov?.TriggerOverlayHapticEffect !== 'function' || typeof ov.ThisOverlayHandle !== 'function') return;
    const now = performance.now();
    if (effect === HAPTIC.Sliding && now - lastHaptic < 30) return;
    lastHaptic = now;
    try { ov.TriggerOverlayHapticEffect(ov.ThisOverlayHandle(), effect); hits.haptics++; } catch (e) { log('haptic failed', String(e)); }
  };
  const hapticFor = (v) => haptic(v <= 0 || v >= o.max ? HAPTIC.SlidingEdge
    : o.snapPoints.includes(v) ? HAPTIC.Snap : HAPTIC.Sliding);

  // ---- scene graph ---------------------------------------------------------------------
  // Bar panels with drag room: frameID -> { node, pad, saved }.
  const rooms = new Map();
  // Keeps a padded bar panel's content where it was: the stock origin (x, y
  // in -1..1 of the panel, y = 1 top) is re-expressed for the taller panel.
  const fixOrigin = (p) => {
    const m = /^legacy-frame-controls-(\d+)$/.exec(p.debug_name ?? '');
    const r = m && rooms.get(Number(m[1]));
    if (!r || !Array.isArray(p.origin) || p.origin.length < 2) return;
    const h = r.node.getBoundingClientRect().height, inner = h - 2 * r.pad;
    if (!(inner > 0)) return;
    const fromTop = r.pad + ((1 - p.origin[1]) / 2) * inner;
    p.origin = [p.origin[0], 1 - (2 * fromTop) / h, ...p.origin.slice(2)];
    hits.roomOrigins++;
  };
  // Origin node ids may carry a "<prefix>::" (sub-scene); match the suffix.
  const rewrite = (sg) => {
    const byOrigin = new Map();
    for (const f of FS.frames) {
      const c = curvatureOf(f);
      if (c?.shouldCurve) byOrigin.set(c.curvatureTransformOriginID, f);
    }
    if (!byOrigin.size && !rooms.size) return;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const p = n.properties, nid = p?.id;
      if (typeof nid === 'string' && nid.endsWith(':curvature-origin')) {
        hits.origins++;
        const i = nid.lastIndexOf('::');
        const f = byOrigin.get(i < 0 ? nid : nid.slice(i + 2));
        const t = p.translation, v = f && strength(f);
        if (v > 0 && v !== 1 && Array.isArray(t) && t.length >= 3 && t[2] < FLAT) {
          p.translation = [t[0], t[1], t[2] / v];
          hits.scaled++;
        }
      }
      if (rooms.size && n.type === 'panel' && p) fixOrigin(p);
      if (n.children) walk(n.children);
    };
    walk(sg);
  };
  const hook = (args) => {
    const msg = args[1];
    if (msg?.type !== 'update_scene_graph') return;
    hits.sends++;
    rewrite(msg.scene_graph);
  };

  // Scene-graph resend (systemui's own debounced scheduler), at most every 40 ms.
  let lastResend = 0, resendTimer = null;
  const resend = () => {
    if (resendTimer) return;
    resendTimer = setTimeout(() => {
      resendTimer = null; lastResend = performance.now();
      try { resendStock(); } catch (e) { log('resend failed', String(e)); }
    }, Math.max(0, lastResend + 40 - performance.now()));
  };
  // Panel bounds are re-measured on the stock forced layout update (a
  // padding change doesn't trigger the panels' ResizeObserver).
  const relayout = () => {
    try { window.forceLayoutUpdate?.(); } catch (e) { log('forceLayoutUpdate failed', String(e)); }
    resend();
  };

  // Sets the shown value of a frame: 0 = curvature off, > 0 = on with that
  // strength. On/off goes through the stock ToggleCurvature (what the
  // control's stock click invokes), so Steam's state and the icon match.
  // Going to 0 forgets the window's value (turning it on again, e.g. by
  // docking it in the dashboard, uses the default).
  const setValue = (f, v, why) => {
    const c = curvatureOf(f);
    if (!c) return;
    v = clamp(round(v));
    const from = shown(f);
    if (v <= 0) {
      delete S.values[keyOf(f)];
      if (c.shouldCurve) c.ToggleCurvature();
    } else {
      S.values[keyOf(f)] = v;
      if (!c.shouldCurve) c.ToggleCurvature();
    }
    log('set', { frame: f.frameID, key: keyOf(f), why, from, to: v });
    resend();
    updateUI(f);
  };

  // ---- UI ------------------------------------------------------------------------------
  // Menu row: the value is shown on its right with small arrows above/below
  // (only where the value can go). Bar button: no indicator.
  const STYLE_ID = 'sfui-window-curvature-style';
  const ROW = `.${CLS.row}`;
  const CSS = `
.sfui-curv-ctl { cursor: ns-resize; }
.sfui-curv-ctl.sfui-dragging { background: var(--gamepadui-grey, #67707b) !important; }
.sfui-curv-ind { flex: none; align-self: stretch; position: relative; width: 3em; min-height: 0; font-size: 0.72em;
  margin: -8px 0 -8px auto; font-variant-numeric: tabular-nums; line-height: 1; pointer-events: none;
  user-select: none; }
${ROW}:first-child > .sfui-curv-ind { margin-top: -14px; }
${ROW}:last-child > .sfui-curv-ind { margin-bottom: -14px; }
.sfui-curv-ind > div { position: absolute; left: 0; right: 0; text-align: center; transform: translateY(-50%); }
.sfui-curv-ind > .sfui-curv-v { top: 50%; font-size: 1.2em; transform: translateY(calc(-50% + var(--sfui-curv-dy, 0px))); }
/* Arrows as CSS triangles (the arrow glyphs sit at different heights),
   placed symmetrically around the number; their text only toggles visibility. */
.sfui-curv-ind > .sfui-curv-up, .sfui-curv-ind > .sfui-curv-dn {
  left: 50%; right: auto; width: 0.6em; height: 0.36em; margin-left: -0.3em;
  overflow: hidden; text-indent: -99em; background: currentColor; }
.sfui-curv-ind > .sfui-curv-up { top: calc(50% - 1.05em); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.sfui-curv-ind > .sfui-curv-dn { top: calc(50% + 1.05em); clip-path: polygon(0 0, 100% 0, 50% 100%); }
.sfui-curv-ind > .sfui-curv-up:empty, .sfui-curv-ind > .sfui-curv-dn:empty { visibility: hidden; }
`;
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  };

  // The frame's Toggle Curvature action: a toggle (invocation 2) with the
  // curvature icons. Its menu row is found by position among the menu's
  // rows, checked against (else looked up by) the action's label; its bar
  // button by the React `control` prop of the bar's buttons.
  const isCurvatureAction = (a) => {
    const p = a?.partialParams;
    return p?.invocation === 2 && p?.icon?.enum === ICON_OFF && p?.icon_active?.enum === ICON_ON;
  };
  const isCurvatureItem = (i) => i?.type === 2 && isCurvatureAction(actions.GetAction(i.action_id));
  const inBar = (f) => (f.protoForSteam?.controls?.items_for_bottom_frame_controls ?? []).some(isCurvatureItem);
  const panelOf = (fid) => document.getElementById(`legacy-frame-controls-additional-options-${fid}`);
  const barOf = (fid) => document.getElementById(`legacy-frame-controls-${fid}`);
  const curvatureRow = (f, panel) => {
    const rows = [...panel.querySelectorAll(ROW)];
    const items = (f.controlAdditionalOptionsItems ?? []).filter((i) => i.type === 2);
    const idx = items.findIndex(isCurvatureItem);
    if (idx < 0) return { why: 'no curvature action' };
    const label = actions.GetAction(items[idx].action_id).protoForSteam?.display_name;
    const text = (r) => r.querySelector(`.${CLS.label}`)?.textContent;
    let row = rows.length === items.length ? rows[idx] : null;
    if (!row || (label && text(row) !== label)) row = rows.find((r) => label && text(r) === label) ?? null;
    return row ? { row } : { why: `row not found (${rows.length} rows, ${items.length} items)` };
  };
  const barButton = (node) => {
    for (const b of node.querySelectorAll('.ButtonControl')) {
      if (b.closest('[id^="legacy-frame-controls-additional-options-"]')) continue;
      const fiber = find.findFiberUp(b, (x) => x.memoizedProps?.control != null, 12);
      if (isCurvatureItem(fiber?.memoizedProps.control)) return b;
    }
    return null;
  };

  // Digits have no descenders, so their ink sits above the centre of the line
  // box that translateY(-50%) centres. The ink box is measured once (canvas
  // measureText: font metrics vs. actual digit bounds) and the number shifted
  // by the difference, so it is optically centred between the arrows.
  // (CSS text-box-trim would do this; Steam's Chromium lacks it.)
  let ctx2d;
  const inkShift = (el) => {
    const cs = getComputedStyle(el);
    ctx2d ??= document.createElement('canvas').getContext('2d');
    ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx2d.measureText('0123456789.');
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize);
    const baseline = lh / 2 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
    const inkCentre = baseline - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    return lh / 2 - inkCentre;                    // > 0: move down
  };
  const buildInd = () => {
    const ind = document.createElement('div');
    ind.className = 'sfui-curv-ind';
    for (const c of ['sfui-curv-up', 'sfui-curv-v', 'sfui-curv-dn']) {
      const d = document.createElement('div'); d.className = c; ind.appendChild(d);
    }
    return ind;
  };
  const renderInd = (ind, v) => {
    const [up, num, dn] = ind.children;
    up.textContent = v < o.max ? '▲' : '';
    num.textContent = fmt(v);
    dn.textContent = v > 0 ? '▼' : '';
    if (ind.isConnected && !num.style.getPropertyValue('--sfui-curv-dy'))
      num.style.setProperty('--sfui-curv-dy', `${inkShift(num).toFixed(2)}px`);
  };

  // `${frameID}:menu` / `${frameID}:bar` -> { key, fid, where, panel, el, ind, mo, down }
  const controls = new Map();
  function updateUI(f) {
    const c = controls.get(`${f.frameID}:menu`);
    if (c?.ind?.isConnected) renderInd(c.ind, shown(f));
  }

  // ---- input -----------------------------------------------------------------------------
  // Every press/click on a control is stopped at the element, so React
  // (listening at the root) never runs the stock onClick; the click is
  // re-implemented on mouseup when the press never became a drag. Drag:
  // vertical and relative (the cylinder bends horizontally, so the pointer's
  // y on the panel barely moves while the curvature changes). A press
  // becomes a drag after dragThreshold px (then re-based, so there is no
  // jump); the value follows at dragPixelsPerUnit (bar: barDragPixelsPerUnit)
  // px per 1.0, see dragValue. One press at a time, window capture listeners
  // while it lasts.
  const stop = (e) => e.stopPropagation();
  const STOPPED = ['click', 'dblclick', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu'];
  let press = null;                               // { c, y0, v0, last, moved, shift, stale }

  const emit = (c, type) => {
    try {
      c.el?.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { frameID: c.fid, where: c.where } }));
    } catch (e) { log(`${type} listener failed`, String(e)); }
  };

  const addRoom = (p) => {
    const node = p.c.panel;
    if (!o.barDragRoom || !node?.isConnected || rooms.has(p.c.fid)) return;
    const before = p.c.el.getBoundingClientRect().top;
    rooms.set(p.c.fid, { node, pad: o.barDragRoom, saved: [node.style.paddingTop, node.style.paddingBottom] });
    node.style.paddingTop = node.style.paddingBottom = `${o.barDragRoom}px`;
    const shift = p.c.el.getBoundingClientRect().top - before;
    p.shift = shift; p.stale = shift !== 0; p.last += shift; p.y0 += shift;
    relayout();
  };
  const removeRoom = (fid) => {
    const r = rooms.get(fid);
    if (!r) return;
    rooms.delete(fid);
    [r.node.style.paddingTop, r.node.style.paddingBottom] = r.saved;
    relayout();
  };

  const onMove = (e) => {
    const p = press;
    if (!p) return;
    const f = FS.GetFrame(p.c.fid);
    if (!f) { endPress('frame gone'); return; }
    let y = e.clientY;
    // After the bar got its room, events the compositor still maps with the
    // old layout are off by `shift`: take the reading closer to the last one.
    if (p.stale) {
      if (Math.abs(y + p.shift - p.last) < Math.abs(y - p.last)) y += p.shift;
      else p.stale = false;
    }
    p.last = y;
    if (!p.moved) {
      if (Math.abs(y - p.y0) < o.dragThreshold) return;
      p.moved = true;
      p.c.el?.classList.add('sfui-dragging');
      log('drag', { frame: p.c.fid, where: p.c.where });
      emit(p.c, 'sfui-curv-dragstart');
      if (press !== p) return;                    // a listener cancelled the press
      if (p.c.where === 'bar') addRoom(p);
      p.y0 = p.last;
      return;
    }
    const ppu = p.c.where === 'bar' ? o.barDragPixelsPerUnit : o.dragPixelsPerUnit;
    const v = dragValue(p.v0 + (p.y0 - y) / ppu, shown(f));
    if (v === null) return;
    setValue(f, v, 'drag');
    hapticFor(v);
  };
  const onUp = (e) => {
    if (e.button === 0) endPress('release');
  };
  // Ends the press; `release` of a press that never moved is a click.
  function endPress(why) {
    const p = press;
    if (!p) return false;
    press = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    p.c.el?.classList.remove('sfui-dragging');
    removeRoom(p.c.fid);
    if (p.moved) emit(p.c, 'sfui-curv-dragend');
    const f = FS.GetFrame(p.c.fid);
    if (why === 'release') {
      if (!p.moved && f) setValue(f, curved(f) ? 0 : 1, `click (${p.c.where})`);   // curved -> flat, flat -> stock
    } else {
      log('press ended', { frame: p.c.fid, where: p.c.where, why, dragged: p.moved });
    }
    return true;
  }
  const onDown = (c) => (e) => {
    e.stopPropagation(); e.preventDefault();
    const f = FS.GetFrame(c.fid);
    if (e.button !== 0 || !f) return;
    endPress('new press');
    press = { c, y0: e.clientY, last: e.clientY, v0: shown(f), moved: false, shift: 0, stale: false };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };

  // ---- controls --------------------------------------------------------------------------
  const setEl = (c, el) => {
    if (c.el === el) return;
    if (c.el) detach(c);
    c.el = el;
    el.classList.add('sfui-curv-ctl');
    if (press?.c === c && press.moved) el.classList.add('sfui-dragging');   // re-rendered mid-drag
    el.addEventListener('mousedown', c.down);
    for (const t of STOPPED) el.addEventListener(t, stop);
  };
  function detach(c) {
    c.el.classList.remove('sfui-curv-ctl', 'sfui-dragging');
    c.el.removeEventListener('mousedown', c.down);
    for (const t of STOPPED) c.el.removeEventListener(t, stop);
  }
  const newControl = (key, fid, where, panel) => {
    const c = { key, fid, where, panel, el: null, ind: where === 'menu' ? buildInd() : null };
    c.down = onDown(c);
    c.mo = new MutationObserver(() => {
      if (!c.el?.isConnected || (c.ind && c.ind.parentElement !== c.el)) queueSync();
    });
    c.mo.observe(panel, { childList: true, subtree: true });
    controls.set(key, c);
    return c;
  };
  function removeControl(key) {
    const c = controls.get(key);
    if (!c) return;
    if (press?.c === c) endPress('control removed');
    c.mo.disconnect();
    if (c.el) detach(c);
    c.ind?.remove();
    controls.delete(key);
  }

  const injectMenu = (f) => {
    const key = `${f.frameID}:menu`, panel = panelOf(f.frameID);
    if (!panel) return 'no panel';
    let c = controls.get(key);
    if (c && c.panel !== panel) { removeControl(key); c = null; }
    if (c?.el?.isConnected && c.ind.parentElement === c.el) { renderInd(c.ind, shown(f)); return 'ok'; }
    const r = curvatureRow(f, panel);
    if (!r.row) return r.why;
    ensureStyle();
    c ??= newControl(key, f.frameID, 'menu', panel);
    setEl(c, r.row);
    r.row.append(c.ind);
    renderInd(c.ind, shown(f));
    return 'ok';
  };
  const injectBar = (f) => {
    const key = `${f.frameID}:bar`, node = barOf(f.frameID);
    if (!node) return 'no bar panel';
    let c = controls.get(key);
    if (c && c.panel !== node) { removeControl(key); c = null; }
    if (c?.el?.isConnected && node.contains(c.el)) return 'ok';
    const btn = barButton(node);
    if (!btn) return 'bar button not found';
    ensureStyle();
    c ??= newControl(key, f.frameID, 'bar', node);
    setEl(c, btn);
    return 'ok';
  };

  // Wanted controls: open menus, and bars that hold the curvature action;
  // injected with retries until React has rendered them (bars only while
  // the frame is visible: a hidden frame has no bar panel).
  let syncTimer = null, retries = 0;
  const failed = new Map();                       // key -> last reason logged
  const sync = () => {
    syncTimer = null;
    const want = new Map();
    for (const f of FS.frames) {
      if (f.isControlAdditionalOptionsOpen) want.set(`${f.frameID}:menu`, f);
      if (inBar(f)) want.set(`${f.frameID}:bar`, f);
    }
    for (const key of [...controls.keys()]) if (!want.has(key)) removeControl(key);
    for (const key of [...failed.keys()]) if (!want.has(key)) failed.delete(key);
    let pending = false;
    for (const [key, f] of want) {
      const bar = key.endsWith(':bar');
      const r = bar ? injectBar(f) : injectMenu(f);
      if (r === 'ok') { failed.delete(key); continue; }
      if (bar ? !f.isCurrentlyVisible : r === 'no curvature action') continue;   // hidden frame / not in this menu
      pending = true;
      if (failed.get(key) !== r) { failed.set(key, r); log('inject failed', { frame: f.frameID, where: bar ? 'bar' : 'menu', why: r }); }
    }
    if (pending && retries < 12) { retries++; syncTimer = setTimeout(sync, 60 * retries); } else retries = 0;
  };
  function queueSync() { if (!syncTimer) syncTimer = setTimeout(sync, 0); }

  hooks.before(proto, 'SendMessage', NAME, hook);
  const disposers = [
    mx.reaction(
      () => FS.frames.map((f) => [f.frameID, f.isControlAdditionalOptionsOpen ? 1 : 0, curved(f) ? 1 : 0, dockOf(f),
        inBar(f) ? 1 : 0, f.isCurrentlyVisible ? 1 : 0].join(':')).join(','),
      () => { retries = 0; queueSync(); for (const f of FS.frames) updateUI(f); },
    ),
    mx.reaction(() => DS.curvatureDistance, () => resend()),
  ];

  const teardown = () => {
    endPress('teardown');
    for (const d of disposers.splice(0)) d();
    clearTimeout(syncTimer); clearTimeout(resendTimer);
    for (const key of [...controls.keys()]) removeControl(key);
    for (const fid of [...rooms.keys()]) removeRoom(fid);
    document.getElementById(STYLE_ID)?.remove();
    hooks.remove(proto, 'SendMessage', NAME);
    if (window.__sfuiWindowCurvature === state) delete window.__sfuiWindowCurvature;
    try { resendStock(); } catch { /* applies with the next scene-graph update */ }
  };
  const check = () => {
    if (!hooks.has(proto, 'SendMessage', NAME)) hooks.before(proto, 'SendMessage', NAME, hook);
    queueSync();
    return 'unchanged';
  };
  const dump = () => FS.frames.map((f) => ({
    frame: f.frameID, title: f.title, key: keyOf(f), dock: dockOf(f), curved: curved(f),
    override: curvatureOf(f)?.m_bCurveOverride, stored: S.values[keyOf(f)], shown: shown(f),
    stockDistance: curvatureOf(f)?.curvatureOriginDistance,
    appliedDistance: curved(f) ? DS.curvatureDistance / strength(f) : null,
    menuOpen: f.isControlAdditionalOptionsOpen, inBar: inBar(f), visible: f.isCurrentlyVisible,
    control: !!controls.get(`${f.frameID}:menu`)?.el?.isConnected,
    barControl: !!controls.get(`${f.frameID}:bar`)?.el?.isConnected,
  }));
  const state = {
    version: VERSION, id, opts: o, hits, log: logBuf, state: S, teardown, check, dump, dragValue,
    setValue: (fid, v) => { const f = FS.GetFrame(fid); if (f) setValue(f, v, 'api'); return f ? shown(f) : 'no frame'; },
    cancelPress: () => endPress('cancelled'),
    controls: () => [...controls.values()].map((c) => ({ frame: c.fid, where: c.where, connected: !!c.el?.isConnected })),
    get pressing() { return press && { frame: press.c.fid, where: press.c.where, dragging: press.moved }; },
  };
  window.__sfuiWindowCurvature = state;
  log('patched', { version: VERSION, opts: o });
  resend();
  queueSync();
  return `patched (default ${o.default}, max ${o.max}, step ${o.step}, snap ±${o.snap} at ${o.snapPoints.join('/')}, ` +
    `haptics ${o.haptics ? 'on' : 'off'})`;
})
