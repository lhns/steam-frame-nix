# Session fixes

Five fixes for the Frame's [two graphical sessions](../README.md#two-sessions):
session settings and services, the portal, the applications menu, the
keyboard layout and the clipboard. Options:
[README, Options](../README.md#options) (`session.*`, `keyboard.layout`,
`keyboard.variant`, `clipboardSync.*`).

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

**Configuration:** apps that keep secrets in the wallet get a
[launcher](launchers.md) with `keyring.enable`. Another app that must reach
the outer session (its bus, services or wallet) gets the bus through its
launcher's `hostEnv`; a hand-written entry uses the prefix `session.busEnv`:

```nix
{ config, ... }: {
  steamFrame.launchers."org.example.App".hostEnv.DBUS_SESSION_BUS_ADDRESS =
    config.steamFrame.session.bus;
  # or, in an entry of your own:
  # Exec=${config.steamFrame.session.busEnv} flatpak run org.example.App %U
}
```

## Portal fix

`session.portalFix.enable` and `session.portalFix.fileChooser`, module
`portal`. Both on by default.

**Problem:** the Frame image (SteamOS 0.3.0, build 20260922) points the Steam
session's `xdg-desktop-portal` at `/usr/share/xdg-desktop-portal/gamescope-portals`,
which lacks `gamescope-portals.conf`: no backend, no OpenURI, so no app in
the Steam session can open links. Its two backends (gamescope, holo) also
have no FileChooser, so Flatpak apps fall back to a dialog inside their
sandbox: e.g. Element's Attachments shows an empty file selector without
your home dir.

**What you get:** a working OpenURI portal in the Steam session and, with
`fileChooser`, KDE's file dialog there (a normal window in VR) with access
to all your files; the app gets only the files you pick. The desktop's
portal is unaffected.

**Configuration:** takes effect when the portal restarts (next Steam session
start, or `systemctl --user restart xdg-desktop-portal`) and the app
restarts (Electron apps check for the portal at startup). To keep the old
dialog: `steamFrame.session.portalFix.fileChooser = false;`.

**Remove when** SteamOS ships `gamescope-portals.conf` (and a FileChooser
backend, for `fileChooser`).

**How it works:** a portal dir in `~/.local/share` linking Valve's `.portal`
files plus a config (`default=holo;gamescope`), and a drop-in on
`xdg-desktop-portal.service`. `fileChooser` adds a link to
`/usr/share/xdg-desktop-portal/portals/kde.portal` and
`org.freedesktop.impl.portal.FileChooser=kde`; the preinstalled
`xdg-desktop-portal-kde` starts on demand (D-Bus activation) with the Steam
session's `DISPLAY=:0`.

## Applications menu

`session.applicationsMenu.enable`, module `applications-menu`. On by default;
`false` turns it off.

**Problem:** KDE apps build their app database (ksycoca) from
`applications.menu`, but SteamOS only ships
`/etc/xdg/menus/plasma-applications.menu`. The nested desktop sets
`XDG_MENU_PREFIX=plasma-`, the Steam session doesn't: KDE apps started there
(e.g. Dolphin from the "+" menu) know no apps at all ("no installed
application can open …").

**What you get:** KDE apps in the Steam session see every installed app,
Flatpaks included, e.g. for "Open with". The nested desktop is unaffected (it
reads Plasma's menu through its prefix).

**Remove when** the Steam session sets `XDG_MENU_PREFIX` or SteamOS ships
`applications.menu`.

**How it works:** `~/.config/menus/applications.menu` is a Home Manager link
to `/etc/xdg/menus/plasma-applications.menu`. If SteamOS drops that file,
the link dangles, which is the same as no menu.

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
