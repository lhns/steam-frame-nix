// Reverts window-curvature/patch.js: removes the control from open menus,
// its style, reactions and SendMessage hook (the shared wrapper goes too once
// no other patch uses it) and resends the scene graph, so windows get the
// stock curve radius back. Curvature on/off is stock state and stays as it
// is. window.__sfuiWindowCurvatureState (per-window values) is kept for a
// re-injection. Safe when not patched.
(() => {
  const s = window.__sfuiWindowCurvature;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
