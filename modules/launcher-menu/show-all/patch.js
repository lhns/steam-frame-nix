// show-all: the VR dashboard's "+" menu lists all programs without Steam's
// Developer Mode.
// mkPatch patch (see steam-ui-patches/lib/default.nix); no opts; sigs:
// "launcher-menu-show-all" (the module exporting the list, plus a check-only
// anchor for the filter).
//
// Steam hides some executables always (steam, vrurlhandler) and, without
// Developer Mode, a second list (firewall-config, vlc, dolphin, cmake-gui,
// plasma-discover, konsole, systemsettings, qrenderdoc, sh, lxterminal) via
// `bDevMode || block.push(...devModeOnly)`; nothing else uses that array.
// The patch gives it an own, empty Symbol.iterator, so spreading adds
// nothing while its contents (and the signature) stay intact and the setting
// itself is untouched. Remembered as window.__sfuiShowAllApps for unpatch.js.
((find, sigs) => {
  const VERSION = 2;
  const mods = find.resolvePatch('webpackChunksteamui', sigs);
  if (typeof mods === 'string') return mods;
  const list = mods.devModeApps.exports.devModeOnly;
  if (!Array.isArray(list)) return 'Developer Mode app list is not an array, Steam left unpatched';
  const prev = window.__sfuiShowAllApps;
  if (prev && prev.list === list && prev.version === VERSION &&
      Object.prototype.hasOwnProperty.call(list, Symbol.iterator)) return 'unchanged';
  Object.defineProperty(list, Symbol.iterator, {
    configurable: true, writable: true, enumerable: false,
    value: function* sfuiShowAllApps() {},
  });
  window.__sfuiShowAllApps = { version: VERSION, list };
  return `patched (no longer hidden: ${Array.prototype.join.call(list, ', ')})`;
})
