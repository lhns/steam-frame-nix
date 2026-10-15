// Reverts patch.js (icon colour, listeners, observer, timer, pending relay
// calls): the room-view button is a stock toggle again. Safe when not
// patched.
(() => {
  const st = window.__sfuiPassthrough;
  if (!st) return 'not patched';
  st.stop();
  return 'unpatched';
})()
