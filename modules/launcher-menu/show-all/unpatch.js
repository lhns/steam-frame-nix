// Reverts show-all/patch.js (removes the empty iterator). Safe when not
// patched.
(() => {
  const s = window.__sfuiShowAllApps;
  if (!s) return 'not patched';
  if (s.list && Object.prototype.hasOwnProperty.call(s.list, Symbol.iterator)) delete s.list[Symbol.iterator];
  delete window.__sfuiShowAllApps;
  return 'unpatched';
})()
