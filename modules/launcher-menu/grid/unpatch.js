// Reverts grid/patch.js (markers, stylesheets, observers, timer): the "+"
// menu is a stock list again. Safe when not patched.
(() => {
  const st = window.__sfuiLauncherGrid;
  if (!st) return 'not patched';
  st.stop();
  return 'unpatched';
})()
