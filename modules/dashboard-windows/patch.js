// dashboard-windows: resize and grab-distance limits of SteamVR dashboard
// windows (Steam, app windows, overlays, theater screen, the dashboard).
// Target: SteamVR dashboard (vrwebhelper, DevTools 127.0.0.1:8087, title
// "systemui"). mkPatch patch (see steam-ui-patches/lib/default.nix); opts
// (null = stock):
//   { maxScale: 4.0,
//     distance: { world: {min: null, max: 10}, theater: {...}, dashboard: {...} } }
//
// systemui sends its scene graph to vrcompositor via
//   mailbox.SendMessage("vrcompositor_systemlayer", {type: "update_scene_graph", scene_graph})
// and vrcompositor enforces the limits in it:
// - "frame-resize-scale-min"/"-max" on window frames (stock 0.25 / 2, relative
//   to the default size; the theater's default is 2.8x larger);
// - "min-distance"/"max-distance" (m) on grab nodes (pull in / push back):
//     world     "grab-scale"     0.25 / 5  windows placed in the world
//     theater   "grab-transform" 1    / 6  the theater screen
//     dashboard "grab-transform" 0.3  / 4  the dashboard itself
//   (the keyboard's grab-transform, 0.2 / 1, is left alone).
// They are literals in systemui's bundle, so SendMessage is hooked on the
// mailbox prototype (steam-ui-patches/lib/hooks.js, shared with
// window-curvature) and outgoing scene graphs (fresh objects per update) are
// edited in place. Grab nodes are
// matched by type plus exact stock values, so if SteamVR changes them the
// distance rewrite becomes a no-op. A scene-graph resend (systemui's debounced
// scheduler) applies new limits at once.
//
// State: window.__sfuiDashboardWindows (proto, resend, options id, counters in
// .hits); hook name NAME. Signature mismatch -> error, nothing changed. Same
// VERSION and options -> "unchanged", else the rewrite is replaced in place.
((find, sigs, opts, hooks) => {
  const NAME = 'dashboard-windows';
  const VERSION = 4;
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
    const mods = find.resolvePatch('webpackChunkvrwebui', sigs);
    if (typeof mods === 'string') return mods;
    // Mailbox: SendMessage(target, msg) -> WebSocketSend("mailbox_send ...").
    // resend: debounced "send the scene graph again" (0 args, NextSGID(), setTimeout).
    st = window.__sfuiDashboardWindows = {
      proto: mods.mailbox.exports.Mailbox.prototype, resend: mods.sceneGraph.exports.resend,
      id: null, hits: {},
    };
  }

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
