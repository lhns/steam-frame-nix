// Reverts dashboard-windows/patch.js: removes its SendMessage hook and
// resends the scene graph so the stock limits apply at once. Safe when not
// patched.
(() => {
  const st = window.__sfuiDashboardWindows;
  if (!st) return 'not patched';
  delete window.__sfuiDashboardWindows;
  window.__sfuiHooks?.remove(st.proto, 'SendMessage', 'dashboard-windows');
  try { st.resend?.(); } catch { /* ignore */ }
  return 'unpatched';
})()
