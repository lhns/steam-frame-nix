// Reverts steam-close-button/patch.js: removes its overrides, reactions and
// markers (the X disappears). Teardown only: it never switches frames and
// leaves window.__sfuiSteamCloseState (bar-only flag etc.) in place, so a
// re-injection (service restart, switch) continues where it left off; if the
// patch is gone for good while bar-only, the dashboard just stays without an
// active frame until the next tab click or dashboard open. Safe when not
// patched.
(() => {
  const s = window.__sfuiSteamClose;
  if (!s) return 'not patched';
  s.teardown();
  return 'unpatched';
})()
