# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame (SteamOS, `aarch64-linux`, standalone home-manager). They
work around quirks of the Frame's [two graphical sessions](docs/two-sessions.md),
enable hardware video decoding in Jellyfin, and extend Steam's and SteamVR's
UIs at runtime.

Everything is declarative: files are links into the Nix store, UI patches
live in memory. The few things written elsewhere are
[listed](docs/changes-outside-nix.md) and removed by `steam-frame-nix-cleanup`.

## Features

All options live under `steamFrame.*`; the portal fix and clipboard sync are
on by default, everything else is opt-in. Full reference:
[docs/options.md](docs/options.md).

Session and desktop:

- [Portal fix](docs/desktop-integration.md#portal) (`session.portalFix`):
  apps in the Steam session can open links.
- [Clipboard sync](docs/desktop-integration.md#clipboard-sync)
  (`clipboardSync`): one clipboard for the Steam session and the nested
  desktop.
- [Session settings](docs/desktop-integration.md#session-settings-and-services)
  (`session.*`): outer bus and user services, for launchers and the other
  modules.

Keyboard:

- [Keyboard layout](docs/keyboard.md#layout) (`keyboard.layout`,
  `keyboard.variant`): XKB layout for the Steam session.
- [Extra keys](docs/keyboard.md#extra-keys) (`keyboard.vr.extraKeys`):
  Esc/Ctrl/Alt, arrows, Delete, real chords and AltGr/non-ASCII characters
  on the VR keyboard.
- [Swipe and suggestions](docs/keyboard.md#swipe-and-suggestions)
  (`keyboard.vr`): swipe typing, corrections, completions, Backspace drag.

VR "+" menu:

- [Launcher menu](docs/launcher-menu.md#menu-patches) (`launcherMenu.*`):
  sorted, Desktop pinned, closes on launch, no double launches, grid of
  tiles, all programs without Developer Mode.
- [Hidden apps](docs/launcher-menu.md#hidden-apps)
  (`launcherMenu.hiddenApps`) and
  [icon fallbacks](docs/launcher-menu.md#icon-fallbacks)
  (`launcherMenu.iconFallbacks`, on) for Konsole and KDE System Settings.

SteamVR dashboard ([needs the SteamVR debugger](docs/steamvr-debugger.md),
turned on automatically):

- [Dashboard windows](docs/dashboard.md#dashboard-windows)
  (`dashboard.windows`): larger max scale and push-back distance.
- [Steam close button](docs/dashboard.md#steam-close-button)
  (`dashboard.steamCloseButton`): an X that hides the Steam window.
- [Window curvature](docs/dashboard.md#window-curvature)
  (`dashboard.windowCurvature`): adjustable curvature per window.
- [Window control bar](docs/dashboard.md#window-control-bar)
  (`dashboard.frameControls`): move controls between bar and three-dot menu.

Apps:

- [Firefox](docs/firefox.md) (`firefox`): launcher for the Flatpak with a VR
  fullscreen fix, optional AV1 off, a separate desktop profile.
- [Jellyfin](docs/jellyfin.md) (`jellyfin.hardwareDecoding`): hardware video
  decoding in the Jellyfin Desktop Flatpak.

Writing your own patches of Steam's UI: [docs/ui-patches.md](docs/ui-patches.md)
(also: checking signatures after a Steam update).

## Install

On the Frame (or a Steam Deck), in a terminal (Konsole in desktop mode or the
nested desktop):

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
```

The short link redirects to
[`install.sh`](https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh)
on `main`. `sudo` needs a password: run `passwd` first if you never set one.

It installs Nix (unless it already works), creates `~/nix-config` from the
[template](template) (or uses `~/.config/home-manager`, or
`--flake <dir-or-flakeref>`) and runs `home-manager switch`; conflicting
dotfiles are renamed to `*.hm-backup-<time>`. Details:
[set up by install.sh](docs/changes-outside-nix.md#set-up-by-installsh).
Re-running it just switches again.

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- status      # Nix, generation, services
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
```

**Manual setup** (Nix with flakes and standalone home-manager):
`nix flake init -t github:lhns/steam-frame-nix` creates a commented
`flake.nix` and `home.nix` ([`template/`](template)). Or add the input to
your own flake:

```nix
inputs.steam-frame-nix = {
  url = "github:lhns/steam-frame-nix";
  inputs.nixpkgs.follows = "nixpkgs";
};
# homeManagerConfiguration { modules = [ steam-frame-nix.homeManagerModules.default ./home.nix ]; … }
```

`default` imports all modules; single ones:
`homeManagerModules.{session,portal,keyboard-layout,steam-keyboard-patch,vr-keyboard,hidden-apps,steam-ui-patches,launcher-menu,steamvr-debugger,cleanup,dashboard-windows,steam-close-button,window-curvature,frame-controls,clipboard-sync,firefox,jellyfin}`
(each imports `cleanup`).

## Usage

In `~/nix-config/home.nix` (the template's example, uncommented):

```nix
steamFrame = {
  keyboard.layout = "de";
  keyboard.vr.extraKeys.enable = true;  # Esc/Ctrl/Alt/arrows in VR
  keyboard.vr.enable = true;            # swipe, suggestions, Backspace drag
  launcherMenu = {
    sort = true;
    pinDesktop = "bottom";
    closeOnLaunch = true;
    launchDebounceSeconds = 10;
    grid = { enable = true; columns = 4; maxRows = 4; };
    showAllApps = true;
    # Listed in the "+" menu only with showAllApps or Developer Mode:
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
  jellyfin.hardwareDecoding.enable = true;
};
```

Then switch from a terminal **in the nested desktop** (so clipboard-sync
restarts with the desktop's environment):

```sh
home-manager switch   # manual setup: --flake <dir>#<user>
```

## Rollback and uninstall

Run `<store path>/activate` of a generation from `home-manager generations`.
After rolling back to a generation without steam-frame-nix (or older than
2026-09-29), remove what the newer one wrote outside the store:

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all
# or: nix run github:lhns/steam-frame-nix#cleanup -- --all
```

`install.sh uninstall` (above) reverts the UI patches, runs `cleanup --all`,
`home-manager uninstall` and removes Nix; your configuration, backups, app
data and Flatpaks stay. To drop steam-frame-nix from a configuration you
keep, run `steam-frame-nix-cleanup --all` first, then remove it and switch.
Details: [rollback](docs/changes-outside-nix.md#rollback),
[uninstall](docs/changes-outside-nix.md#uninstall).

## License

[Apache License 2.0](LICENSE).
