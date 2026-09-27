// launcher-menu order: sorts the VR dashboard's "+" menu (non-Steam programs)
// alphabetically (case-insensitive), Desktop included.
// Steam renders SteamClient.Apps.ScanForInstalledNonSteamApps() in the order
// it returns (GLib hash-table order, i.e. random-ish); its hook looks the
// function up at call time, so wrapping it here in SharedJSContext is enough.
// The original is kept as __sfuiOrig (unpatch.js restores it). Idempotent;
// bump VERSION when changing the wrapper.
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
