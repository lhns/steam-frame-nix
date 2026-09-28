// Reverts frame-controls/patch.js: ends a long press, closes the popup, restores
// stock control lists, removes wrappers (a wrapper wrapped by something else
// since stays inert in the chain), listeners, style and the theater Float
// actions. Keeps window.__sfuiFrameControlsState and the saved state file.
// Safe when not patched.
(() => {
  const s = window.__sfuiFrameControls;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
