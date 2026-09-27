// Reverts window-curvature/patch.js: ends a press, removes controls, style,
// reactions and the SendMessage hook, and resends the scene graph (stock
// radius back). Curvature on/off is stock state and stays.
// window.__sfuiWindowCurvatureState is kept. Safe when not patched.
(() => {
  const s = window.__sfuiWindowCurvature;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
