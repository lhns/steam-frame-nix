// launcher-menu show-all: the VR dashboard's "+" menu lists all programs
// without Steam's Developer Mode.
// Steam filters the programs of ScanForInstalledNonSteamApps() by the base
// name of their executable: some are always hidden (steam, vrurlhandler),
// and without Developer Mode (client setting developer_mode_enabled) also a
// second list: firewall-config, vlc, dolphin, cmake-gui, plasma-discover,
// konsole, systemsettings, qrenderdoc, sh, lxterminal. The menu's filter
// spreads that list into its block list only when Developer Mode is off
// (`bDevMode || block.push(...devModeOnly)`), and nothing else uses it.
//
// This file is a function expression, called by the file lib/default.nix
// (mkPatch) generates: (<this file>)(find, sigs), with find the finder
// library (lib/finders.js) and sigs this patch's module signatures
// (lib/signatures.json, "launcher-menu-show-all": the module exporting the
// list, plus a check-only anchor for the filter). No options.
//
// The patch gives that one array an own, empty Symbol.iterator, so spreading
// it adds nothing; its contents stay as they are (the signature keeps
// matching on re-injection) and the Developer Mode setting itself, used
// elsewhere (settings pages, controller pairing, ...), is not touched. The
// menu re-filters whenever it rescans, i.e. on every open. The array is
// remembered as window.__sfuiShowAllApps for unpatch.js. Idempotent.
((find, sigs) => {
  const VERSION = 1;
  let mods;
  try {
    mods = find.resolveAll(find.getWebpackRequire('webpackChunksteamui'), sigs);
  } catch (e) {
    return `signature not found, Steam left unpatched: ${e.message}`;
  }
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
