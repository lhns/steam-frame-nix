// Reverts frame-controls/patch.js: ends a running long press, closes the
// popup (and removes its scene-graph panel), gives every window its stock
// control lists back and removes its wrappers (Frame.prototype
// SetControlsItems / SetControlAdditionalOptionsOpen; a wrapper something
// else wrapped since stays in the chain but is inert), listeners, style and
// the Float actions it added to theater windows.
// window.__sfuiFrameControlsState (placements, log) and its localStorage
// mirror are kept for a re-injection. Safe when not patched.
(() => {
  const s = window.__sfuiFrameControls;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
