// Reverts order/patch.js (restores the original
// SteamClient.Apps.ScanForInstalledNonSteamApps). Safe when not patched.
(() => {
  const Apps = window.SteamClient?.Apps;
  const f = Apps?.ScanForInstalledNonSteamApps;
  if (f?.__sfuiPatch !== 'launcher-menu-order') return 'not patched';
  Apps.ScanForInstalledNonSteamApps = f.__sfuiOrig;
  return 'unpatched';
})()
