# Launcher menu

The VR dashboard's "+" menu (non-Steam programs). Options:
[options.md#launcher-menu](options.md#launcher-menu).

## Menu patches

`launcherMenu.*`.

**Problem:** the menu is in random order with "Desktop" somewhere in a
scrolling list, and a click shows no feedback until the window appears, so
programs often get started twice.

**What it does:**

- `sort`: programs sorted by name (case-insensitive), Desktop included.
- `pinDesktop = "top"` / `"bottom"`: Desktop pinned above/below the list,
  always visible.
- `closeOnLaunch`: the menu closes on click.
- `launchDebounceSeconds = <seconds>`: a repeat launch of the same command
  within that time is ignored (and logged); a program that exits right away
  can only be restarted once the time is up.
- `grid.enable`: the programs section becomes a grid of tiles (icon, name
  below); "Add desktop window" stays a list. Only restyles Steam's items, so
  launching, sounds and controller navigation keep working. The popup is
  300 px wide, so `grid.columns` sets the tile size (3 ≈ 92 px, 4 ≈ 68 px,
  5 ≈ 53 px); `grid.maxRows` limits visible rows, the rest scrolls.
- `showAllApps`: without Developer Mode Steam hides `konsole`,
  `systemsettings`, `dolphin`, `plasma-discover`, `vlc`, `firewall-config`,
  `cmake-gui`, `qrenderdoc`, `lxterminal` and `sh`; this lifts that filter
  only, so Developer Mode (sshd, xrdp, LAN DevTools forwards) can stay off.
  Hide single programs with [`hiddenApps`](#hidden-apps).

**Steam Developer Mode** (a Steam setting, not managed here) also makes the
menu list every desktop entry; `showAllApps` does the same without it.

**Limitation:** the pinned Desktop works with the laser but not with
thumbstick / D-pad navigation.

**How it works:** [UI patches](ui-patches.md) in Steam's `SharedJSContext`.
All revert when turned off (next switch). The anchors (APIs, React props,
CSS) are verified by the offline checker. Tested with Steam client
1790377368.

## Hidden apps

`launcherMenu.hiddenApps`: desktop entry ids (no `.desktop`).

**Problem:** with Developer Mode or `showAllApps`, the "+" menu lists every
desktop entry, including system tools.

**Fix:** a user entry with `Hidden=true` in `~/.local/share/applications`
masks the system one (also in the KDE menu). The "+" menu always hides
`steam` and `vrurlhandler`; for Konsole in VR use
[`showAllApps`](#menu-patches).

## Icon fallbacks

`launcherMenu.iconFallbacks.enable` (on by default), `iconFallbacks.extra`.

**Problem:** Steam resolves `Icon=` only in the hicolor theme (and
`pixmaps`), so Konsole and KDE System Settings, whose icons only Breeze has,
show without icon.

**Fix:** Home Manager links nixpkgs' Breeze SVGs of `utilities-terminal`
and `preferences-system` (plus `extra`) into
`~/.local/share/icons/hicolor/scalable/apps/`; a name Breeze doesn't have
fails the build, `enable = false` provides none. When the set of links
changes, the switch bumps the mtime of `~/.local/share/icons/hicolor`, so a
running Steam rescans (GTK only rereads a theme whose directory changed).
Each switch also prints hints: icons of programs Steam can't find that
Breeze has (add them to `extra`), and fallbacks hicolor has anyway.

**Migration:** until 2026-09 a script made these links on switch and listed
them in `~/.local/state/steam-frame-nix/icon-fallbacks`; the first switch
replaces them with Home Manager's and `steam-frame-nix-cleanup` removes the
rest. `iconFallbacks` used to be a list; a list now fails with a hint (use
`extra`, or `enable = false` for `[ ]`).
