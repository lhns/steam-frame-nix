// Reverts dashboard-windows/patch.js: removes its SendMessage hook (and a
// VERSION 2 own wrapper if on top) and resends the scene graph so the stock
// limits apply at once. Safe when not patched.
(() => {
  const NAME = 'dashboard-windows';
  const st = window.__sfuiDashboardWindows;
  if (!st) return 'not patched';
  delete window.__sfuiDashboardWindows;
  window.__sfuiHooks?.remove(st.proto, 'SendMessage', NAME);
  const f = st.proto.SendMessage;
  if (f?.__sfuiPatch === NAME) st.proto.SendMessage = f.__sfuiOrig;
  try { st.resend?.(); } catch { /* ignore */ }
  return 'unpatched';
})()
