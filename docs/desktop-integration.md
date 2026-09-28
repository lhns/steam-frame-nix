# Session, portal and clipboard

Plumbing between the Frame's [two sessions](two-sessions.md). Options:
[Session](options.md#session), [Clipboard sync](options.md#clipboard-sync).

## Session settings and services

Module `session.nix`, used by the other modules; normally nothing to set.

- `session.runtimeDir` / `session.bus` point at the Steam session's runtime
  dir and bus (services, KDE wallet), which the nested desktop can't see.
  `session.busEnv` is a launcher prefix to reach them:

  ```nix
  xdg.dataFile."applications/org.example.App.desktop".text = ''
    [Desktop Entry]
    Type=Application
    Name=Example
    Exec=${config.steamFrame.session.busEnv} flatpak run org.example.App %U
  '';
  ```

- Switching from the nested desktop, Home Manager can't reach the service
  manager ("User systemd daemon not running"). So after every switch this
  module reloads the Steam session's user manager and applies
  `session.services.start` / `stop` / `restart`, which other modules fill.

## Portal

`session.portalFix.enable`, on by default.

**Problem:** the Frame image (SteamOS 0.3.0, build 20260922) points the Steam
session's `xdg-desktop-portal` at `/usr/share/xdg-desktop-portal/gamescope-portals`,
which lacks `gamescope-portals.conf`: no backend, no OpenURI, so no app in
the Steam session can open links.

**Fix:** a portal dir in `~/.local/share` linking Valve's `.portal` files plus
a config (`default=holo;gamescope`), and a drop-in on
`xdg-desktop-portal.service`. The desktop's portal is unaffected.

**Remove when** SteamOS ships `gamescope-portals.conf`.

## Clipboard sync

`clipboardSync.enable`, on by default.

**Problem:** the Steam session's X displays and the nested desktop have
separate clipboards.

**Fix:** [clipboard-sync](https://github.com/dnut/clipboard-sync), built from
source (its flake is x86-only; `clipboardSync.package` to replace it),
started via KDE autostart (the desktop can't reach the user manager, and
`:2` must exist first). Each switch restarts it if outdated, so switch from a
desktop terminal.
