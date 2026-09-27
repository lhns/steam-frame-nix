# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame: SteamOS on `aarch64-linux`, standalone home-manager on a
non-NixOS system. They work around quirks of the Frame's two graphical
sessions (portal config, keyboard layout, VR keyboard, clipboard, Firefox)
declaratively, so every change can be reverted by activating an older
home-manager generation.

All options live under `steamFrame.*`. The portal fix and clipboard sync are
on by default; everything else is opt-in.

## Install

On the Frame (or a Steam Deck), open a terminal (Konsole in the desktop
mode / nested desktop) and run:

```sh
curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- install
```

`sudo` needs a password: if you never set one, run `passwd` first.

What it does:

1. Installs Nix with the [NixOS nix-installer](https://github.com/NixOS/nix-installer)
   (`steam-deck` planner: the store lives in `/home/nix`, which survives
   SteamOS updates; flakes enabled). The read-only root filesystem is
   unlocked only for the installation. Skipped if Nix already works.
2. Uses the Home Manager configuration in `~/.config/home-manager`, or
   `--flake <dir-or-flakeref>`. If there is none, it creates one in
   `~/nix-config` from this repo's template (a git repo, linked to
   `~/.config/home-manager`) with your user name filled in.
3. Activates it (`home-manager switch`); existing dotfiles that conflict are
   renamed to `*.hm-backup-<time>`.

Re-running it just switches again. Afterwards, edit `~/nix-config/home.nix`
and apply it with `home-manager switch` from a terminal in the nested
desktop.

```sh
# status: Nix, Home Manager generation, steam-frame-nix services
curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- status

# uninstall Home Manager and Nix (--keep-nix keeps Nix)
curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- uninstall
```

The uninstaller first stops the user services Home Manager installed (which
also reverts the Steam keyboard patch), runs `home-manager uninstall`, then
removes Nix and per-user Nix state. Your configuration directory, `*.hm-backup-<time>`
files, app data (e.g. `~/.local/share/docker`) and Flatpak apps are left
alone.

For a manual setup, start a configuration from the template:

```sh
nix flake init -t github:lhns/steam-frame-nix
```

## Two sessions

The Frame runs two graphical sessions at once, and most of the workarounds
below exist because of the difference between them:

| | Steam / VR session | Nested Plasma desktop |
|---|---|---|
| Compositor | gamescope | KWin (nested, shown as a VR window) |
| Displays | X display `:0` (apps show as floating VR windows) | own Wayland + Xwayland `:2` |
| D-Bus | the outer session bus, `/run/user/1000/bus` | a private bus |
| `XDG_RUNTIME_DIR` | `/run/user/1000` | its own |
| systemd user manager | yes | not reachable |

Consequences:

- **Wallet:** there should be exactly one `kwalletd6`, on the outer bus. Apps
  started from the desktop would otherwise start a second wallet on the
  private bus, and secrets saved there are invisible in VR. Launchers can
  prefix their `Exec=` line with `steamFrame.outerBusEnv`
  (`env DBUS_SESSION_BUS_ADDRESS=<outer bus>`).
- **User services:** home-manager's own `reloadSystemd` step is skipped when
  switching from the desktop terminal (wrong `XDG_RUNTIME_DIR`), so
  `steamFrame.userServices` talks to the outer user manager directly.
- **Launchers:** the Steam session's "+" menu only sees
  `~/.local/share/applications` (not `~/.nix-profile/share`), so app entries
  are written there, shadowing Flatpak/package entries under the same ID.

## Usage

