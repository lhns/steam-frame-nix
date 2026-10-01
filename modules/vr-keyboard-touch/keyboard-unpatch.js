// Reverts keyboard-patch.js in Steam's SharedJSContext: unsubscribes from the
// controller frames and ends its touches without typing. Safe when nothing is
// patched. (window.__sfuiControllers, shared with other consumers, stays.)
(() => {
  const S = window.__sfuiTouchType;
  if (!S) return 'not patched';
  try { S.dispose?.(); } catch { /* gone */ }
  delete window.__sfuiTouchType;
  return 'unpatched';
})()
