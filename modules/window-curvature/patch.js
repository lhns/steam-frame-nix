// window-curvature: adjustable curvature per SteamVR dashboard window. The
// "Toggle Curvature" row of a window's More Options (three-dot) menu becomes
// the control: click toggles (curved -> flat, flat -> stock curve), dragging
// up/down with the laser sets the curvature live; the value is shown on the
// right of the row.
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
// Debugging: window.__sfuiWindowCurvature: dump() (per frame: dock, on/off,
// stored/applied value, distances), hits (scene-graph rewrite counters),
// log (last events, also in the state), setValue(frameID, v).
((find, sigs, opts, hooks) => {
  const NAME = 'window-curvature';
  const VERSION = 10;
  const FLAT = 999;                               // origin distances >= this are "flat"
  const ICON_OFF = 40, ICON_ON = 39;              // Toggle Curvature action icons (sigs.curvatureAction)

  const o = { default: 1, max: 3, step: 0.05, snap: 0.15, snapPoints: [0, 1], dragThreshold: 8, dragPixelsPerUnit: 60, ...opts };
  if (!(o.max > 0 && o.step > 0 && o.step <= o.max && o.default >= 0 && o.default <= o.max && o.snap >= 0 &&
      Array.isArray(o.snapPoints) && o.snapPoints.every((p) => p >= 0 && p <= o.max) &&
      o.dragThreshold >= 0 && o.dragPixelsPerUnit > 0)) return `invalid options ${JSON.stringify(opts)}`;
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
  const hits = { sends: 0, origins: 0, scaled: 0 };

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

  // Sets the shown value of a frame: 0 = curvature off, > 0 = on with that
  // strength. On/off goes through the stock ToggleCurvature (what the row's
  // stock click invokes), so Steam's state and the row icon match. Going to
  // 0 forgets the window's value (turning it on again, e.g. by docking it in
  // the dashboard, uses the default).
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
  // The whole Toggle Curvature row is the control; the value is shown on its
  // right with small arrows above/below (only where the value can go).
  const STYLE_ID = 'sfui-window-curvature-style';
  const ROW = `.${CLS.row}`;
  const CSS = `
${ROW}:has(> .sfui-curv-ind) { cursor: ns-resize; }
${ROW}:has(> .sfui-curv-ind.sfui-dragging) { background: var(--gamepadui-grey) !important; }
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
  // curvature icons. Its row is found by position among the menu's rows,
  // checked against (else looked up by) the action's label.
  const isCurvatureAction = (a) => {
    const p = a?.partialParams;
    return p?.invocation === 2 && p?.icon?.enum === ICON_OFF && p?.icon_active?.enum === ICON_ON;
  };
  const panelOf = (fid) => document.getElementById(`legacy-frame-controls-additional-options-${fid}`);
  const curvatureRow = (f, panel) => {
    const rows = [...panel.querySelectorAll(ROW)];
    const items = (f.controlAdditionalOptionsItems ?? []).filter((i) => i.type === 2);
    const idx = items.findIndex((i) => isCurvatureAction(actions.GetAction(i.action_id)));
    if (idx < 0) return { why: 'no curvature action' };
    const label = actions.GetAction(items[idx].action_id).protoForSteam?.display_name;
    const text = (r) => r.querySelector(`.${CLS.label}`)?.textContent;
    let row = rows.length === items.length ? rows[idx] : null;
    if (!row || (label && text(row) !== label)) row = rows.find((r) => label && text(r) === label) ?? null;
    return row ? { row } : { why: `row not found (${rows.length} rows, ${items.length} items)` };
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
  const renderInd = (ind, v) => {
    const [up, num, dn] = ind.children;
    up.textContent = v < o.max ? '▲' : '';
    num.textContent = fmt(v);
    dn.textContent = v > 0 ? '▼' : '';
    if (ind.isConnected && !num.style.getPropertyValue('--sfui-curv-dy'))
      num.style.setProperty('--sfui-curv-dy', `${inkShift(num).toFixed(2)}px`);
  };

  const controls = new Map();                     // frameID -> { ind, row, panel, mo, attach, detach, endDrag }
  function updateUI(f) {
    const c = controls.get(f.frameID);
    if (c?.ind.isConnected) renderInd(c.ind, shown(f));
  }

  // Row control of one frame. Every press/click on the row is stopped at the
  // row, so React (listening at the root) never runs the stock onClick; the
  // click is re-implemented on mouseup when the press never became a drag.
  // Drag: vertical and relative (the cylinder bends horizontally, so the
  // pointer's y on the panel barely moves while the curvature changes). A
  // press becomes a drag after dragThreshold px (then re-based, so there is no
  // jump); the value follows at dragPixelsPerUnit px per 1.0 (the laser's
  // position stops at the menu panel's edge, so the whole range has to fit
  // into the room above/below the row), see dragValue.
  const stop = (e) => e.stopPropagation();
  const STOPPED = ['click', 'dblclick', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu'];
  const buildControl = (fid) => {
    const frame = () => FS.GetFrame(fid);
    const ind = document.createElement('div');
    ind.className = 'sfui-curv-ind';
    for (const c of ['sfui-curv-up', 'sfui-curv-v', 'sfui-curv-dn']) {
      const d = document.createElement('div'); d.className = c; ind.appendChild(d);
    }

    let drag = null;                              // { y0, v0, moved }
    const onMove = (e) => {
      const d = drag, f = frame();
      if (!d || !f) return;
      if (!d.moved) {
        if (Math.abs(e.clientY - d.y0) < o.dragThreshold) return;
        d.moved = true; d.y0 = e.clientY;
        ind.classList.add('sfui-dragging');
        return;
      }
      const v = dragValue(d.v0 + (d.y0 - e.clientY) / o.dragPixelsPerUnit, shown(f));
      if (v !== null) setValue(f, v, 'drag');
    };
    const onUp = (e) => {
      const d = drag;
      if (!d) return;
      drag = null;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      ind.classList.remove('sfui-dragging');
      const f = frame();
      if (!d.moved && f && e) setValue(f, curved(f) ? 0 : 1, 'click');   // curved -> flat, flat -> stock
    };
    const onDown = (e) => {
      e.stopPropagation(); e.preventDefault();
      const f = frame();
      if (e.button !== 0 || drag || !f) return;
      drag = { y0: e.clientY, v0: shown(f), moved: false };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    };
    const attach = (row) => {
      row.addEventListener('mousedown', onDown);
      for (const t of STOPPED) row.addEventListener(t, stop);
    };
    const detach = (row) => {
      row.removeEventListener('mousedown', onDown);
      for (const t of STOPPED) row.removeEventListener(t, stop);
    };
    return { ind, attach, detach, endDrag: () => onUp(null) };
  };

  const inject = (f) => {
    const fid = f.frameID;
    const panel = panelOf(fid);
    if (!panel) return 'no panel';
    let c = controls.get(fid);
    if (c && c.panel !== panel) { removeControl(fid); c = null; }
    if (c?.ind.isConnected && c.row?.contains(c.ind)) { renderInd(c.ind, shown(f)); return 'ok'; }
    const r = curvatureRow(f, panel);
    if (!r.row) { log('inject failed', { frame: fid, why: r.why }); return r.why; }
    ensureStyle();
    if (!c) {
      const b = buildControl(fid);
      const mo = new MutationObserver(() => { if (!b.ind.isConnected || !b.ind.parentElement?.matches(ROW)) queueSync(); });
      mo.observe(panel, { childList: true, subtree: true });
      c = { ...b, panel, mo, row: null };
      controls.set(fid, c);
    }
    if (c.row !== r.row) {
      if (c.row) c.detach(c.row);
      c.row = r.row;
      c.attach(r.row);
    }
    r.row.append(c.ind);
    renderInd(c.ind, shown(f));
    return 'ok';
  };

  function removeControl(fid) {
    const c = controls.get(fid);
    if (!c) return;
    c.mo.disconnect(); c.endDrag();
    if (c.row) c.detach(c.row);
    c.ind.remove();
    controls.delete(fid);
  }

  // Open menus: inject (retrying until React has rendered the panel).
  const openFrames = () => FS.frames.filter((f) => f.isControlAdditionalOptionsOpen);
  let syncTimer = null, retries = 0;
  const sync = () => {
    syncTimer = null;
    const open = openFrames();
    for (const fid of [...controls.keys()]) if (!open.some((f) => f.frameID === fid)) removeControl(fid);
    let pending = false;
    for (const f of open) if (inject(f) !== 'ok') pending = true;
    if (pending && retries < 12) { retries++; syncTimer = setTimeout(sync, 60 * retries); } else retries = 0;
  };
  function queueSync() { if (!syncTimer) syncTimer = setTimeout(sync, 0); }

  hooks.before(proto, 'SendMessage', NAME, hook);
  const disposers = [
    mx.reaction(
      () => FS.frames.map((f) => `${f.frameID}:${f.isControlAdditionalOptionsOpen ? 1 : 0}:${curved(f) ? 1 : 0}:${dockOf(f)}`).join(','),
      () => { retries = 0; queueSync(); for (const f of FS.frames) updateUI(f); },
    ),
    mx.reaction(() => DS.curvatureDistance, () => resend()),
  ];

  const teardown = () => {
    for (const d of disposers.splice(0)) d();
    clearTimeout(syncTimer); clearTimeout(resendTimer);
    for (const fid of [...controls.keys()]) removeControl(fid);
    document.getElementById(STYLE_ID)?.remove();
    hooks.remove(proto, 'SendMessage', NAME);
    if (window.__sfuiWindowCurvature === state) delete window.__sfuiWindowCurvature;
    try { resendStock(); } catch { /* applies with the next scene-graph update */ }
  };
  const check = () => {
    if (!hooks.has(proto, 'SendMessage', NAME)) hooks.before(proto, 'SendMessage', NAME, hook);
    if (openFrames().length) queueSync();
    return 'unchanged';
  };
  const dump = () => FS.frames.map((f) => ({
    frame: f.frameID, title: f.title, key: keyOf(f), dock: dockOf(f), curved: curved(f),
    override: curvatureOf(f)?.m_bCurveOverride, stored: S.values[keyOf(f)], shown: shown(f),
    stockDistance: curvatureOf(f)?.curvatureOriginDistance,
    appliedDistance: curved(f) ? DS.curvatureDistance / strength(f) : null,
    menuOpen: f.isControlAdditionalOptionsOpen, control: !!controls.get(f.frameID)?.ind.isConnected,
  }));
  const state = {
    version: VERSION, id, opts: o, hits, log: logBuf, state: S, teardown, check, dump, dragValue,
    setValue: (fid, v) => { const f = FS.GetFrame(fid); if (f) setValue(f, v, 'api'); return f ? shown(f) : 'no frame'; },
  };
  window.__sfuiWindowCurvature = state;
  log('patched', { version: VERSION, opts: o });
  resend();
  queueSync();
  return `patched (default ${o.default}, max ${o.max}, step ${o.step}, snap ±${o.snap} at ${o.snapPoints.join('/')})`;
})
