// Reverts dashboard-windows/patch.js: removes its SendMessage hook (the
// shared wrapper goes too once no other patch uses it) and resends the scene
// graph, so vrcompositor gets the stock limits again right away. Also
// restores the mailbox SendMessage if VERSION 2's own wrapper is on top.
// Safe when not patched.
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
