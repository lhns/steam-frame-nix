// Reverts panel.js in SteamVR's systemui page: removes the strip panel, its
// embedded-UV slot and stylesheet. Safe when nothing is patched.
(() => {
  const S = window.__sfuiKbdStrip;
  if (!S) return 'not patched';
  try { S.dispose?.(); } catch { /* gone */ }
  delete window.__sfuiKbdStrip;
  return 'unpatched';
})()