Requirements: Nix with flakes enabled and standalone home-manager (see
[Install](#install); `nix flake init -t github:lhns/steam-frame-nix` creates
the two files below).

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    steam-frame-nix = {
      url = "github:lhns/steam-frame-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, home-manager, steam-frame-nix, ... }: {
    homeConfigurations.steamos = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.aarch64-linux;
      modules = [ steam-frame-nix.homeManagerModules.default ./home.nix ];
    };
  };
}
```

```nix
# home.nix
{ config, ... }: {
  home.username = "steamos";
  home.homeDirectory = "/home/steamos";
  home.stateVersion = "25.11";
  targets.genericLinux.enable = true;

  steamFrame = {
    keyboardLayout = "de";
    steamKeyboardPatch.enable = true;
    firefox.enable = true;
    # Only relevant with Steam Developer Mode on (see hidden-apps below).
    hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
  };

  # Example: an app that must use the single wallet on the outer bus.
  # xdg.dataFile."applications/org.example.App.desktop".text = ''
  #   [Desktop Entry]
  #   Type=Application
  #   Name=Example
  #   Exec=${config.steamFrame.outerBusEnv} flatpak run org.example.App %U
  # '';
}
```

Switch from a terminal **in the nested desktop** (clipboard-sync is restarted
with the desktop's environment):

```sh
home-manager switch --flake .#steamos
```

Individual modules are available as
`homeManagerModules.{session,portal,keyboard-layout,steam-keyboard-patch,hidden-apps,clipboard-sync,firefox}`;
`default` imports all of them.

**Steam Developer Mode** (a Steam setting, not managed here) makes the "+"
menu list every desktop entry, including terminals such as Konsole.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.runtimeDir` | str | `"/run/user/1000"` | `XDG_RUNTIME_DIR` of the outer (Steam/VR) session. |
| `steamFrame.userBus` | str | `"unix:path=${runtimeDir}/bus"` | Outer session D-Bus (user manager, the one `kwalletd6`). |
| `steamFrame.outerBusEnv` | str, read-only | `"env DBUS_SESSION_BUS_ADDRESS=${userBus}"` | Prefix for launchers that must use the outer bus. |
| `steamFrame.userServices.start` | list of str | `[ ]` | User units started on switch if not running (outer user manager). |
| `steamFrame.userServices.restart` | list of str | `[ ]` | User units restarted on every switch (outer user manager). |
| `steamFrame.userServices.stop` | list of str | `[ ]` | User units stopped on switch if still running, e.g. of a feature just disabled. |
| `steamFrame.portalFix.enable` | bool | `true` | Working portal config for the Steam session (OpenURI). |
| `steamFrame.keyboardLayout` | null or str | `null` | XKB layout for the Steam session, e.g. `"de"`. `null` = no drop-in (US). |
| `steamFrame.keyboardVariant` | null or str | `null` | XKB variant for the Steam session. |
| `steamFrame.steamKeyboardPatch.enable` | bool | `false` | Runtime patch of Steam's on-screen keyboard: Esc/Ctrl/Alt, separate arrows, real Ctrl/Alt chords and hold, AltGr/non-ASCII characters. |
| `steamFrame.hiddenApps` | list of str | `[ ]` | Desktop entry ids (without `.desktop`) to hide from the "+" and KDE menus. |
| `steamFrame.clipboardSync.enable` | bool | `true` | Clipboard bridge between the Steam session and the nested desktop. |
| `steamFrame.clipboardSync.package` | package | built from `dnut/clipboard-sync` | The clipboard-sync package. |
| `steamFrame.firefox.enable` | bool | `false` | Launcher for the Flathub Firefox Flatpak (`org.mozilla.firefox`) with the fixes below. |
| `steamFrame.firefox.vrFullscreenFix` | bool | `true` | Link a `user.js` with `full-screen-api.ignore-widgets` into existing profiles. |
| `steamFrame.firefox.desktopProfile` | null or str | `"desktop"` | Separate profile used in the nested desktop; `null` disables it. |

## Fixes in detail

### Session settings and background services (`session.nix`)

This module is used by the others; you normally don't set anything here.

**Where things live.** Background services (systemd user services) and the
KDE wallet belong to the Steam session. The nested desktop runs separately
and can't see them. `runtimeDir` and `userBus` point at the Steam session's
runtime directory and message bus, and `outerBusEnv` is a ready-made prefix
for launchers that must reach them, e.g.
`Exec=${config.steamFrame.outerBusEnv} flatpak run …`.

**Starting services on switch.** When you run `home-manager switch` from a
terminal in the nested desktop, Home Manager can't reach the service
manager, prints "User systemd daemon not running" and skips starting or
restarting services. So after every switch this module talks to the Steam
session's service manager directly: it reloads the service files, then
starts the services listed in `userServices.start`, stops the ones in
`userServices.stop` and restarts the ones in `userServices.restart`. Other
modules fill these lists (e.g. the keyboard patch restarts its helper so a
new version takes effect).

### Portal (`portalFix`)

**Problem:** the Steam Frame image (SteamOS 0.3.0, build 20260922) points the
Steam session's `xdg-desktop-portal` at
`/usr/share/xdg-desktop-portal/gamescope-portals`, which has the holo and
gamescope backends but no `gamescope-portals.conf`. With
`XDG_DESKTOP_PORTAL_DIR` set, the portal reads config only from there, selects
no backend and offers no OpenURI: no app in the Steam session can open links.

**Fix:** an own portal dir in `~/.local/share` with links to Valve's
`.portal` files plus a config (`default=holo;gamescope`), and a drop-in on
`xdg-desktop-portal.service` pointing at it. Only the systemd-managed (outer)
portal is affected; the desktop's portal keeps `kde-portals.conf`.

**Remove when** SteamOS ships a `gamescope-portals.conf`
(`steamFrame.portalFix.enable = false`).

### Keyboard layout (`keyboardLayout`, `keyboardVariant`)

**Problem:** gamescope and its Xwayland displays use xkbcommon defaults (US)
unless `XKB_DEFAULT_*` is set; KDE's layout setting only affects the nested
desktop. `~/.config/environment.d` isn't read by the user manager on the
Frame.

**Fix:** a drop-in on `gamescope-session.service` setting
`XKB_DEFAULT_LAYOUT` (and `XKB_DEFAULT_VARIANT`). Takes effect the next time
the Steam session starts.

**Remove when** SteamOS applies a layout setting to gamescope.

### Steam keyboard patch (`steamKeyboardPatch.enable`)

