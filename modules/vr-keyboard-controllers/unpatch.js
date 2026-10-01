// Reverts bridge-patch.js in SteamVR's systemui page: stops the loops (a last
// { keyboard: null } frame) and removes the keyboard probe transform. Safe
// when nothing is patched.
(() => {
  const S = window.__sfuiCtl;
  if (!S) return 'not patched';
  try { S.dispose?.(); } catch { /* gone */ }
  delete window.__sfuiCtl;
  return 'unpatched';
})()
