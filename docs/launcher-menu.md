# Launcher menu

`launcherMenu.*`: the VR dashboard's "+" menu (non-Steam programs), with
[hidden apps](#hidden-apps) and [icon fallbacks](#icon-fallbacks). Options:
[README, Options](../README.md#options).

## Problem

The "+" menu is in random order with "Desktop" somewhere in a scrolling
list, and a click shows no feedback until the window appears, so programs
often get started twice.

## What you get

Patches of Steam's UI, each on its own option:

- `sort`: programs sorted by name (case-insensitive), Desktop included.
- `pinDesktop = "top"` / `"bottom"`: Desktop pinned above/below the list,
  always visible.
- `closeOnLaunch`: the menu closes on click.
- `launchDebounceSeconds = <seconds>`: a repeat launch of the same command
  within that time is ignored (and logged); a program that exits right away
  can only be restarted once the time is up.
- `grid.enable`: the programs section becomes a grid of tiles (icon, name
  below); "Add desktop window" stays a list. The popup is 300 px wide, so
  `grid.columns` sets the tile size (3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px);
  `grid.maxRows` limits visible rows, the rest scrolls.
- `showAllApps`: every program, see
  [below](#all-programs-and-developer-mode).

All revert when turned off (next switch).

## Configuration

```nix
steamFrame.launcherMenu = {
  sort = true;
  pinDesktop = "bottom";
  closeOnLaunch = true;
  launchDebounceSeconds = 10;
  grid = { enable = true; columns = 4; maxRows = 4; };
  showAllApps = true;
  hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
};
```

### All programs and Developer Mode

Without Developer Mode Steam hides `konsole`, `systemsettings`, `dolphin`,
`plasma-discover`, `vlc`, `firewall-config`, `cmake-gui`, `qrenderdoc`,
`lxterminal` and `sh`. **Steam Developer Mode** (a Steam setting, not managed
here) makes the "+" menu list every desktop entry; `showAllApps` lifts that
filter only, so Developer Mode (sshd, xrdp, LAN DevTools forwards) can stay
off. No feature needs Developer Mode; keep it off (see
[DevTools on the LAN](ui-patches.md#devtools-on-the-lan)). Hide single
programs with [`hiddenApps`](#hidden-apps).

## Limitations

- The pinned Desktop works with the laser but not with thumbstick / D-pad
  navigation.
- Tested with Steam client 1790377368. A Steam update can break the
  patches; the menu then stays stock
  ([after a Steam update](ui-patches.md#after-a-steam-update)).

## How it works

[UI patches](ui-patches.md) in Steam's `SharedJSContext`
(`modules/launcher-menu/`, module `launcher-menu`), each registered only when
its option is set and reverted by its unpatch when unset:

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

`launcherMenu.hiddenApps`, module `hidden-apps`.

**Problem:** with Developer Mode or `showAllApps`, the "+" menu lists every
desktop entry, including system tools.

**What you get:** the listed desktop entry ids (no `.desktop`) are hidden
from the "+" menu and the KDE menu. The "+" menu always hides `steam` and
`vrurlhandler`; for Konsole in VR use
[`showAllApps`](#all-programs-and-developer-mode).

**How it works:** a Home Manager-linked desktop entry with `Hidden=true` per
id in `~/.local/share/applications`, which masks the system entry of the
same id for Steam and KDE alike.

## Icon fallbacks

`launcherMenu.iconFallbacks.*`. On by default.

**Problem:** Steam resolves `Icon=` only in the hicolor theme (and
`pixmaps`), so Konsole and KDE System Settings, whose icons only Breeze has,
show without icon.

**What you get:** Breeze's `utilities-terminal` and `preferences-system`
icons (plus `extra`) in hicolor, so the "+" menu shows them. A running Steam
picks up changes without a restart. Each switch also prints hints: icons of
programs Steam can't find that Breeze has (add them to `extra`), and
fallbacks hicolor has anyway.

**Configuration:** `extra` adds Breeze icon names; a name Breeze doesn't have
fails the build, `enable = false` provides none.

```nix
steamFrame.launcherMenu.iconFallbacks.extra = [ "system-file-manager" ];
```

`iconFallbacks` used to be a list; a list now fails with a hint (use
`extra`, or `enable = false` for `[ ]`).

**How it works:** Home Manager links nixpkgs' Breeze SVGs into
`~/.local/share/icons/hicolor/scalable/apps/`. When the set of links
changes, the switch bumps the mtime of `~/.local/share/icons/hicolor`, so a
running Steam rescans (GTK only rereads a theme whose directory changed).
The switch's hints come from `icon-fallbacks.sh`.

**Migration:** until 2026-09 a script made these links on switch and listed
them in `~/.local/state/steam-frame-nix/icon-fallbacks`; the first switch
replaces them with Home Manager's and `steam-frame-nix-cleanup` removes the
rest.
