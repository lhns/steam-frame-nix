// Removes the cat (systemui.js) from SteamVR's systemui page.
(() => {
  try { window.__sfuiPet?.dispose?.(); } catch { /* gone */ }
  delete window.__sfuiPet;
  return 'unpatched';
})()
