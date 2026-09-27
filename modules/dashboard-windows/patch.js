// dashboard-windows: resize and grab-distance limits of SteamVR dashboard
// windows (Steam, app windows, overlays, the theater screen, the dashboard
// itself). Target: SteamVR's dashboard page (vrwebhelper, DevTools
// 127.0.0.1:8087, title "systemui").
//
// This file is a function expression, called by the file lib/default.nix
// (mkPatch) generates: (<this file>)(find, sigs, opts, hooks), with find the
// finder library (lib/finders.js), sigs this patch's module signatures
// (lib/signatures.json, "dashboard-windows"), opts the options from
// dashboard-windows.nix (null = stock) and hooks the shared method hooks
// (lib/hooks.js), e.g. opts
//   { maxScale: 4.0,
//     distance: { world: {min: null, max: 10}, theater: {...}, dashboard: {...} } }
//
// How it works: systemui builds a scene graph from its DOM and sends it to
// vrcompositor through its mailbox WebSocket,
//   mailbox.SendMessage("vrcompositor_systemlayer", {type: "update_scene_graph", scene_graph})
// and vrcompositor enforces the limits it finds there:
// - "frame-resize-scale-min"/"-max" on every window frame (stock 0.25 / 2,
//   relative to the window's default size; the theater screen's default is
//   2.8x larger): range of the resize handle;
// - "min-distance"/"max-distance" (meters) on grab nodes: how close / far a
//   grabbed window can be pulled in / pushed back (thumbstick / scroll):
//     world     "grab-scale"     0.25 / 5  windows placed in the world
//     theater   "grab-transform" 1    / 6  the theater screen
//     dashboard "grab-transform" 0.3  / 4  the dashboard itself
//   (the keyboard's grab-transform, 0.2 / 1, is left alone).
// These are constants/literals in systemui's bundle (not patchable at the
// source), so this patch hooks the mailbox class's SendMessage (on its
// prototype, which existing instances use; through lib/hooks.js, which
// window-curvature shares) and rewrites them in outgoing scene graphs (a
// fresh object per update, so editing it in place is safe).
// Grab nodes are identified by node type plus their exact stock values: after
// a SteamVR update that changes them, the distance rewrite is a no-op.
// Then systemui is asked for one scene-graph resend (its own debounced
// scheduler: rebuilds the unchanged graph, no visible UI change), so new
// limits apply immediately.
//
// State: window.__sfuiDashboardWindows (mailbox prototype, resend function,
// options id, per-kind rewrite counters in .hits). The hook is registered
// as NAME; unpatch.js removes it and resends the stock graph. (VERSION 2
// wrapped SendMessage itself and read the rewrite from the state's
// `rewrite`, which is never set any more, so a leftover wrapper is inert; the
// hooks library unwinds one still on top.)
// The mailbox class and the scheduler are found by signature, not by
// webpack module id or minified export name; if one doesn't match, the patch
// returns an error and changes nothing. Idempotent: same VERSION and options
// -> "unchanged"; otherwise the rewrite is replaced in place.
((find, sigs, opts, hooks) => {
  const NAME = 'dashboard-windows';
  const VERSION = 3;
  const GRAB = {
    world: { type: 'grab-scale', min: 0.25, max: 5 },
    theater: { type: 'grab-transform', min: 1, max: 6 },
    dashboard: { type: 'grab-transform', min: 0.3, max: 4 },
  };

  const maxScale = opts?.maxScale ?? null;
  if (maxScale !== null && !(maxScale > 0)) return `invalid maxScale ${maxScale}`;
  const rules = [];
  for (const [kind, stock] of Object.entries(GRAB)) {
    const o = opts?.distance?.[kind] ?? {};
    const min = o.min ?? stock.min, max = o.max ?? stock.max;
    if (!(min > 0 && max >= min)) return `invalid ${kind} distance range ${min}-${max}`;
    if (min !== stock.min || max !== stock.max) rules.push({ kind, ...stock, newMin: min, newMax: max });
  }
  const id = JSON.stringify([VERSION, maxScale, rules]);

  let st = window.__sfuiDashboardWindows;
  if (!st?.proto) {
    let mods;
    try {
      mods = find.resolveAll(find.getWebpackRequire('webpackChunkvrwebui'), sigs);
    } catch (e) {
      return `signature not found, dashboard left unpatched: ${e.message}`;
    }
    // Mailbox: SendMessage(target, msg) -> WebSocketSend("mailbox_send ...").
    // resend: debounced "send the scene graph again" (0 args, NextSGID(), setTimeout).
    st = window.__sfuiDashboardWindows = {
      proto: mods.mailbox.exports.Mailbox.prototype, resend: mods.sceneGraph.exports.resend,
      id: null, hits: {},
    };
  }
  delete st.rewrite;                              // VERSION 2's wrapper reads it: keep that inert

  const active = maxScale !== null || rules.length > 0;
  if (st.version === VERSION && st.id === id && active === hooks.has(st.proto, 'SendMessage', NAME)) return 'unchanged';

  const hits = st.hits = {};
  const hit = (k) => { hits[k] = (hits[k] ?? 0) + 1; };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const p = n.properties;
    if (p) {
      if (maxScale !== null && typeof p['frame-resize-scale-max'] === 'number') {
        // Never below the frame's own minimum.
        p['frame-resize-scale-max'] = Math.max(maxScale, p['frame-resize-scale-min'] ?? 0);
        hit('scale');
      }
      if (typeof p['max-distance'] === 'number') {
        const r = rules.find((r) => r.type === n.type && r.min === p['min-distance'] && r.max === p['max-distance']);
        if (r) { p['min-distance'] = r.newMin; p['max-distance'] = r.newMax; hit(r.kind); }
      }
    }
    if (n.children) walk(n.children);
  };
  st.version = VERSION;
  st.id = id;
  if (active) {
    hooks.before(st.proto, 'SendMessage', NAME, (args) => {
      const msg = args[1];
      if (msg?.type === 'update_scene_graph') walk(msg.scene_graph);
    });
  } else {
    hooks.remove(st.proto, 'SendMessage', NAME);
  }
  try { st.resend(); } catch { /* applies with the next scene-graph update */ }

  const desc = [
    ...(maxScale !== null ? [`max scale ${maxScale}`] : []),
    ...rules.map((r) => `${r.kind} ${r.newMin}-${r.newMax} m`),
  ].join(', ') || 'all stock';
  return `patched (${desc})`;
})