**Problem:** Steam's VR keyboard has hardcoded layouts without Ctrl, Alt or
Esc. In VR, Steam can't press real keys
(`SteamClient.Input.ControllerKeyboardSetKeyState` throws "Unknown method"),
and its text emulation (`ControllerKeyboardSendText`) only maps plain ASCII:
non-ASCII characters and anything needing AltGr or a dead key on the German
keymap (`| @ { [ ] } \ ~ ^`, backtick, `ä ö ü €`) come out as `1`.

**Fix:** the `steam-keyboard-patch` user service (`helper.mjs`, Node) injects
`patch.js` into Steam's UI at runtime through Steam's CEF DevTools port
(`127.0.0.1:8080`; SteamOS starts Steam with `-cef-enable-debugging`) and
re-injects it after Steam restarts or the keyboard popup is recreated.
Steam's files are never modified. Enabling and disabling take effect on
`home-manager switch`, no reboot or Steam restart needed: when the helper
stops (service stopped, or the option disabled, which stops it via
`userServices.stop`) it reverts the patch in Steam's running UI
(`unpatch.js`). The service is restarted on every switch (via
`userServices.restart`) so a changed patch is re-injected.

- Bottom row becomes `Esc Ctrl Alt [Space] AltGr ← ↑ ↓ → Close`. It stays
  stable with Shift or AltGr active (Steam's stock bottom row moves the
  close icon with Shift and breaks apart with AltGr).
- AltGr + arrows: `←` Pos1 (Home), `→` Ende (End), `↑` Bild↑ (Page Up),
  `↓` Bild↓ (Page Down), shown as small hints on the arrow keys. Shift +
  arrows send real Shift+arrow, for selecting text.
- Ctrl/Alt chords and Esc are pressed with `xdotool key` on `:0`, where X
  focus follows the window selected in VR.
- While Ctrl/Alt is toggled and the keyboard is open, the real modifier is
  held down (e.g. Ctrl+scroll to zoom).
- Problem characters are typed with `xdotool type`; everything else still
  goes through Steam.
- Enter always types Return in app windows. Stock Steam keeps the last
  focused Steam search box as the keyboard target, so Enter could be
  labelled "Search" and close the keyboard instead of pressing Return.

**Layouts:** the extra-character handling (which characters are routed to
xdotool, and the keysym names used for umlauts in chords) targets the German
(`de`) keymap. On other layouts it is harmless: those characters are simply
typed by xdotool instead of Steam, and Esc/Ctrl/Alt/arrows work regardless.

**Security:** requests come from Steam's UI JS, so the helper uses an
allowlist: Ctrl/Alt chords with a single key, the extra keys (Esc, Del, Home,
End, Page Up/Down, arrows), hold/release of Ctrl/Alt, and single non-ASCII or AltGr
characters. It cannot type plain ASCII text or press Enter on its own.

**Caveat:** the patch depends on Steam UI internals, including internal
webpack module ids (e.g. `40222` for layouts, `5363` for the keyboard
manager). A Steam update can break it; the keys then just don't appear.
Tested with Steam client 1790377368.

**Remove when** Steam's VR keyboard gets these keys itself.

### Hidden apps (`hiddenApps`)

**Problem:** with Steam Developer Mode on, the "+" menu lists every desktop
entry GLib would show, including system tools you never want in VR.

**Fix:** a user entry with `Hidden=true` in `~/.local/share/applications`
masks the system one (also in the KDE menu).

The "+" menu itself always hides executables named `steam` or
`vrurlhandler`, and unless Developer Mode is on also terminals and similar
tools such as `konsole`, `dolphin`, `vlc`, `sh` and `lxterminal` (filter in
Steam's UI JS). Enable Developer Mode to get Konsole in VR.

### Clipboard sync (`clipboardSync.enable`)

**Problem:** the Steam session's X displays and the nested desktop have
separate clipboards.

**Fix:** [clipboard-sync](https://github.com/dnut/clipboard-sync), built from
source with your `pkgs` (its own flake outputs are x86-only). Started via KDE
autostart (phase 2), not systemd: the desktop can't reach the user manager
and `:2` must exist first. Each switch restarts it if the running binary
isn't the current build, so run `home-manager switch` from a desktop
terminal.

### Firefox (`firefox.*`)

Assumes the Flathub Firefox Flatpak (`org.mozilla.firefox`, stable branch).
The launcher's desktop entry shadows the Flatpak's own (same ID), so
default-browser associations for `org.mozilla.firefox.desktop` keep working.

- **`vrFullscreenFix`:** real fullscreen is broken in the Steam session:
  gamescope focuses the fullscreen window but never shows it, so Firefox looks
  frozen. A `user.js` with `full-screen-api.ignore-widgets` makes fullscreen
  fill only the Firefox window, which in VR can be as large as you like. It is
  linked into every existing profile on each switch (existing non-symlink
  `user.js` files are left alone). **Remove when** gamescope shows fullscreen
  X11 windows in VR.
- **`desktopProfile`:** the two sessions can't see each other's running
  Firefox, so a second instance stops at the locked profile. In the nested
  desktop (`XDG_CURRENT_DESKTOP=KDE`) the launcher uses a separate profile
  (without the `user.js`; fullscreen works there).

## Rollback

`home-manager generations` lists previous generations; run the `activate`
script of the one you want (`<store path>/activate`).
