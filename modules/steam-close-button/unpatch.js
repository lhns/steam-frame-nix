// Reverts steam-close-button/patch.js (the X disappears). Never switches
// frames and keeps window.__sfuiSteamCloseState (Steam hidden, bar-only), so
// a re-injection continues; restores the Dashboard methods and mailbox
// handlers it wrapped. If removed while bar-only, the dashboard stays without
// an active frame until the next tab click or open. Safe when not patched.
(() => {
  const s = window.__sfuiSteamClose;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
