// window-curvature: adjustable curvature per SteamVR dashboard window. The
// stock "Toggle Curvature" control becomes a wheel: in the More Options menu
// row (value shown on the right) and, if the control is in the bottom bar
// (e.g. via frame-controls), on that bar button (no value; steps and
// detents are felt as haptics). Click toggles (curved -> flat, flat -> stock
// curve); dragging up/down with the laser sets the curvature live.
//
// Target: SteamVR dashboard (vrwebhelper, DevTools 127.0.0.1:8087, title
// "systemui"). mkPatch patch (see lib/default.nix); opts: { initial, max,
// step, detentPixels, detentPoints, dragThresholdPixels, dragPixelsPerUnit,
// barDragPixelsPerUnit, haptics }.
//
// Stock curvature (frame.curvature, systemui's `curvature` component):
// shouldCurve = m_bCurveOverride (set by ToggleCurvature(), cleared on dock
// change) else curved when docked in the dashboard, theater per setting, flat
// elsewhere. The frame renders transform "frame:<id>:curvature-origin" at
// z = shouldCurve ? DashboardStore.curvatureDistance (dashboard distance +
// 1.8 m) : 1000; its panels reference it as "curvature-origin-id" and
// vrcompositor bends them onto a cylinder around it (curvature = 1/radius).
// Those MobX properties are non-configurable, so this patch hooks the mailbox
// SendMessage (lib/hooks.js, shared with dashboard-windows) and rewrites the
// origin's z in outgoing scene graphs to stock / value (1 = stock, 2 = half
// the radius, 0 = flat = stock toggle off). On/off stays the stock state, so
// stock toggle and wheel always agree.
//
// Values per window (key: first overlay key) in
// window.__sfuiWindowCurvatureState (schema 1: { values, log }); kept across
// re-patch and unpatch, not across a dashboard reload. Without a stored value:
// opts.initial in the world or on a hand, 1 when docked in the dashboard or
// theater (so the Steam window stays concentric with the dashboard bar).
//
// Bar button: the bar panel (#legacy-frame-controls-<frameID>) is one button
// high, but while the trigger is held SteamVR keeps sending the pressed
// panel's coordinates past its edge, so the drag uses them as they come. The
// bar panel is never resized or moved (padding it made it flicker: size and
// origin reach the compositor at different times).
//
// Dragging: value = start value + drag distance / px per unit, rounded to
// step. Detent points hold in drag distance: the value stays there for
// opts.detentPixels of travel, then continues, so no value is skipped.
//
// Haptics (opts.haptics): VROverlay.TriggerOverlayHapticEffect with stock
// EOverlayHapticEffect values: SlidingEdge at 0/max, Snap at detent points,
// Sliding per step (at most every 30 ms). During a drag the dashboard's own
// haptics (hover clicks on buttons the laser passes) are muted.
//
// Contract with other patches (e.g. frame-controls' long press); this patch
// owns press-and-drag on its controls:
//   - Every element it drives has the class `sfui-curv-ctl`.
//   - When a press becomes a drag (opts.dragThresholdPixels px vertical) it
//     dispatches a bubbling CustomEvent `sfui-curv-dragstart` on the element
//     (detail { frameID, where: 'menu' | 'bar' }); when that drag ends
//     (release or cancelPress), `sfui-curv-dragend`.
//   - window.__sfuiWindowCurvature.cancelPress() ends the current press
//     without its click (a drag keeps its value); returns whether a press
//     was active.
// A patch with its own gesture on these elements lets mousemove through while
// undecided, drops its gesture on `sfui-curv-dragstart`, and calls
// cancelPress() when it takes the press over. Neither side reads the other's
// thresholds or restores the other's state.
//
// Debugging: window.__sfuiWindowCurvature: dump(), hits (rewrite/haptic
// counters), log, setValue(frameID, v), controls(), cancelPress(),
// dragValue(v0, dy, ppu, cur).
((find, sigs, opts, hooks) => {
  const NAME = 'window-curvature';
  const VERSION = 19;
  const FLAT = 999;                               // origin distances >= this are "flat"
  const ICON_OFF = 40, ICON_ON = 39;              // Toggle Curvature action icons (sigs.curvatureAction)
  const HAPTIC = { Snap: 3, Sliding: 4, SlidingEdge: 5 };   // EOverlayHapticEffect (sigs.hapticEffects)

  const o = {
    initial: 1, max: 3, step: 0.05, detentPixels: 24, detentPoints: [0, 1], dragThresholdPixels: 8, dragPixelsPerUnit: 120,
    barDragPixelsPerUnit: 60, haptics: true, ...opts,
  };
  if (!(o.max > 0 && o.step > 0 && o.step <= o.max && o.initial >= 0 && o.initial <= o.max && o.detentPixels >= 0 &&
      Array.isArray(o.detentPoints) && o.detentPoints.every((p) => p >= 0 && p <= o.max) &&
      o.dragThresholdPixels >= 0 && o.dragPixelsPerUnit > 0 && o.barDragPixelsPerUnit > 0 &&
      typeof o.haptics === 'boolean'))
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
  const hits = { sends: 0, origins: 0, scaled: 0, haptics: 0 };

  // ---- values ------------------------------------------------------------------------
  const round = (v) => +(Math.round(v / o.step) * o.step).toFixed(6);
  const clamp = (v) => Math.min(o.max, Math.max(0, v));
  const fmt = (v) => (v <= 0 ? '0' : v.toFixed(o.step < 0.1 ? 2 : 1));
  const curvatureOf = (f) => (f?.curvature instanceof Curvature ? f.curvature : null);
  const keyOf = (f) => f.associatedSummonOverlayKeys?.[0] ?? `frame:${f.frameID}`;
  const dockOf = (f) => f.docking?.visualDockLocation ?? f.docking?.dockLocation;
  const strength = (f) => S.values[keyOf(f)] ??
    ([DOCK.LeftHand, DOCK.RightHand, DOCK.World].includes(dockOf(f)) ? o.initial : 1);
  const curved = (f) => !!curvatureOf(f)?.shouldCurve;
  const shown = (f) => (curved(f) ? strength(f) : 0);

  // Value for a drag of dy px (up = positive) from v0 at ppu px per unit, or
  // null to keep cur. Detent points hold in drag distance: reaching one
  // (or starting on it) holds the value there for detentPixels of travel,
  // then it continues from the point, so no values are skipped. Off a point
  // the value is rounded to step; a change of less than 0.6 steps away from
  // cur is ignored (laser jitter at a step boundary).
  const dragValue = (v0, dy, ppu, cur) => {
    const dir = Math.sign(dy);
    let v = v0, rest = Math.abs(dy), held = null;
    const points = o.detentPoints.filter((p) => (dir > 0 ? p >= v0 : p <= v0)).sort((a, b) => dir * (a - b));
    for (const p of points) {
      const dist = Math.abs(p - v) * ppu;
      if (rest <= dist) break;
      rest -= dist; v = p;
      if (rest <= o.detentPixels) { held = p; rest = 0; break; }
      rest -= o.detentPixels;
    }
    const target = held ?? v + dir * rest / ppu;
    const nv = clamp(held ?? round(target));
    if (nv === cur || (held === null && Math.abs(target - cur) < o.step * 0.6)) return null;
    return nv;
  };

  // ---- haptics -------------------------------------------------------------------------
  // While a drag runs, the dashboard's own haptics (a click whenever the laser
  // enters a button, e.g. menu rows the drag passes over) are muted, so only
  // the value's ticks and detents are felt. The stock function is wrapped
  // once (restored by teardown); our ticks call the original.
  let lastHaptic = -Infinity, muteStock = false;
  const ov = window.VRHTML?.VROverlay;
  const stockHaptic = typeof ov?.TriggerOverlayHapticEffect === 'function'
    ? (ov.TriggerOverlayHapticEffect.__sfuiCurvOrig ?? ov.TriggerOverlayHapticEffect) : null;
  if (stockHaptic) {
    const wrapped = function (...a) { if (!muteStock) return stockHaptic.apply(this, a); };
    wrapped.__sfuiCurvOrig = stockHaptic;
    ov.TriggerOverlayHapticEffect = wrapped;
  }
  const haptic = (effect) => {
    if (!o.haptics || !stockHaptic || typeof ov.ThisOverlayHandle !== 'function') return;
    const now = performance.now();
    if (effect === HAPTIC.Sliding && now - lastHaptic < 30) return;
    lastHaptic = now;
    try { stockHaptic.call(ov, ov.ThisOverlayHandle(), effect); hits.haptics++; } catch (e) { log('haptic failed', String(e)); }
  };
  const hapticFor = (v) => haptic(v <= 0 || v >= o.max ? HAPTIC.SlidingEdge
    : o.detentPoints.includes(v) ? HAPTIC.Snap : HAPTIC.Sliding);

  // ---- scene graph ---------------------------------------------------------------------
  // Origin node ids may carry a "<prefix>::" (sub-scene); match the suffix.
  const rewrite = (sg) => {
    const byOrigin = new Map();
    for (const f of FS.frames) {
      const c = curvatureOf(f);
      if (c?.shouldCurve) byOrigin.set(c.curvatureTransformOriginID, f);
    }
    if (!byOrigin.size) return;
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

  // 0 = off, > 0 = on with that strength. On/off via stock ToggleCurvature so
  // Steam's state and icon match. 0 forgets the stored value.
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

  // Toggle Curvature action: invocation 2 with the curvature icons. Menu row:
  // by position, verified (else found) by label; bar button: by React
  // `control` prop.
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

  // Digits have no descenders, so translateY(-50%) centres them too high;
  // shift by the measured ink offset (canvas measureText) to centre them
  // optically between the arrows. (Steam's Chromium lacks text-box-trim.)
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
  // Presses/clicks are stopped at the element so React (root listener) never
  // runs the stock onClick; a press that never became a drag is a click on
  // mouseup. Drag is vertical and relative (the cylinder bends horizontally,
  // so y barely moves as curvature changes); after dragThresholdPixels px it
  // re-bases (no jump). One press at a time, window capture listeners.
  const stop = (e) => e.stopPropagation();
  const STOPPED = ['click', 'dblclick', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu'];
  let press = null;                               // { c, y0, v0, last, moved }

  const emit = (c, type) => {
    try {
      c.el?.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { frameID: c.fid, where: c.where } }));
    } catch (e) { log(`${type} listener failed`, String(e)); }
  };


  const onMove = (e) => {
    const p = press;
    if (!p) return;
    const f = FS.GetFrame(p.c.fid);
    if (!f) { endPress('frame gone'); return; }
    const y = e.clientY;
    p.last = y;
    if (!p.moved) {
      if (Math.abs(y - p.y0) < o.dragThresholdPixels) return;
      p.moved = true;
      muteStock = true;
      p.c.el?.classList.add('sfui-dragging');
      log('drag', { frame: p.c.fid, where: p.c.where });
      emit(p.c, 'sfui-curv-dragstart');
      if (press !== p) return;                    // a listener cancelled the press
      p.y0 = p.last;
      return;
    }
    const ppu = p.c.where === 'bar' ? o.barDragPixelsPerUnit : o.dragPixelsPerUnit;
    const v = dragValue(p.v0, p.y0 - y, ppu, shown(f));
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
    muteStock = false;
    if (!p) return false;
    press = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    p.c.el?.classList.remove('sfui-dragging');
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
    press = { c, y0: e.clientY, last: e.clientY, v0: shown(f), moved: false };
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

  // Inject into open menus and bars holding the curvature action, retrying
  // until React rendered them (bars only while visible: hidden frames have no
  // bar panel).
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
    if (stockHaptic && ov.TriggerOverlayHapticEffect?.__sfuiCurvOrig === stockHaptic) ov.TriggerOverlayHapticEffect = stockHaptic;
    for (const d of disposers.splice(0)) d();
    clearTimeout(syncTimer); clearTimeout(resendTimer);
    for (const key of [...controls.keys()]) removeControl(key);
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
  return `patched (initial ${o.initial}, max ${o.max}, step ${o.step}, detent ${o.detentPixels} px at ${o.detentPoints.join('/')}, ` +
    `haptics ${o.haptics ? 'on' : 'off'})`;
})
