# Launcher menu: how it works

Technical details of the "+" menu features. What they do and how to
configure them: README, [launcher menu](../README.md#launcher-menu-launchermenu),
[hidden apps](../README.md#hidden-apps-launchermenuhiddenapps),
[icon fallbacks](../README.md#icon-fallbacks-launchermenuiconfallbacks).

## Menu patches

`launcherMenu.*` (module `launcher-menu`): [UI patches](ui-patches.md) in
Steam's `SharedJSContext` (`modules/launcher-menu/`), each registered only
when its option is set and reverted by its unpatch when unset (next switch):

- `order/`: sorts `ScanForInstalledNonSteamApps()` by name (Steam lists the
  programs in GLib hash-table order);
- `pinned-desktop/`: hides Desktop in the list and pins a proxy above/below
  it;
- `launch/`: wraps `LaunchNonSteamApp` (menu-only) to close the menu and/or
  debounce repeated launches;
- `grid/`: restyles Steam's own items as tiles, which is why launching,
  sounds and controller navigation keep working;
- `show-all/`: empties the list Steam hides without Developer Mode.

Their anchors (APIs, React props, CSS) are in `modules/lib/signatures.json`
and verified by the [offline checker](ui-patches.md#after-a-steam-update).

## Hidden apps

`launcherMenu.hiddenApps` (module `hidden-apps`): a Home Manager-linked
desktop entry with `Hidden=true` per id in `~/.local/share/applications`,
which masks the system entry of the same id for Steam and KDE alike.

## Icon fallbacks

`launcherMenu.iconFallbacks.*`: Home Manager links nixpkgs' Breeze SVGs
into `~/.local/share/icons/hicolor/scalable/apps/`. When the set of links
changes, the switch bumps the mtime of `~/.local/share/icons/hicolor`, so a
running Steam rescans (GTK only rereads a theme whose directory changed).
The switch's hints come from `icon-fallbacks.sh`.

**Migration:** until 2026-09 a script made these links on switch and listed
them in `~/.local/state/steam-frame-nix/icon-fallbacks`; the first switch
replaces them with Home Manager's and `steam-frame-nix-cleanup` removes the
rest.
