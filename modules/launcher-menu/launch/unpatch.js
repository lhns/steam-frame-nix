// Reverts launch/patch.js (restores the original
// SteamClient.Apps.LaunchNonSteamApp). Safe when not patched.
(() => {
  const Apps = window.SteamClient?.Apps;
  const f = Apps?.LaunchNonSteamApp;
  if (f?.__sfuiPatch !== 'launcher-menu-launch') return 'not patched';
  Apps.LaunchNonSteamApp = f.__sfuiOrig;
  return 'unpatched';
})()
