// Reverts pinned-desktop/patch.js (pinned blocks, CSS, markers, observers,
// timer). Safe when not patched.
(() => {
  const st = window.__sfuiPinnedDesktop;
  if (!st) return 'not patched';
  st.stop();
  return 'unpatched';
})()
