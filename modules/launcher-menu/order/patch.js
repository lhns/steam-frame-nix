// order: sorts the VR dashboard's "+" menu alphabetically (case-insensitive),
// Desktop included. Steam shows ScanForInstalledNonSteamApps() in GLib
// hash-table order and looks the function up at call time, so wrapping it in
// SharedJSContext suffices. Original kept as __sfuiOrig for unpatch.js; bump
// VERSION on changes.
(() => {
  const VERSION = 3;
  const NAME = 'launcher-menu-order';
  const Apps = window.SteamClient?.Apps;
  const cur = Apps?.ScanForInstalledNonSteamApps;
  if (typeof cur !== 'function') return 'SteamClient.Apps.ScanForInstalledNonSteamApps missing';
  if (cur.__sfuiPatch === NAME && cur.__sfuiVersion === VERSION) return 'unchanged';
  const orig = cur.__sfuiPatch === NAME ? cur.__sfuiOrig : cur;

  const name = (a) => String(a?.strAppName ?? '');
  const sort = (list) => Array.isArray(list)
    ? [...list].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }))
    : list;
  const f = function ScanForInstalledNonSteamApps(...args) {
    return Promise.resolve(orig.apply(this, args)).then(sort);
  };
  f.__sfuiPatch = NAME; f.__sfuiVersion = VERSION; f.__sfuiOrig = orig;
  Apps.ScanForInstalledNonSteamApps = f;
  return 'patched';
})()
