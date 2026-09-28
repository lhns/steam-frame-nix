# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame (SteamOS, `aarch64-linux`, standalone home-manager). They
work around quirks of the Frame's [two graphical sessions](#two-sessions)
(portal, keyboard layout, clipboard, Firefox), enable hardware video decoding
in Jellyfin, and extend Steam's and SteamVR's UIs at runtime (VR keyboard,
"+" menu, dashboard windows, Steam close button, window curvature, window
controls).

Everything is declarative: files are links into the Nix store, UI patches
live in memory. The few things that have to be written elsewhere at runtime
are listed under [Changes outside Nix](#changes-outside-nix-exceptions), with
their lifetime and what removes them; `steam-frame-nix-cleanup` removes every
one of them (on each switch what the configuration no longer uses, `--all`
for everything).

All options live under `steamFrame.*`. The portal fix and clipboard sync are
on by default; everything else is opt-in.

- [Features](#features) · [Install](#install) · [Two sessions](#two-sessions) ·
  [Usage](#usage) · [Options](#options)
- [Fixes in detail](#fixes-in-detail):
  [session](#session-settings-and-background-services-sessionnix),
  [portal](#portal-sessionportalfix),
  [keyboard layout](#keyboard-layout-keyboardlayout-keyboardvariant),
  [VR keyboard extra keys](#steam-keyboard-patch-keyboardvrextrakeysenable),
  [swipe and suggestions](#vr-keyboard-swipe-and-suggestions-keyboardvr),
  [launcher menu](#launcher-menu-launchermenu),
  [hidden apps](#hidden-apps-launchermenuhiddenapps),
  [icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks),
  [dashboard windows](#dashboard-windows-dashboardwindows),
  [Steam close button](#steam-close-button-dashboardsteamclosebuttonenable),
  [window curvature](#window-curvature-dashboardwindowcurvature),
  [window control bar](#window-control-bar-dashboardframecontrols),
  [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable),
  [clipboard sync](#clipboard-sync-clipboardsyncenable),
  [Firefox](#firefox-firefox),
  [Jellyfin hardware decoding](#jellyfin-hardware-decoding-jellyfinhardwaredecoding)
- [UI patches](#ui-patches-uipatchespatches):
  [DevTools on the LAN](#devtools-on-the-lan),
  [after a Steam update](#after-a-steam-update)
- [Changes outside Nix](#changes-outside-nix-exceptions) ·
  [Rollback](#rollback) · [Uninstall](#uninstall)

Technical documentation (how the patches work, writing your own, fixing them
after a Steam update): [`docs/`](docs).

## Features

Session and desktop:

- [Portal fix](#portal-sessionportalfix) (`session.portalFix`, on): apps in
  the Steam session can open links.
- [Clipboard sync](#clipboard-sync-clipboardsyncenable) (`clipboardSync`,
  on): one clipboard for the Steam session and the nested desktop.
- [Session settings](#session-settings-and-background-services-sessionnix)
  (`session.*`): outer bus and user services, for launchers and the other
  modules.

Keyboard:

- [Keyboard layout](#keyboard-layout-keyboardlayout-keyboardvariant)
  (`keyboard.layout`, `keyboard.variant`): XKB layout for the Steam session.
- [Extra keys](#steam-keyboard-patch-keyboardvrextrakeysenable)
  (`keyboard.vr.extraKeys`): Esc/Ctrl/Alt, arrows, Delete, real chords and
  AltGr/non-ASCII characters on the VR keyboard.
- [Swipe and suggestions](#vr-keyboard-swipe-and-suggestions-keyboardvr)
  (`keyboard.vr`): swipe typing, corrections, completions, Backspace drag.

VR "+" menu:

- [Launcher menu](#launcher-menu-launchermenu) (`launcherMenu.*`): sorted,
  Desktop pinned, closes on launch, no double launches, grid of tiles, all
  programs without Developer Mode.
- [Hidden apps](#hidden-apps-launchermenuhiddenapps)
  (`launcherMenu.hiddenApps`) and
  [icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks)
  (`launcherMenu.iconFallbacks`, on) for Konsole and KDE System Settings.

SteamVR dashboard (turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable) automatically):

- [Dashboard windows](#dashboard-windows-dashboardwindows)
  (`dashboard.windows`): larger max scale and push-back distance.
- [Steam close button](#steam-close-button-dashboardsteamclosebuttonenable)
  (`dashboard.steamCloseButton`): an X that hides the Steam window.
- [Window curvature](#window-curvature-dashboardwindowcurvature)
  (`dashboard.windowCurvature`): adjustable curvature per window.
- [Window control bar](#window-control-bar-dashboardframecontrols)
  (`dashboard.frameControls`): move controls between bar and three-dot menu.

Apps:

- [Firefox](#firefox-firefox) (`firefox`): launcher for the Flatpak with a VR
  fullscreen fix, optional AV1 off, a separate desktop profile.
- [Jellyfin](#jellyfin-hardware-decoding-jellyfinhardwaredecoding)
  (`jellyfin.hardwareDecoding`): hardware video decoding in the Jellyfin
  Desktop Flatpak.

Your own patches of Steam's UI: [UI patches](#ui-patches-uipatchespatches).

## Install

On the Frame (or a Steam Deck), in a terminal (Konsole in desktop mode or the
nested desktop):

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
```

The short link redirects to
[`install.sh`](https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh)
on `main`. `sudo` needs a password: run `passwd` first if you never set one.

The installer:

1. installs Nix with the [NixOS nix-installer](https://github.com/NixOS/nix-installer)
   (`steam-deck` planner: store in `/home/nix`, survives SteamOS updates;
   flakes on), unlocking the read-only root only for the install. Skipped if
   Nix already works;
2. uses `~/.config/home-manager` or `--flake <dir-or-flakeref>`; if there is
   none, creates `~/nix-config` (a git repo, linked to
   `~/.config/home-manager`) from the [template](template) with your user
   name;
3. runs `home-manager switch`; conflicting dotfiles are renamed to
   `*.hm-backup-<time>`.

Re-running it just switches again (`--yes` answers every question).
Afterwards edit `~/nix-config/home.nix` and run `home-manager switch` from a
terminal in the nested desktop (see [Usage](#usage)).

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- status      # Nix, generation, services
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all   # see Changes outside Nix
```

`bash -s -- --help` lists all commands and flags. See
[Uninstall](#uninstall) for what `uninstall` removes and keeps, and
[Set up by install.sh](#set-up-by-installsh) for everything the installer
changes.

**Manual setup** (Nix with flakes and standalone home-manager):
`nix flake init -t github:lhns/steam-frame-nix` creates a commented
`flake.nix` and `home.nix` ([`template/`](template), shown under
[Usage](#usage)), or add the input to your own flake.

## Two sessions

The Frame runs two graphical sessions at once; most workarounds exist because
of their differences:

| | Steam / VR session | Nested Plasma desktop |
|---|---|---|
| Compositor | gamescope | KWin (nested, shown as a VR window) |
| Displays | X display `:0` (apps show as floating VR windows) | own Wayland + Xwayland `:2` |
| D-Bus | the outer session bus, `/run/user/1000/bus` | a private bus |
| `XDG_RUNTIME_DIR` | `/run/user/1000` | its own |
| systemd user manager | yes | not reachable |

What this means for you:

- **Switch from the nested desktop:** run `home-manager switch` in a
  terminal there, so clipboard-sync restarts with the desktop's
  environment. User services are handled for you
  ([session settings](#session-settings-and-background-services-sessionnix)).
- **Wallet:** there should be one `kwalletd6`, on the outer bus; apps started
  from the desktop would otherwise start a second one whose secrets VR can't
  see. Prefix such launchers' `Exec=` with `steamFrame.session.busEnv`
  (example under [Usage](#usage)).
- **Launchers:** the "+" menu only sees `~/.local/share/applications` (not
  `~/.nix-profile/share`), so entries are written there, shadowing
  Flatpak/package entries with the same ID.
- **Keyboard layout, clipboard, Firefox:** each session has its own; see
  [keyboard layout](#keyboard-layout-keyboardlayout-keyboardvariant),
  [clipboard sync](#clipboard-sync-clipboardsyncenable),
  [Firefox](#firefox-firefox) (desktop profile).

## Usage

`nix flake init -t github:lhns/steam-frame-nix` (or the installer) creates
these two files ([`template/`](template), with more comments):

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

  outputs = { nixpkgs, home-manager, steam-frame-nix, ... }:
  let
    username = "steamos";            # filled in by install.sh
    homeDirectory = "/home/steamos";
    system = "aarch64-linux";        # Steam Deck: "x86_64-linux"
  in {
    homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.${system};
      extraSpecialArgs = { inherit username homeDirectory; };
      modules = [ steam-frame-nix.homeManagerModules.default ./home.nix ];
    };
  };
}
```

```nix
# home.nix
{ config, pkgs, username, homeDirectory, ... }: {
  home.username = username;
  home.homeDirectory = homeDirectory;
  home.stateVersion = "26.05";
  targets.genericLinux.enable = true;
  programs.home-manager.enable = true;

  steamFrame = {
    keyboard.layout = "de";               # XKB layout, Steam session
    keyboard.vr.extraKeys.enable = true;  # Esc/Ctrl/Alt/arrows in VR
    keyboard.vr.enable = true;            # swipe, suggestions, Backspace drag
    launcherMenu = {
      sort = true;
      pinDesktop = "bottom";
      closeOnLaunch = true;
      launchDebounceSeconds = 10;
      grid = { enable = true; columns = 4; maxRows = 4; };
      showAllApps = true;
      # iconFallbacks.extra = [ "system-file-manager" ];
      # Listed in the "+" menu only with showAllApps or Steam Developer Mode:
      hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
    };
    dashboard = {
      windows.maxScale = 4.0;
      windows.distance.world.max = 10.0;
      windows.distance.theater.max = 12.0;
      steamCloseButton.enable = true;
      windowCurvature.enable = true;
      frameControls.enable = true;
    };
    firefox.enable = true;
    firefox.disableAv1 = true;
    jellyfin.hardwareDecoding.enable = true;  # install the Flatpak yourself
  };

  # Example: an app that must use the single wallet on the outer bus.
  # xdg.dataFile."applications/org.example.App.desktop".text = ''
  #   [Desktop Entry]
  #   Type=Application
  #   Name=Example
  #   Exec=${config.steamFrame.session.busEnv} flatpak run org.example.App %U
  # '';
}
```

Switch from a terminal **in the nested desktop** (so clipboard-sync restarts
with the desktop's environment):

```sh
home-manager switch                    # config in ~/.config/home-manager (installer)
home-manager switch --flake .#steamos  # manual setup, from the flake's directory
```

In your own flake, add the input as above and
`steam-frame-nix.homeManagerModules.default` to the modules. `default`
imports all modules; single ones:
`homeManagerModules.{session,portal,keyboard-layout,steam-keyboard-patch,vr-keyboard,hidden-apps,steam-ui-patches,launcher-menu,steamvr-debugger,cleanup,dashboard-windows,steam-close-button,window-curvature,frame-controls,clipboard-sync,firefox,jellyfin}`.
Every module imports `cleanup` (see
[Changes outside Nix](#changes-outside-nix-exceptions)).

**Steam Developer Mode** (a Steam setting, not managed here) makes the "+"
menu list every desktop entry; `launcherMenu.showAllApps` does the same
without it. No feature needs Developer Mode; keep it off (see
[DevTools on the LAN](#devtools-on-the-lan)).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.session.runtimeDir` | str | `"/run/user/1000"` | `XDG_RUNTIME_DIR` of the outer (Steam/VR) session. |
| `steamFrame.session.bus` | str | `"unix:path=${runtimeDir}/bus"` | Outer session D-Bus (user manager, `kwalletd6`). |
| `steamFrame.session.busEnv` | str, read-only | `"env DBUS_SESSION_BUS_ADDRESS=${bus}"` | Prefix for launchers that must use the outer bus. |
| `steamFrame.session.services.start` | list of str | `[ ]` | User units started on switch if not running. |
| `steamFrame.session.services.restart` | list of str | `[ ]` | User units restarted on every switch. |
| `steamFrame.session.services.stop` | list of str | `[ ]` | User units stopped on switch if running (e.g. of a disabled feature). |
| `steamFrame.session.portalFix.enable` | bool | `true` | Working portal config (OpenURI) for the Steam session. |
| `steamFrame.keyboard.layout` | null or str | `null` | XKB layout for the Steam session, e.g. `"de"`; `null`: US. |
| `steamFrame.keyboard.variant` | null or str | `null` | XKB variant for the Steam session, e.g. `"nodeadkeys"`; see [Keyboard layout](#keyboard-layout-keyboardlayout-keyboardvariant). |
| `steamFrame.keyboard.vr.extraKeys.enable` | bool | `false` | VR keyboard with Esc/Ctrl/Alt, arrows, real chords, AltGr/non-ASCII. |
| `steamFrame.keyboard.vr.enable` | bool | `false` | Swipe typing, suggestions and Backspace drag on the VR keyboard; the sub-features below are on by default, see [VR keyboard](#vr-keyboard-swipe-and-suggestions-keyboardvr). |
| `steamFrame.keyboard.vr.swipe.enable` | bool | `true` | Swipe typing. |
| `steamFrame.keyboard.vr.dictionary.languages` | list of submodules | layout language + English | `{ language; hunspell; words; frequencyOffset; keepFrequentAbove; }`: wordfreq language, `pkgs.hunspellDicts` name (or `null`), most frequent words taken, zipf offset, keep words Hunspell rejects from this zipf on (default `4.0`). Default: the `keyboard.layout` language (de, fr, es, it, nl, pt, sv; 60000) + English (40000, `-0.3`), else English (60000). |
| `steamFrame.keyboard.vr.dictionary.contractions` | bool | `true` | Words with apostrophes (`couldn't`, `geht's`), swiped by their letters. |
| `steamFrame.keyboard.vr.dictionary.extraWords` | list of str | `[ ]` | Words always included, casing as given. |
| `steamFrame.keyboard.vr.dictionary.extraWordsFrequency` | number | `5.0` | Zipf frequency of extra words. |
| `steamFrame.keyboard.vr.dictionary.extraWordFiles` | list of paths | `[ ]` | Word lists, `word` or `word<TAB>zipf` per line. |
| `steamFrame.keyboard.vr.dictionary.excludeWords` | list of str | `[ ]` | Words never suggested. |
| `steamFrame.keyboard.vr.text.bufferChars` | int | `128` | Characters of typed text the keyboard remembers. |
| `steamFrame.keyboard.vr.text.resetAfterIdleSeconds` | int | `30` | Forget it after this long without typing (`0`: never). |
| `steamFrame.keyboard.vr.text.autoSpace` | bool | `true` | Space before a swiped word after a known non-space character. |
| `steamFrame.keyboard.vr.suggestions.position` | `"below"`, `"above"`, `"inside"` | `"above"` | Suggestion strip: SteamVR panel below/above the keyboard, or over its number row. |
| `steamFrame.keyboard.vr.suggestions.count` | int | `6` | Suggestions shown. |
| `steamFrame.keyboard.vr.autocorrect.enable` | bool | `true` | Correction suggestions for finished tapped words not in the dictionary. |
| `steamFrame.keyboard.vr.autocorrect.maxEditDistance` | int | `2` | Largest edit distance (neighbouring keys and swaps count 0.5). |
| `steamFrame.keyboard.vr.completions.enable` | bool | `true` | Completions of the tapped word. |
| `steamFrame.keyboard.vr.completions.minPrefix` | int | `2` | Letters typed before completions show. |
| `steamFrame.keyboard.vr.backspaceDrag.enable` | bool | `true` | Backspace drag: left deletes, back right retypes. |
| `steamFrame.keyboard.vr.backspaceDrag.pixelsPerChar` | int | `25` | Travel per character (keyboard px; a key is ~60). |
| `steamFrame.keyboard.vr.backspaceDrag.wordDetentPixels` | int | `90` | Extra travel across a word border (`0`: none). |
| `steamFrame.keyboard.vr.haptics` | bool | `true` | Haptic ticks for drag steps, word detents and picks. |
| `steamFrame.keyboard.vr.checks` | package, read-only | | The tests, built with the configured dictionary. |
| `steamFrame.uiPatches.patches` | list of submodules | `[ ]` | Runtime patches of Steam's web UIs, see [UI patches](#ui-patches-uipatchespatches). |
| `steamFrame.uiPatches.lib` | attrs, read-only | | Patch helpers (`mkPatch`), see [Finders and signatures](docs/ui-patches.md#mkpatch). |
| `steamFrame.launcherMenu.sort` | bool | `false` | Sort the "+" menu alphabetically. |
| `steamFrame.launcherMenu.pinDesktop` | null or `"top"` / `"bottom"` | `null` | Pin "Desktop" above/below the "+" menu's list; `null`: normal entry. |
| `steamFrame.launcherMenu.closeOnLaunch` | bool | `false` | Close the "+" menu when a program is clicked. |
| `steamFrame.launcherMenu.launchDebounceSeconds` | unsigned int (s) | `0` | Ignore repeat launches of a program within this time; `0`: off. |
| `steamFrame.launcherMenu.grid.enable` | bool | `false` | Show the "+" menu's programs as a grid of tiles. |
| `steamFrame.launcherMenu.grid.columns` | int, 1-8 | `4` | Tiles per row (3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px). |
| `steamFrame.launcherMenu.grid.maxRows` | null or positive int | `null` | Visible rows, the rest scrolls; `null`: up to 600 px. |
| `steamFrame.launcherMenu.showAllApps` | bool | `false` | List all programs without Developer Mode, see [Launcher menu](#launcher-menu-launchermenu). |
| `steamFrame.launcherMenu.iconFallbacks.enable` | bool | `true` | Breeze icons of Konsole and KDE System Settings in hicolor, so the "+" menu shows them, see [Icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks). |
| `steamFrame.launcherMenu.iconFallbacks.extra` | list of str | `[ ]` | Further Breeze app icon names to provide (a name Breeze lacks fails the build). |
| `steamFrame.launcherMenu.hiddenApps` | list of str | `[ ]` | Desktop entry ids (no `.desktop`) hidden from the "+" and KDE menus. |
| `steamFrame.dashboard.windows.maxScale` | null or positive number | `null` | Max resize scale of dashboard windows; `null`: stock (2), see [Dashboard windows](#dashboard-windows-dashboardwindows). |
| `steamFrame.dashboard.windows.distance.{world,theater,dashboard}.{min,max}` | null or positive number (m) | `null` | Pull-in / push-back limits of grabbed windows; `null`: stock (world 0.25-5, theater 1-6, dashboard 0.3-4 m). |
| `steamFrame.dashboard.steamCloseButton.enable` | bool | `false` | X button on the dashboard's Steam window, see [Steam close button](#steam-close-button-dashboardsteamclosebuttonenable). |
| `steamFrame.dashboard.windowCurvature.enable` | bool | `false` | Adjustable curvature per window, see [Window curvature](#window-curvature-dashboardwindowcurvature). |
| `steamFrame.dashboard.windowCurvature.initial` | non-negative number | `1.0` | Curvature of curved world/hand windows without own value (1 = stock, 0 = flat). |
| `steamFrame.dashboard.windowCurvature.max` | positive number | `3.0` | Largest curvature. |
| `steamFrame.dashboard.windowCurvature.step` | positive number | `0.05` | Rounding step while dragging (at most `max`). |
| `steamFrame.dashboard.windowCurvature.detentPixels` | unsigned int (px) | `24` | Detent at each detent point in drag pixels: the value holds there, then continues (nothing skipped); `0`: none. |
| `steamFrame.dashboard.windowCurvature.detentPoints` | list of non-negative numbers | `[ 0 1.0 ]` | Detent points (flat, stock), at most `max`. |
| `steamFrame.dashboard.windowCurvature.dragThresholdPixels` | unsigned int (px) | `8` | Vertical travel before a press becomes a drag. |
| `steamFrame.dashboard.windowCurvature.dragPixelsPerUnit` | positive number (px) | `120` | Drag distance per 1.0 in the menu (6 px per 0.05 step). |
| `steamFrame.dashboard.windowCurvature.barDragPixelsPerUnit` | positive number (px) | `60` | Drag distance per 1.0 on the bar button. |
| `steamFrame.dashboard.windowCurvature.haptics` | bool | `true` | Controller haptics while dragging (steps, detents, edges); the dashboard's hover clicks are muted during a drag. |
| `steamFrame.dashboard.frameControls.enable` | bool | `false` | Move window controls between bar and three-dot menu, see [Window control bar](#window-control-bar-dashboardframecontrols). |
| `steamFrame.dashboard.frameControls.longPressMs` | int, 300-10000 (ms) | `1500` | Long-press duration. |
| `steamFrame.dashboard.frameControls.inBar` | list of control names | `[ ]` | Controls that start in the bar: `keyboard`, `float`, `dashboard`, `theater`, `dockLeft`, `dockRight`, `close`, `curvature`, `"icon:<n>"`. |
| `steamFrame.dashboard.frameControls.inMenu` | list of control names | `[ ]` | Controls that start in the three-dot menu. |
| `steamFrame.dashboard.frameControls.floatInTheater` | bool | `false` | "Float" control on theater windows. |
| `steamFrame.steamvrDebugger.enable` | bool | automatic | SteamVR dashboard DevTools on `127.0.0.1:8087` (set only while SteamVR runs); on when a dashboard patch is, see [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable). |
| `steamFrame.clipboardSync.enable` | bool | `true` | Clipboard bridge between the Steam session and the nested desktop. |
| `steamFrame.clipboardSync.package` | package | built from `dnut/clipboard-sync` | The clipboard-sync package. |
| `steamFrame.firefox.enable` | bool | `false` | Launcher for the Flathub Firefox Flatpak with the fixes below. |
| `steamFrame.firefox.vrFullscreenFix` | bool | `true` | Default `full-screen-api.ignore-widgets` to `true` (not in the desktop profile). |
| `steamFrame.firefox.disableAv1` | bool | `false` | Default `media.av1.enabled` to `false`: the Frame's decoder driver has no AV1, so sites send VP9/H.264, decoded in hardware. |
| `steamFrame.firefox.prefs` | attrs of bool, int or str | `{ }` | Further `about:config` default values for every profile (override the fixes too). |
| `steamFrame.firefox.desktopProfile` | null or str | `"desktop"` | Separate profile (directory name) for the nested desktop; `null`: the default profile in both sessions. |
| `steamFrame.jellyfin.hardwareDecoding.enable` | bool | `false` | Hardware video decoding in the Jellyfin Desktop Flatpak, see [Jellyfin](#jellyfin-hardware-decoding-jellyfinhardwaredecoding). |
| `steamFrame.jellyfin.hardwareDecoding.hwdec` | str | `"v4l2m2m-copy,auto-copy"` | mpv `hwdec` used instead of Jellyfin's automatic one. |
| `steamFrame.jellyfin.hardwareDecoding.command` | str, read-only | | The `flatpak run …` command line of the desktop entry, for a terminal. |
| `steamFrame.cleanup.package` | package, read-only | | `steam-frame-nix-cleanup` (on `PATH` too), see [Changes outside Nix](#changes-outside-nix-exceptions). |

Renamed options still work under their old names, with a warning:

| Old | New |
|---|---|
| `keyboardLayout`, `keyboardVariant` | `keyboard.layout`, `keyboard.variant` |
| `steamKeyboardPatch.enable` | `keyboard.vr.extraKeys.enable` |
| `hiddenApps` | `launcherMenu.hiddenApps` |
| `launcherMenu.launchDebounce` | `launcherMenu.launchDebounceSeconds` |
| `runtimeDir`, `userBus`, `outerBusEnv` | `session.runtimeDir`, `session.bus`, `session.busEnv` |
| `userServices.{start,restart,stop}` | `session.services.{start,restart,stop}` |
| `portalFix.enable` | `session.portalFix.enable` |
| `dashboard.windowMaxScale` | `dashboard.windows.maxScale` |
| `dashboard.windowDistance.*` | `dashboard.windows.distance.*` |
| `dashboard.windowCurvature.default` | `dashboard.windowCurvature.initial` |
| `dashboard.windowCurvature.snapPixels`, `snapPoints` | `detentPixels`, `detentPoints` |
| `dashboard.windowCurvature.dragThreshold` | `dragThresholdPixels` |

## Fixes in detail

### Session settings and background services (`session.nix`)

Used by the other modules; normally nothing to set.

- `session.runtimeDir` / `session.bus` point at the Steam session's runtime
  dir and bus (services, KDE wallet), which the nested desktop can't see;
  `session.busEnv` is a launcher prefix to reach them
  (`Exec=${config.steamFrame.session.busEnv} flatpak run …`, see
  [Usage](#usage)).
- Switching from the nested desktop, Home Manager can't reach the service
  manager ("User systemd daemon not running") and skips `reloadSystemd`. So
  after every switch this
  module reloads the Steam session's user manager and applies
  `session.services.start` / `stop` / `restart`, which other modules fill
  (you can add your own units).

### Portal (`session.portalFix`)

On by default.

**Problem:** the Frame image (SteamOS 0.3.0, build 20260922) points the Steam
session's `xdg-desktop-portal` at `/usr/share/xdg-desktop-portal/gamescope-portals`,
which lacks `gamescope-portals.conf`: no backend, no OpenURI, so no app in
the Steam session can open links.

**Fix:** a portal dir in `~/.local/share` linking Valve's `.portal` files plus
a config (`default=holo;gamescope`), and a drop-in on
`xdg-desktop-portal.service`. The desktop's portal is unaffected.

**Remove when** SteamOS ships `gamescope-portals.conf`.

### Keyboard layout (`keyboard.layout`, `keyboard.variant`)

**Problem:** gamescope and its Xwayland displays use US unless
`XKB_DEFAULT_*` is set; KDE's layout only affects the nested desktop, and
`~/.config/environment.d` isn't read on the Frame.

**Fix:** a drop-in on `gamescope-session.service` setting
`XKB_DEFAULT_LAYOUT`/`VARIANT`; applies at the next Steam session start.

`keyboard.variant` picks a variant of the layout, e.g. for `de`: `null`
(standard, with dead keys: `^`, `` ` ``, `´` wait for the next key),
`"nodeadkeys"` (those are typed immediately), `"mac"`, `"neo"`, `"e1"`, `"us"`
(German letters on a US layout). List them with
`localectl list-x11-keymap-variants <layout>`.

The layout also picks the [VR keyboard](#vr-keyboard-swipe-and-suggestions-keyboardvr)'s
default dictionary language.

**Remove when** SteamOS applies a layout setting to gamescope.

### Steam keyboard patch (`keyboard.vr.extraKeys.enable`)

**Problem:** Steam's VR keyboard has no Ctrl, Alt or Esc, can't press real
keys, and its text emulation only maps plain ASCII: non-ASCII and
AltGr/dead-key characters on the German keymap (`| @ { [ ] } \ ~ ^`,
backtick, `ä ö ü €`) come out as `1`.

**What you get:**

- Bottom row: `Esc Ctrl Alt [Space] AltGr ← ↑ ↓ → Close`, stable with Shift
  or AltGr.
- AltGr + arrows: Home, End, Page Up, Page Down (hinted on the keys);
  Shift + arrows select text.
- AltGr + the key left of Backspace (`´` on German, `=` on US): Delete,
  labelled like Steam's Delete key in its language (`Entf`; `Del` if that is
  longer), hinted on the key without AltGr; repeats while held. Layouts with
  an AltGr character on that key get none.
- Layouts without AltGr (US, Dvorak, Colemak, Bulgarian, Chinese, Japanese,
  Korean) get an `Fn` key right of the space bar: Steam's AltGr toggle
  (tap: once, tap twice: locked, hold), for Delete and Home/End/Page Up/Down.
- Ctrl/Alt chords and Esc are real key presses in the VR-selected window; a
  toggled Ctrl/Alt is held down while the keyboard is open (e.g.
  Ctrl+scroll).
- Characters Steam would type as `1` are typed correctly; everything else
  goes through Steam as before.
- Enter always types Return (stock Steam may send it to a Steam search box).

Applies right away: no reboot or Steam restart needed, and it is re-applied
after Steam restarts. Turning it off reverts the keyboard.

**Layouts:** the character routing targets the German keymap; on others it
is harmless, and Esc/Ctrl/Alt/arrows work regardless.

**Security:** the helper service that presses the keys (with `xdotool` on
`:0`) only accepts single-key Ctrl/Alt chords, the extra keys, Ctrl/Alt
hold/release and single non-ASCII/AltGr characters; it cannot type ASCII
text or press Enter.

**Caveat:** depends on Steam UI internals; after a Steam update that changes
them the keyboard stays stock (see [After a Steam update](#after-a-steam-update)).
Tested with Steam client 1790377368 (UI build 11041156).

How it works: [docs/keyboard.md](docs/keyboard.md#extra-keys).

**Remove when** Steam's VR keyboard gets these keys.

### VR keyboard: swipe and suggestions (`keyboard.vr.*`)

**Problem:** Steam's VR keyboard is tap-only: no swipe typing, no
suggestions, and deleting more than a few characters means many Backspace
taps.

**What you get** with `keyboard.vr.enable` (the sub-features `swipe`,
`autocorrect`, `completions`, `backspaceDrag` and `haptics` are on by
default):

- **Swipe:** press the trigger on the first letter, sweep over the others,
  release on the last. The word is typed with a space before it if needed
  (`text.autoSpace`); alternatives show in the strip. `'` and `-` are typed,
  not swiped.
- **Suggestions** never change text by themselves: a finished tapped word
  that isn't in the dictionary gets corrections (itself first;
  `autocorrect`), a word being tapped gets completions (the typed letters
  first; `completions`). A pick replaces exactly what it typed and can be
  switched again.
- **Backspace drag:** drag Backspace left to delete one character per
  `pixelsPerChar`, with a detent (`wordDetentPixels`) at each word border
  and at the start of what the keyboard typed; drag back right to retype.
- **Strip** (`suggestions.position`): a SteamVR dashboard panel below or
  above the keyboard, or inside the keyboard over its number row. Its
  buttons take the keyboard's key style. Below/above uses the
  [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable), turned on
  automatically.
- **Haptics:** light ticks for drag steps and picks, a Snap at word detents.

**Dictionary** (`dictionary.*`): built from wordfreq frequency lists and
Hunspell, both from nixpkgs. By default the `keyboard.layout` language (de,
fr, es, it, nl, pt, sv) plus English, else English only. Add words
(`extraWords`, `extraWordFiles`), remove some (`excludeWords`) or configure
the languages, see [Options](#options).

**Text memory:** the keyboard can't read the text field, so it remembers
what it typed itself (`text.bufferChars`); anything it can't follow (Enter,
arrows, extraKeys' keys, another field, `text.resetAfterIdleSeconds`) resets
that, and suggestions only replace text the memory proves intact. Works with
and without [`keyboard.vr.extraKeys`](#steam-keyboard-patch-keyboardvrextrakeysenable)
(with it, non-ASCII words are typed via its helper).

**Caveats:** depends on Steam/SteamVR UI internals; after an update that
changes them the keyboard stays stock (see
[After a Steam update](#after-a-steam-update)). Accented words of other
languages are in the dictionary but only swipable where the layout has the
letters.

How it works, tests, debugging: [docs/keyboard.md](docs/keyboard.md#swipe-and-suggestions).

**Remove when** Steam's VR keyboard gets swipe typing and suggestions.

### Launcher menu (`launcherMenu.*`)

**Problem:** the VR dashboard's "+" menu (non-Steam programs) is in random
order with "Desktop" somewhere in a scrolling list, and a click shows no
feedback until the window appears, so programs often get started twice.

**What you get** (patches of Steam's UI):

- `sort`: programs sorted by name (case-insensitive), Desktop included.
- `pinDesktop = "top"` / `"bottom"`: Desktop pinned above/below the list,
  always visible. **Limitation:** the pinned copy works with the laser but
  not with thumbstick / D-pad navigation.
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
  Hide single programs with [`hiddenApps`](#hidden-apps-launchermenuhiddenapps).

All revert when turned off (next switch). Tested with Steam client
1790377368. How it works: [docs/launcher-menu.md](docs/launcher-menu.md).

#### Hidden apps (`launcherMenu.hiddenApps`)

**Problem:** with Developer Mode or `showAllApps`, the "+" menu lists every
desktop entry, including system tools.

**Fix:** list desktop entry ids (no `.desktop`); a user entry with
`Hidden=true` in `~/.local/share/applications` masks the system one (also in
the KDE menu). The "+" menu always hides `steam` and `vrurlhandler`; for
Konsole in VR use [`showAllApps`](#launcher-menu-launchermenu).

#### Icon fallbacks (`launcherMenu.iconFallbacks`)

On by default.

**Problem:** Steam resolves `Icon=` only in the hicolor theme (and
`pixmaps`), so Konsole and KDE System Settings, whose icons only Breeze has,
show without icon.

**Fix:** links nixpkgs' Breeze SVGs of `utilities-terminal` and
`preferences-system` (plus `extra`) into
`~/.local/share/icons/hicolor/scalable/apps/`; a name Breeze doesn't have
fails the build, `enable = false` provides none. A running Steam picks up
changes without a restart. Each switch also prints hints: icons of programs
Steam can't find that Breeze has (add them to `extra`), and fallbacks
hicolor has anyway.

`iconFallbacks` used to be a list; a list now fails with a hint (use
`extra`, or `enable = false` for `[ ]`). How it works and migration from the
2026-09 script: [docs/launcher-menu.md](docs/launcher-menu.md#icon-fallbacks).

### SteamVR dashboard patches

The next four features patch SteamVR's dashboard while it runs. Each turns
on the [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)
(**the first time, restart SteamVR once**). They depend on SteamVR UI
internals: after an update that changes them the dashboard stays stock (see
[After a Steam update](#after-a-steam-update)). Tested with SteamVR build
11008059. All are laser-only: gamepad navigation sees the stock dashboard.
How they work and debugging: [docs/dashboard.md](docs/dashboard.md).

### Dashboard windows (`dashboard.windows.*`)

**Problem:** SteamVR dashboard windows can only be enlarged to 2x, and
grabbed windows pushed back only to 5 m (6 m in theater), too close for a big
screen.

**Fix:** raises these limits (`null` keeps stock):

| Option | Stock |
|---|---|
| `maxScale` | 2 (relative to the window's default size; the theater screen's default is 2.8x larger) |
| `distance.world.{min,max}` | 0.25-5 m |
| `distance.theater.{min,max}` | 1-6 m |
| `distance.dashboard.{min,max}` | 0.3-4 m |

Distances limit pulling in / pushing back a grabbed window (thumbstick or
scroll while dragging). Changes apply immediately, and turning options off
reverts on the next switch. The keyboard's range is not patched.

```nix
steamFrame.dashboard.windows = {
  maxScale = 4.0;              # resize up to 4x (theater: 11.2x)
  distance.world.max = 10.0;   # push windows back up to 10 m
  distance.theater.max = 12.0;
};
```

**Caveat:** if SteamVR changes its stock grab distances, the distance options
silently do nothing.

### Steam close button (`dashboard.steamCloseButton.enable`)

**Problem:** every dashboard window has a close (X) button except Steam's
own, and with no other window open the dashboard always shows it.

**Fix:** gives the Steam window an X that hides Steam: it docks the window
back if it was in the world, theater or on a hand, then shows the most
recently active other dashboard window, or **just the dashboard bar** if
there is none.

Steam stays hidden until you bring it back (Steam tab, a Steam menu pick,
SteamVR asking for it): closing the active window, or a theater window,
then goes to the previous window or the bar instead of Steam. This survives
dashboard reopens, patch-service restarts, SteamVR restarts and reboots
("Steam hidden" is saved in
`~/.local/state/steam-frame-nix/ui-patches/steam-close-button.json`, see
[Changes outside Nix](#changes-outside-nix-exceptions)). After a restart the
patch attaches a few seconds after the dashboard appears, possibly after
SteamVR has already shown Steam: if Steam is (or first becomes) the active
window then, it is hidden once like with X (only the bar at that point);
otherwise it just stays hidden.

**Limitations:** SteamVR's rarer "go home" paths (Now Playing after a game
quits, message overlays) still show Steam; no effect with a VRLink remote
dashboard; turning the option off while bar-only leaves no active window
until the next tab click or dashboard open.

### Window curvature (`dashboard.windowCurvature.*`)

**Problem:** SteamVR dashboard windows are either curved (fixed radius) or
flat, and world windows start flat.

**Fix:** turns the "Toggle Curvature" row of a window's three-dot menu into
a control showing the window's value; the same control in the bottom bar
(see [window control bar](#window-control-bar-dashboardframecontrols)) works
without the value, with haptic steps.

- **click:** curved → flat, flat → stock (1);
- **drag up/down** with the laser: curvature from 0 (flat) to `max`,
  relative to stock (2 = half the radius), rounded to `step`, with a detent
  of `detentPixels` of drag at each of `detentPoints` (no values skipped),
  and haptics (`haptics`) for detents, edges and steps. Drag distance:
  `dragPixelsPerUnit` in the menu, `barDragPixelsPerUnit` on the bar button,
  after `dragThresholdPixels`.

A window without its own value is shown at `initial` once curved in the
world or on a hand, at 1 in the dashboard or theater. Values are kept per
window until SteamVR restarts.

**Limitations:**

- Laser only; with gamepad navigation the row is the stock toggle.
- No thumbstick scrolling (SteamVR sends no wheel events to the menu).
- The laser stops at the menu's edge (~190 px above the row): with the
  default 120 px per 1.0, 0 → 1 fits into one drag, 0 → 3 takes two. Lower
  `dragPixelsPerUnit` (≤ 60) for the full range in one drag.

### Window control bar (`dashboard.frameControls.*`)

**Problem:** the controls under a dashboard window are fixed: some in the
bottom bar, others only in the three-dot menu (curvature, dock to a
controller), and theater windows have no "Float".

**Fix:**

- **long press** a bar icon or menu row (`longPressMs`; a progress ring
  shows from half the time, at most after 1 s), then **Show in bar** in the
  popup moves that control between bar and menu **for all windows**.
  Placements survive SteamVR restarts and reboots (saved in
  `~/.local/state/steam-frame-nix/ui-patches/frame-controls.json`, see
  [Changes outside Nix](#changes-outside-nix-exceptions)).
- `inBar` / `inMenu` set where controls start; a popup choice wins until
  that control's entry changes.
- `floatInTheater` gives theater windows the "Float" control.

```nix
steamFrame.dashboard.frameControls = {
  enable = true;
  # longPressMs = 1500;
  # inBar = [ "curvature" ];  inMenu = [ "theater" ];
  # floatInTheater = true;
};
```

With [window curvature](#window-curvature-dashboardwindowcurvature), a drag
on the curvature control adjusts curvature and cancels the long press, also
after the ring shows; once the ring shows, the drag needs 3× the usual
travel (`dragThresholdPixels`, counted from where the press started), so
laser drift during the hold doesn't cancel it.

**Limitations:** laser only (no right-click or thumbstick click reaches the
dashboard; gamepad navigation sees stock controls); placements are per
control type, not per window; the three-dot button itself can't be moved.

### SteamVR debugger (`steamvrDebugger.enable`)

Dashboard patches (and the VR keyboard's strip below/above the keyboard)
need SteamVR's DevTools port, which SteamVR opens only with its setting
`VRWebHelper/DebuggerEnabled`. It is enabled automatically when any patch in
`steamFrame.uiPatches.patches` uses port 8087; nothing to set.

The setting lives in `~/.config/openvr/config/steamvr.vrsettings`, which
SteamVR rewrites, so it can't be a Nix link. It is **set only while SteamVR
runs**: set before every SteamVR start, put back to its previous value when
SteamVR stops, also after a rollback or uninstall (without Nix). A value you
set to `true` yourself is never touched.

**The first time, restart SteamVR once** (e.g. reboot); until then the
dashboard patches wait. Turned off, the setting is restored at the switch
(or when SteamVR stops, if it runs).

**Security:** the port listens on `127.0.0.1` only; keep Developer Mode off
(see [DevTools on the LAN](#devtools-on-the-lan)).

How it works: [docs/steamvr-debugger.md](docs/steamvr-debugger.md).

### Clipboard sync (`clipboardSync.enable`)

On by default.

**Problem:** the Steam session's X displays and the nested desktop have
separate clipboards.

**Fix:** [clipboard-sync](https://github.com/dnut/clipboard-sync), built from
source (its flake is x86-only; `clipboardSync.package` to replace it),
started via KDE autostart (the desktop can't reach the user manager, and
`:2` must exist first). Each switch restarts it if outdated, so switch from
a desktop terminal.

### Firefox (`firefox.*`)

For the Flathub Firefox Flatpak (`org.mozilla.firefox`, stable; install it
yourself). The launcher shadows the Flatpak's own entry (same ID), so
default-browser associations keep working.

- **`vrFullscreenFix`** (on): gamescope never shows fullscreen windows, so
  Firefox looks frozen. `full-screen-api.ignore-widgets` makes fullscreen
  fill just the window. Not applied in the desktop profile. **Remove when**
  gamescope shows fullscreen X11 windows in VR.
- **`disableAv1`** (off): `media.av1.enabled = false`. The Frame's decoder
  driver (`iris`) has no AV1, only H.264, HEVC and VP9, so YouTube and co.
  send VP9/H.264, decoded in hardware, instead of software AV1. **Remove
  when** a SteamOS kernel adds AV1 to `iris`.
- **`prefs`:** further `about:config` values for every profile; they can
  also override the fixes above.
- **`desktopProfile`** (`"desktop"`): the sessions can't see each other's
  Firefox, so a second instance stops at the locked profile; in the nested
  desktop the launcher uses this separate profile (a normal Firefox profile
  with its own browser data, created on first use). `null`: the default
  profile in both sessions.

`prefs` and the fixes are *default* values, not user values: `about:config`
can still change them per profile, and removing one leaves nothing behind.
Changes take effect at the next start of Firefox. A `user.js` of your own in
the desktop profile is never touched (the fullscreen fix then stays on
there). A `org.mozilla.firefox.systemconfig` Flatpak extension of your own
would conflict with the one this module provides.

How it works: [docs/firefox.md](docs/firefox.md).

### Jellyfin hardware decoding (`jellyfin.hardwareDecoding.*`)

For the Flathub [Jellyfin Desktop](https://github.com/jellyfin/jellyfin-desktop)
Flatpak (`org.jellyfin.JellyfinDesktop`), which plays video with libmpv.

**Problem:** video is decoded in software (1080p H.264: ~40 % CPU). The
Frame's hardware decoder is a V4L2 memory-to-memory device (`qcom-iris`,
`/dev/video*`), which the Flatpak can't open (its `devices=dri` covers only
the GPU) and mpv never tries (Jellyfin hard-sets `hwdec=auto-copy`, whose
probing leaves out V4L2 M2M, and has no way to pass mpv options).

**Fix:** the Jellyfin desktop entry (same ID as the Flatpak's, so the KDE
menu and the "+" menu start it) runs the Flatpak with device access
(`devices=all`) and makes mpv use `hwdec` (default
`v4l2m2m-copy,auto-copy`); explicit values such as `no` stay. mpv tries the
listed decoders in order and falls back to software decoding per stream.
With the default, 1080p H.264 plays at ~15-20 % CPU. Nothing is written to
Flatpak's overrides: it applies to launches from that entry and is gone with
it. Changes take effect at the next start of Jellyfin.

Installing the Flatpak is up to you, e.g.
`flatpak install --user flathub org.jellyfin.JellyfinDesktop`, or with
nix-flatpak:

```nix
services.flatpak.packages = [ "org.jellyfin.JellyfinDesktop" ];
```

From a terminal, start it with the command line of
`steamFrame.jellyfin.hardwareDecoding.command` (or `grep ^Exec=
~/.local/share/applications/org.jellyfin.JellyfinDesktop.desktop`); its
output shows `mpv-hwdec-shim: hwdec "auto-copy" -> "v4l2m2m-copy,auto-copy"`,
then mpv's `Using hardware decoding (v4l2m2m-copy)`.

**Caveats:**

- `devices=all` gives the app all of `/dev` (cameras, input devices, ...),
  not just the decoder.
- V4L2 M2M decoding quality varies with drivers and codecs. Tested: 8-bit
  H.264; 10-bit HEVC is untested. mpv falls back to software only when the
  decoder fails; for streams that decode with artifacts, disable the option
  (or set `hwdec = "auto-copy"`, Jellyfin's own value).

How it works: [docs/jellyfin.md](docs/jellyfin.md).

## UI patches (`uiPatches.patches`)

Steam's UI and SteamVR's dashboard are web pages; the launcher menu,
dashboard and VR keyboard features patch them while they run, over their
local DevTools ports. Steam's files are never modified, and turning a
feature off (or stopping the `steam-ui-patches` / `steam-keyboard-patch`
user services) restores the stock UI without a Steam restart. Log:
`journalctl --user -u steam-ui-patches -u steam-keyboard-patch`.

You can add your own patches with `steamFrame.uiPatches.patches`; see
[docs/ui-patches.md](docs/ui-patches.md) (patch definition, persistent state,
finders and signatures, `mkPatch`, shared hooks).

### DevTools on the LAN

Steam's Developer Mode enables `steam-web-debug-portforward`
(`0.0.0.0:8081` → `8080`) and `steamvr-web-debug-portforward`
(`0.0.0.0:8088` → `8087`), and firewalld allows ports 1024-65535, so anyone
on the network could run code in Steam's UI. No patch needs Developer Mode,
so keep it off. If it was on while those units were masked, they may stay
enabled: check with
`systemctl is-enabled steam-web-debug-portforward steamvr-web-debug-portforward`
and `sudo systemctl disable` them.

### After a Steam update

The patches find Steam's code by signature. If a Steam or SteamVR update
changes it so a signature no longer matches exactly once, that patch changes
nothing: the feature stays stock and the journal (above) says why, e.g.
`signature not found, Steam left unpatched: …`. Update steam-frame-nix
(`nix flake update steam-frame-nix`, then switch) once it supports the new
build. Checking and fixing signatures:
[docs/ui-patches.md](docs/ui-patches.md#after-a-steam-update).

## Changes outside Nix (exceptions)

Everything not listed here is a Home Manager link into the Nix store or
lives in memory (the UI patches). These are written at runtime:

| Path | Feature | Lifetime | Removed by |
|---|---|---|---|
| `VRWebHelper.DebuggerEnabled` in `~/.config/openvr/config/steamvr.vrsettings` | [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable) | only while SteamVR runs | SteamVR stopping (runtime drop-in below); `steam-frame-nix-cleanup` while SteamVR is stopped |
| `~/.local/state/steam-frame-nix/steamvr-debugger.armed` | SteamVR debugger: the key's previous value | while SteamVR runs; after a power loss until the next SteamVR start or cleanup | SteamVR stopping; `steam-frame-nix-cleanup` |
| `/run/user/1000/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf`, `/run/user/1000/steam-frame-nix/steamvr-debugger-restore` | SteamVR debugger: puts the key back when SteamVR stops, without Nix | until reboot (tmpfs) | reboot; `steam-frame-nix-cleanup` while SteamVR is stopped and the debugger is off |
| `~/.local/state/steam-frame-nix/ui-patches/<name>.json` | Saved choices of dashboard patches: window control bar placements (`frame-controls`), "Steam hidden" (`steam-close-button`). SteamOS's `steamvr.service` deletes `~/.cache/SteamVR` (the dashboard's own browser storage) on every SteamVR start. | until removed: kept when a patch is disabled (the choices come back when you enable it again) | `steam-frame-nix-cleanup --all`, `install.sh uninstall` |
| mtime of `~/.local/share/icons/hicolor` | [icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks): a running Steam rescans icons | only the directory's timestamp | nothing to remove |

**`steam-frame-nix-cleanup`** (`install.sh cleanup`,
`steamFrame.cleanup.package`) knows everything any version of
steam-frame-nix wrote outside the store, removes only what is provably its
own (everything else is reported as "left alone") and can be run again
safely; `--dry-run` shows what it would do.

- On every switch, `cleanup --orphans` removes what the configuration no
  longer uses (never the saved patch state).
- `steam-frame-nix-cleanup --all` removes everything, also the saved patch
  state. SteamVR's key can't be changed while SteamVR runs: it is then left
  to the runtime drop-in (restored when SteamVR stops).
- Without Nix or after a rollback it runs from the script
  (bash, coreutils, findutils, jq, all in SteamOS' `/usr/bin`):
  `curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all`.
- It also removes what older versions left (icon fallback links, Firefox
  `user.js` files and their values, Jellyfin Flatpak override entries, ...;
  list: [docs/changes-outside-nix.md](docs/changes-outside-nix.md#left-by-older-versions)).

### Only while running

- The UI patches (Steam, SteamVR dashboard, VR keyboard) live in the pages'
  memory; stopping `steam-ui-patches` / `steam-keyboard-patch` reverts them.
- clipboard-sync runs from KDE autostart (a Home Manager link).
- Firefox: the desktop profile's `user.js` link exists only while its
  Firefox runs (see [docs/firefox.md](docs/firefox.md#desktop-profile)).
- Jellyfin: the hardware decoding permissions are `flatpak run` options of
  the desktop entry, not a Flatpak override.

### Set up by install.sh

`install.sh install` (the bootstrap, not the modules) also installs Nix
(`/nix`, files in `/etc`), `~/nix-config` with the link
`~/.config/home-manager`, Nix's and Home Manager's per-user state, and
renames conflicting dotfiles to `*.hm-backup-<time>`; `install.sh uninstall`
undoes it (full list:
[docs/changes-outside-nix.md](docs/changes-outside-nix.md#set-up-by-installsh)).

### App data you create

Not steam-frame-nix's to remove: the Firefox desktop profile
(`~/.var/app/org.mozilla.firefox/config/mozilla/firefox/desktop`, browser
data), and whatever apps keep in `~/.var/app/*`, Flatpak apps and their
runtimes.

## Rollback

`home-manager generations` lists previous generations; run
`<store path>/activate` of the one you want. Generations with
steam-frame-nix clean up after themselves on activation (orphans). After
rolling back to a generation **without** steam-frame-nix, or to one older
than `steam-frame-nix-cleanup` (2026-09-29), remove what the newer one wrote
outside the store:

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all
# or: nix run github:lhns/steam-frame-nix#cleanup -- --all
```

## Uninstall

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
```

stops Home Manager's user services (reverting the UI patches), runs
`cleanup --all`, runs `home-manager uninstall`, then removes Nix and the
per-user Nix state (see [Set up by install.sh](#set-up-by-installsh)). If
SteamVR is running, its key is restored when SteamVR stops (the closing
message says so). Your configuration, `*.hm-backup-*` files, app data and
Flatpaks stay.

To drop steam-frame-nix from a Home Manager configuration you keep, first
run `steam-frame-nix-cleanup --all`, then remove it and switch. Or set Home
Manager's `uninstall = true;` in the configuration that still imports
steam-frame-nix and switch: its activation runs `cleanup --all` while Home
Manager removes its files. (`home-manager uninstall` alone doesn't load
steam-frame-nix's modules, so it can't clean up after them.)

## License

[Apache License 2.0](LICENSE).
