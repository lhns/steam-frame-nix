// Reverts dashboard-windows/patch.js: restores the mailbox SendMessage and
// resends the scene graph, so vrcompositor gets the stock limits again right
// away. If something else has wrapped SendMessage since, our wrapper stays in
// its chain but is inert (it looks the rewrite up in the removed state).
// Safe when not patched.
(() => {
  const NAME = 'dashboard-windows';
  const st = window.__sfuiDashboardWindows;
  if (!st) return 'not patched';
  delete window.__sfuiDashboardWindows;
  const f = st.proto.SendMessage;
  if (f?.__sfuiPatch === NAME) st.proto.SendMessage = f.__sfuiOrig;
  try { st.resend?.(); } catch { /* ignore */ }
  return 'unpatched';
})()
