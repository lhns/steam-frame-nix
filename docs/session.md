# Session fixes

Four fixes for the Frame's [two graphical sessions](../README.md#two-sessions):
session settings and services, the portal, the keyboard layout and the
clipboard. Options: [README, Options](../README.md#options) (`session.*`,
`keyboard.layout`, `keyboard.variant`, `clipboardSync.*`).

## Session settings and services

Module `session` (`session.nix`), used by the other modules; normally
nothing to set.

**Problem:** the nested desktop can't see the Steam session's runtime dir
and bus (services, KDE wallet), and switching from the nested desktop,
Home Manager can't reach the service manager ("User systemd daemon not
running") and skips `reloadSystemd`.

**What you get:**

- `session.runtimeDir` / `session.bus` point at the Steam session's runtime
  dir and bus; `session.busEnv` is a launcher prefix to reach them.
- After every switch this module reloads the Steam session's user manager
  and applies `session.services.start` / `stop` / `restart`, which other
  modules fill (you can add your own units).

**Configuration:** a launcher for an app that must use the single wallet on
the outer bus (see [Two sessions](../README.md#two-sessions)):

```nix
{ config, ... }: {
  xdg.dataFile."applications/org.example.App.desktop".text = ''
    [Desktop Entry]
    Type=Application
    Name=Example
    Exec=${config.steamFrame.session.busEnv} flatpak run org.example.App %U
  '';
}
```

## Portal fix

`session.portalFix.enable`, module `portal`. On by default.

**Problem:** the Frame image (SteamOS 0.3.0, build 20260922) points the Steam
session's `xdg-desktop-portal` at `/usr/share/xdg-desktop-portal/gamescope-portals`,
which lacks `gamescope-portals.conf`: no backend, no OpenURI, so no app in
the Steam session can open links.

**What you get:** a working OpenURI portal in the Steam session; the
desktop's portal is unaffected.

**Remove when** SteamOS ships `gamescope-portals.conf`.

**How it works:** a portal dir in `~/.local/share` linking Valve's `.portal`
files plus a config (`default=holo;gamescope`), and a drop-in on
`xdg-desktop-portal.service`.

## Keyboard layout

`keyboard.layout`, `keyboard.variant`, module `keyboard-layout`.

**Problem:** gamescope and its Xwayland displays use US unless
`XKB_DEFAULT_*` is set; KDE's layout only affects the nested desktop, and
`~/.config/environment.d` isn't read on the Frame.

**What you get:** the layout in the Steam session, from the next Steam
session start. The layout also picks the
[VR keyboard](keyboard.md#swipe-and-suggestions)'s default dictionary
language.

**Configuration:** `keyboard.variant` picks a variant of the layout, e.g. for
`de`: `null` (standard, with dead keys: `^`, `` ` ``, `´` wait for the next
key), `"nodeadkeys"` (those are typed immediately), `"mac"`, `"neo"`, `"e1"`,
`"us"` (German letters on a US layout). List them with
`localectl list-x11-keymap-variants <layout>`.

```nix
steamFrame.keyboard = { layout = "de"; variant = "nodeadkeys"; };
```

**Remove when** SteamOS applies a layout setting to gamescope.

**How it works:** a drop-in on `gamescope-session.service` setting
`XKB_DEFAULT_LAYOUT`/`VARIANT`.

## Clipboard sync

`clipboardSync.enable`, module `clipboard-sync`. On by default.

**Problem:** the Steam session's X displays and the nested desktop have
separate clipboards.

**What you get:** one clipboard: copy in one session, paste in the other.

**Configuration:** `clipboardSync.package` replaces the package. Switch from
a desktop terminal: each switch restarts clipboard-sync if outdated, and it
must restart with the desktop's environment.

**How it works:** [clipboard-sync](https://github.com/dnut/clipboard-sync),
built from source (its flake is x86-only), started via KDE autostart (the
desktop can't reach the user manager, and `:2` must exist first).
