# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame (SteamOS, `aarch64-linux`, standalone home-manager). They
work around quirks of the Frame's [two graphical sessions](#two-sessions)
(portal, KDE app menu, keyboard layout, clipboard, KDE wallet, Firefox),
enable hardware video decoding in Jellyfin, run rootless Docker, and extend
Steam's and SteamVR's UIs at runtime (VR keyboard, "+" menu, dashboard
windows, Steam close button, window curvature, window controls, a VR pet).

Everything is declarative: files are links into the Nix store, UI patches
live in memory. The few things that have to be written elsewhere at runtime
are listed under [Changes outside Nix](#changes-outside-nix-exceptions), with
their lifetime and what removes them; `steam-frame-nix-cleanup` removes every
one of them (on each switch what the configuration no longer uses, `--all`
for everything).

All options live under `steamFrame.*`. The portal fix, the applications menu
and clipboard sync are on by default; everything else is opt-in.

## Features

One page per feature in [`docs/`](docs): problem, what you get,
configuration, limitations and how it works.

**Session** ([docs/session.md](docs/session.md)):

- [Session settings](docs/session.md#session-settings-and-services) (`session.*`): outer bus and user services, for launchers and the other modules.
- [Portal fix](docs/session.md#portal-fix) (`session.portalFix`, on): apps in the Steam session can open links, and Flatpak apps get KDE's file dialog.
- [Applications menu](docs/session.md#applications-menu) (`session.applicationsMenu`, on): KDE apps in the Steam session (Dolphin from the "+" menu) know the installed apps.
- [Keyboard layout](docs/session.md#keyboard-layout) (`keyboard.layout`, `keyboard.variant`): XKB layout for the Steam session.
- [Clipboard sync](docs/session.md#clipboard-sync) (`clipboardSync`, on): one clipboard for the Steam session and the nested desktop.

**VR keyboard** ([docs/keyboard.md](docs/keyboard.md)):

- [Extra keys](docs/keyboard.md#extra-keys) (`keyboard.vr.extraKeys`): Esc/Ctrl/Alt, arrows, Delete, Shift+Tab, real chords and AltGr/non-ASCII characters.
- [Swipe and suggestions](docs/keyboard.md#swipe-and-suggestions) (`keyboard.vr`): swipe typing, corrections, completions, Backspace drag, F1–F12 on AltGr.
- [Touch typing](docs/keyboard.md#touch-typing) (`keyboard.vr.touchTyping`): press keys by touching them with the controller's tip, both hands.

**VR "+" menu** ([docs/launcher-menu.md](docs/launcher-menu.md)):

- [Launcher menu](docs/launcher-menu.md) (`launcherMenu.*`): sorted, Desktop pinned, closes on launch, no double launches, grid of tiles, all programs without Developer Mode.
- [Hidden apps](docs/launcher-menu.md#hidden-apps) (`launcherMenu.hiddenApps`) and [icon fallbacks](docs/launcher-menu.md#icon-fallbacks) (`launcherMenu.iconFallbacks`, on) for Konsole and KDE System Settings.

**SteamVR dashboard** ([dashboard patches](docs/ui-patches.md#steamvr-dashboard-patches)):

- [Dashboard windows](docs/dashboard-windows.md) (`dashboard.windows`): larger max scale and push-back distance.
- [Steam close button](docs/steam-close-button.md) (`dashboard.steamCloseButton`): an X that hides the Steam window.
- [Window curvature](docs/window-curvature.md) (`dashboard.windowCurvature`): adjustable curvature per window.
- [Window control bar](docs/window-control-bar.md) (`dashboard.frameControls`): move controls between bar and three-dot menu.
- [VR pet](docs/pet.md) (`pet`): a cat (five coats), Shiba Inu, Fox or Dachshund in the scene that walks around you, can be picked up and petted; "Pet" in the "+" menu, the `vr-pet` command, your own models.
- [SteamVR debugger](docs/steamvr-debugger.md) (`steamvrDebugger`, automatic): SteamVR's DevTools port for these, set only while SteamVR runs.

**Apps:**

- [Firefox](docs/firefox.md) (`firefox`): launcher for the Flatpak with a VR fullscreen fix, optional AV1 off, a separate desktop profile, optionally the default browser.
- [Jellyfin](docs/jellyfin.md) (`jellyfin.hardwareDecoding`): hardware video decoding in the Jellyfin Desktop Flatpak.
- [Launchers](docs/launchers.md) (`launchers.<desktop ID>`): an app's own desktop entry (Flatpak, Nix package) with extra options, environment, wrappers and MIME defaults; `keyring` keeps its KDE wallet logins in both sessions (Electron too).
- [Docker](docs/docker.md) (`docker`): rootless Docker as a user service, CLI working in both sessions.
- [SteamVR screenshots](docs/screenshots.md) (`screenshots`): `~/Pictures/SteamVR Screenshots`, a link to Steam's folder of the current account.

**Your own patches** of Steam's UI, and fixing patches after a Steam update: [UI patches](docs/ui-patches.md).

**Working on steam-frame-nix:** [Development](docs/development.md) (repository layout: which file runs where, runtime names, checks).

## Install

On the Frame (or a Steam Deck), in a terminal (Konsole in desktop mode or the
nested desktop):

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
```

The short link redirects to
[`install.sh`](https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh)
on `main`. `sudo` needs a password: run `passwd` first if you never set one.

The installer installs Nix (skipped if Nix already works), uses
`~/.config/home-manager` or `--flake <dir-or-flakeref>` (if there is none, it
creates `~/nix-config` from the [template](template) with your user name) and
runs `home-manager switch`; what it sets up is listed under
[Set up by install.sh](#set-up-by-installsh). Re-running it just switches
again (`--yes` answers every question). Afterwards edit
`~/nix-config/home.nix` and switch (see [Usage](#usage)).

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- status      # Nix, generation, services
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all   # see Changes outside Nix
```

`bash -s -- --help` lists all commands and flags. See
[Uninstall](#uninstall) for what `uninstall` removes and keeps.

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
  ([session settings](docs/session.md#session-settings-and-services)).
- **Wallet:** there should be one `kwalletd6`, on the outer bus; apps started
  from the desktop would otherwise start a second one whose secrets VR can't
  see. Give such apps a [launcher](docs/launchers.md) with `keyring.enable`.
- **Launchers:** the "+" menu only sees `~/.local/share/applications` (not
  `~/.nix-profile/share`), so [launchers](docs/launchers.md) are linked
  there, replacing Flatpak/package entries with the same ID.
- **Keyboard layout, clipboard, Firefox:** each session has its own; see
  [keyboard layout](docs/session.md#keyboard-layout),
  [clipboard sync](docs/session.md#clipboard-sync),
  [Firefox](docs/firefox.md#desktop-profile) (desktop profile).

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
# home.nix (the template has steamFrame commented out)
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
    pet.enable = true;                        # VR pet (bakes ~0.5 GB of models)
    firefox.enable = true;
    firefox.disableAv1 = true;
    firefox.defaultBrowser = true;
    jellyfin.hardwareDecoding.enable = true;  # install the Flatpak yourself
    launchers."im.riot.Riot" = {              # Element: logins in both sessions
      keyring = { enable = true; electron = true; };
      defaultFor = [ "x-scheme-handler/element" "x-scheme-handler/io.element.desktop" ];
    };
    docker.enable = true;                     # rootless
  };
}
```

Switch from a terminal in the nested desktop (see [Two sessions](#two-sessions)):

```sh
home-manager switch                    # config in ~/.config/home-manager (installer)
home-manager switch --flake .#steamos  # manual setup, from the flake's directory
```

In your own flake, add the input as above and
`steam-frame-nix.homeManagerModules.default` to the modules. `default`
imports all modules; single ones:
`homeManagerModules.{session,portal,applications-menu,keyboard-layout,vr-keyboard-extra-keys,vr-keyboard,hidden-apps,steam-ui-patches,launcher-menu,steamvr-debugger,cleanup,dashboard-windows,steam-close-button,window-curvature,frame-controls,clipboard-sync,firefox,jellyfin,launchers,docker,screenshots,pet}`
(`steam-keyboard-patch` and `keyring` still work as the former names of
`vr-keyboard-extra-keys` and `launchers`). Every module imports `cleanup` (see
[Changes outside Nix](#changes-outside-nix-exceptions)); which file is
which: [Repository layout](docs/development.md).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.session.runtimeDir` | str | `"/run/user/1000"` | `XDG_RUNTIME_DIR` of the outer (Steam/VR) session. |
| `steamFrame.session.bus` | str | `"unix:path=${runtimeDir}/bus"` | Outer session D-Bus (user manager, `kwalletd6`). |
| `steamFrame.session.busEnv` | str, read-only | `"env DBUS_SESSION_BUS_ADDRESS=${bus}"` | `Exec=` prefix for hand-written entries that must use the outer bus. |
| `steamFrame.session.services.start` | list of str | `[ ]` | User units started on switch if not running. |
| `steamFrame.session.services.restart` | list of str | `[ ]` | User units restarted on every switch. |
| `steamFrame.session.services.stop` | list of str | `[ ]` | User units stopped on switch if running (e.g. of a disabled feature). |
| `steamFrame.session.portalFix.enable` | bool | `true` | Working portal config (OpenURI) for the Steam session. |
| `steamFrame.session.portalFix.fileChooser` | bool | `true` | KDE's file dialog as the Steam session's FileChooser portal (Flatpak apps can open and save files outside their sandbox). Needs `portalFix.enable`. |
| `steamFrame.session.applicationsMenu.enable` | bool | `true` | `~/.config/menus/applications.menu` linked to Plasma's, for KDE apps in the Steam session. |
| `steamFrame.keyboard.layout` | null or str | `null` | XKB layout for the Steam session, e.g. `"de"`; `null`: US. |
| `steamFrame.keyboard.variant` | null or str | `null` | XKB variant for the Steam session, e.g. `"nodeadkeys"`; see [Keyboard layout](docs/session.md#keyboard-layout). |
| `steamFrame.keyboard.vr.extraKeys.enable` | bool | `false` | VR keyboard with Esc/Ctrl/Alt, arrows, real chords, AltGr/non-ASCII. |
| `steamFrame.keyboard.vr.enable` | bool | `false` | Swipe typing, suggestions and Backspace drag on the VR keyboard; the sub-features below are on by default, see [VR keyboard](docs/keyboard.md#swipe-and-suggestions). |
| `steamFrame.keyboard.vr.swipe.enable` | bool | `true` | Swipe typing. |
| `steamFrame.keyboard.vr.swipe.twoHanded` | bool | `true` | Swipes also with both lasers on the keyboard: the path from the pressing controller's pose, see [VR keyboard](docs/keyboard.md#swipe-and-suggestions). |
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
| `steamFrame.keyboard.vr.functionKeys.enable` | bool | `false` | F1–F12 in the suggestion strip while AltGr (or Fn) is active, pressed with the active Ctrl/Alt/Shift; the suggestions come back unchanged. Needs `keyboard.vr.enable`, `keyboard.vr.extraKeys.enable` and `suggestions.position` `"above"`/`"below"`, see [VR keyboard](docs/keyboard.md#swipe-and-suggestions). |
| `steamFrame.keyboard.vr.haptics` | bool | `true` | Haptic ticks for drag steps, word detents and picks. |
| `steamFrame.keyboard.vr.checks` | package, read-only | | The tests, built with the configured dictionary. |
| `steamFrame.keyboard.vr.touchTyping.enable` | bool | `false` | Touch typing: a key is pressed when a controller's tip touches it, both hands; the lasers work as before, see [Touch typing](docs/keyboard.md#touch-typing). |
| `steamFrame.keyboard.vr.touchTyping.depth` | number | `0` | How far behind the keyboard's surface a touch registers (cm, `-2` to `5`; negative: in front). |
| `steamFrame.keyboard.vr.touchTyping.haptics` | bool | `true` | A haptic tick when a touch presses a key. |
| `steamFrame.uiPatches.patches` | list of submodules | `[ ]` | Runtime patches of Steam's web UIs, see [UI patches](docs/ui-patches.md#defining-a-patch). Fields below. |
| `steamFrame.uiPatches.patches.*.name` | str | required | Unique name (log). |
| `steamFrame.uiPatches.patches.*.endpoint` | str | `"http://127.0.0.1:8080"` | DevTools base URL, `/json/list` polled every 5 s: Steam 8080, SteamVR 8087. |
| `steamFrame.uiPatches.patches.*.target.{title,titleRegex,urlRegex}` | null or str | `null` | Pages to patch: exact title, JS regexes; all given ones must match. |
| `steamFrame.uiPatches.patches.*.patch` | path | required | JS evaluated (awaited) in every matching page. |
| `steamFrame.uiPatches.patches.*.unpatch` | null or path | `null` | JS evaluated when the service stops. |
| `steamFrame.uiPatches.patches.*.state` | bool | `false` | One [persistent JSON value](docs/ui-patches.md#persistent-state) for the patch. |
| `steamFrame.uiPatches.lib` | attrs, read-only | | Patch helpers (`mkPatch`), see [mkPatch](docs/ui-patches.md#mkpatch). |
| `steamFrame.launcherMenu.sort` | bool | `false` | Sort the "+" menu alphabetically. |
| `steamFrame.launcherMenu.pinDesktop` | null or `"top"` / `"bottom"` | `null` | Pin "Desktop" above/below the "+" menu's list; `null`: normal entry. |
| `steamFrame.launcherMenu.closeOnLaunch` | bool | `false` | Close the "+" menu when a program is clicked. |
| `steamFrame.launcherMenu.launchDebounceSeconds` | unsigned int (s) | `0` | Ignore repeat launches of a program within this time; `0`: off. |
| `steamFrame.launcherMenu.grid.enable` | bool | `false` | Show the "+" menu's programs as a grid of tiles. |
| `steamFrame.launcherMenu.grid.columns` | int, 1-8 | `4` | Tiles per row (3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px). |
| `steamFrame.launcherMenu.grid.maxRows` | null or positive int | `null` | Visible rows, the rest scrolls; `null`: up to 600 px. |
| `steamFrame.launcherMenu.showAllApps` | bool | `false` | List all programs without Developer Mode, see [Launcher menu](docs/launcher-menu.md#all-programs-and-developer-mode). |
| `steamFrame.launcherMenu.iconFallbacks.enable` | bool | `true` | Breeze icons of Konsole and KDE System Settings in hicolor, so the "+" menu shows them, see [Icon fallbacks](docs/launcher-menu.md#icon-fallbacks). |
| `steamFrame.launcherMenu.iconFallbacks.extra` | list of str | `[ ]` | Further Breeze app icon names to provide (a name Breeze lacks fails the build). |
| `steamFrame.launcherMenu.hiddenApps` | list of str | `[ ]` | Desktop entry ids (no `.desktop`) hidden from the "+" and KDE menus. |
| `steamFrame.dashboard.windows.maxScale` | null or positive number | `null` | Max resize scale of dashboard windows; `null`: stock (2), see [Dashboard windows](docs/dashboard-windows.md). |
| `steamFrame.dashboard.windows.distance.{world,theater,dashboard}.{min,max}` | null or positive number (m) | `null` | Pull-in / push-back limits of grabbed windows; `null`: stock (world 0.25-5, theater 1-6, dashboard 0.3-4 m). |
| `steamFrame.dashboard.steamCloseButton.enable` | bool | `false` | X button on the dashboard's Steam window, see [Steam close button](docs/steam-close-button.md). |
| `steamFrame.dashboard.windowCurvature.enable` | bool | `false` | Adjustable curvature per window, see [Window curvature](docs/window-curvature.md). |
| `steamFrame.dashboard.windowCurvature.initial` | non-negative number | `1.0` | Curvature of curved world/hand windows without own value (1 = stock, 0 = flat). |
| `steamFrame.dashboard.windowCurvature.max` | positive number | `3.0` | Largest curvature. |
| `steamFrame.dashboard.windowCurvature.step` | positive number | `0.05` | Rounding step while dragging (at most `max`). |
| `steamFrame.dashboard.windowCurvature.detentPixels` | unsigned int (px) | `24` | Detent at each detent point in drag pixels: the value holds there, then continues (nothing skipped); `0`: none. |
| `steamFrame.dashboard.windowCurvature.detentPoints` | list of non-negative numbers | `[ 0 1.0 ]` | Detent points (flat, stock), at most `max`. |
| `steamFrame.dashboard.windowCurvature.dragThresholdPixels` | unsigned int (px) | `8` | Vertical travel before a press becomes a drag. |
| `steamFrame.dashboard.windowCurvature.dragPixelsPerUnit` | positive number (px) | `120` | Drag distance per 1.0 in the menu (6 px per 0.05 step). |
| `steamFrame.dashboard.windowCurvature.barDragPixelsPerUnit` | positive number (px) | `60` | Drag distance per 1.0 on the bar button. |
| `steamFrame.dashboard.windowCurvature.haptics` | bool | `true` | Controller haptics while dragging (steps, detents, edges); the dashboard's hover clicks are muted during a drag. |
| `steamFrame.dashboard.frameControls.enable` | bool | `false` | Move window controls between bar and three-dot menu, see [Window control bar](docs/window-control-bar.md). |
| `steamFrame.dashboard.frameControls.longPressMs` | int, 300-10000 (ms) | `1500` | Long-press duration. |
| `steamFrame.dashboard.frameControls.inBar` | list of control names | `[ ]` | Controls that start in the bar: `keyboard`, `float`, `dashboard`, `theater`, `dockLeft`, `dockRight`, `close`, `curvature`, `"icon:<n>"`. |
| `steamFrame.dashboard.frameControls.inMenu` | list of control names | `[ ]` | Controls that start in the three-dot menu. |
| `steamFrame.dashboard.frameControls.floatInTheater` | bool | `false` | "Float" control on theater windows. |
| `steamFrame.pet.enable` | bool | `false` | A 3D pet in SteamVR's scene, the `vr-pet` command and "Pet" in the "+" menu, see [VR pet](docs/pet.md); the first switch bakes its models (~0.5 GB in the store). |
| `steamFrame.pet.defaultModel` | null or str | `null` | Model id shown until another is picked; `null`: the spec's `"default": true` (the Ginger cat). |
| `steamFrame.pet.extraModels` | attrs of path or attrs | `{ }` | Your own models by id: a folder with a `model.json`, or the spec as an attrset (files as paths), see [VR pet models](docs/pet-models.md). |
| `steamFrame.pet.options` | attrs | `{ }` | Behaviour options of `modules/pet/core.js` (`DEFAULTS` there), e.g. `{ walkSpeed = 0.3; follow = 3; }`. |
| `steamFrame.pet.fps` | int, 4-60 | `24` | Animation frames per second (baked frames and scene graph updates): smoother, but more frames loaded in vrcompositor. |
| `steamFrame.pet.mount` | `"dynamic"`, `"all"` | `"dynamic"` | Baked frames kept mounted in the scene graph: the clips needed now or next, or all of them. |
| `steamFrame.pet.debug.demo` | bool | `false` | Demo tour: cycles through all poses and activities. |
| `steamFrame.steamvrDebugger.enable` | bool | automatic | SteamVR dashboard DevTools on `127.0.0.1:8087` (set only while SteamVR runs); on when a dashboard patch is, see [SteamVR debugger](docs/steamvr-debugger.md). |
| `steamFrame.clipboardSync.enable` | bool | `true` | Clipboard bridge between the Steam session and the nested desktop. |
| `steamFrame.clipboardSync.package` | package | built from `dnut/clipboard-sync` | The clipboard-sync package. |
| `steamFrame.firefox.enable` | bool | `false` | Launcher for the Flathub Firefox Flatpak with the fixes below. |
| `steamFrame.firefox.vrFullscreenFix` | bool | `true` | Default `full-screen-api.ignore-widgets` to `true` (not in the desktop profile). |
| `steamFrame.firefox.disableAv1` | bool | `false` | Default `media.av1.enabled` to `false`: the Frame's decoder driver has no AV1, so sites send VP9/H.264, decoded in hardware. |
| `steamFrame.firefox.prefs` | attrs of bool, int or str | `{ }` | Further `about:config` default values for every profile (override the fixes too). |
| `steamFrame.firefox.desktopProfile` | null or str | `"desktop"` | Separate profile (directory name) for the nested desktop; `null`: the default profile in both sessions. |
| `steamFrame.firefox.defaultBrowser` | bool | `false` | Default for `http`, `https`, `text/html` (`xdg.mimeApps`). |
| `steamFrame.jellyfin.hardwareDecoding.enable` | bool | `false` | Hardware video decoding in the Jellyfin Desktop Flatpak, see [Jellyfin](docs/jellyfin.md). |
| `steamFrame.jellyfin.hardwareDecoding.hwdec` | str | `"v4l2m2m-copy,auto-copy"` | mpv `hwdec` used instead of Jellyfin's automatic one. |
| `steamFrame.jellyfin.hardwareDecoding.command` | str, read-only | | The `flatpak run …` command line of the desktop entry, for a terminal. |
| `steamFrame.launchers` | attrs of submodules | `{ }` | Launchers by desktop ID (without `.desktop`): the app's own entry, rewritten, see [Launchers](docs/launchers.md). Fields below. |
| `steamFrame.launchers.<id>.source.flatpak` | null or str | the desktop ID, if no other source | Flatpak app ID whose exported entry is rewritten (at runtime). |
| `steamFrame.launchers.<id>.source.package` | null or package | `null` | Package whose `share/applications/<id>.desktop` is rewritten (at build time; the build fails without it). |
| `steamFrame.launchers.<id>.source.file` | null or str | `null` | Desktop entry on the host, rewritten at runtime. |
| `steamFrame.launchers.<id>.keyring.enable` | bool | `false` | KDE wallet shared by both sessions: outer bus; Flatpaks may talk to `org.kde.kwalletd6`, `org.freedesktop.secrets`. |
| `steamFrame.launchers.<id>.keyring.electron` | bool | `false` | Pass `--password-store=kwallet6` (Electron apps; needs `keyring.enable`). |
| `steamFrame.launchers.<id>.defaultFor` | list of str | `[ ]` | MIME types / `x-scheme-handler/<scheme>` the app becomes the default and a recommended handler for (also in `MimeType=`); a type claimed twice fails. |
| `steamFrame.launchers.<id>.mimeTypes` | list of str | `[ ]` | Added to `MimeType=`, not made default. |
| `steamFrame.launchers.<id>.flatpakArgs` | list of str | `[ ]` | `flatpak run` options before the app ID (Flatpaks only). |
| `steamFrame.launchers.<id>.env` | attrs of str | `{ }` | App environment: `--env=K=V` for Flatpaks, like `hostEnv` otherwise. |
| `steamFrame.launchers.<id>.hostEnv` | attrs of str | `{ }` | Environment of the started process (`env K=V`; for Flatpaks the `flatpak` client). |
| `steamFrame.launchers.<id>.args` | list of str | `[ ]` | Arguments right after the app ID / program. |
| `steamFrame.launchers.<id>.wrappers` | list of str | `[ ]` | Commands the command line is passed to, outermost first. |
| `steamFrame.launchers.<id>.settings` | attrs of null or str | `{ }` | `[Desktop Entry]` keys to set (key-file syntax) or remove (`null`); drops their localized variants. |
| `steamFrame.launchers.<id>.command` | str, read-only | | About the command the entry runs, for a terminal. |
| `steamFrame.docker.enable` | bool | `false` | Rootless Docker as a user service, CLI for both sessions, see [Docker](docs/docker.md). |
| `steamFrame.docker.package` | package | `pkgs.docker` | Docker package (daemon and CLI). |
| `steamFrame.docker.host` | str, read-only | `"unix://${runtimeDir}/docker.sock"` | The daemon's `DOCKER_HOST` (the CLI's default). |
| `steamFrame.screenshots.enable` | bool | `false` | Link `~/Pictures/<name>` to the SteamVR screenshots, see [SteamVR screenshots](docs/screenshots.md). |
| `steamFrame.screenshots.name` | str | `"SteamVR Screenshots"` | Name of the link in `~/Pictures`. |
| `steamFrame.screenshots.steamUserId` | null or str (digits) | `null` | Steam account ID (folder in `~/.local/share/Steam/userdata`); `null`: the account last logged in, found at runtime. |
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

Removed options fail with the new form:

| Old | New |
|---|---|
| `keyring.flatpaks.<id>`, `keyring.programs.<id>` | `launchers.<id>.keyring` (fields: [Launchers](docs/launchers.md#configuration)) |

## Changes outside Nix (exceptions)

Everything not listed here is a Home Manager link into the Nix store or
lives in memory (the UI patches). These are written at runtime:

| Path | Feature | Lifetime | Removed by |
|---|---|---|---|
| `VRWebHelper.DebuggerEnabled` in `~/.config/openvr/config/steamvr.vrsettings` | [SteamVR debugger](docs/steamvr-debugger.md) | only while SteamVR runs | SteamVR stopping (runtime drop-in below); `steam-frame-nix-cleanup` while SteamVR is stopped |
| `~/.local/state/steam-frame-nix/steamvr-debugger.armed` | SteamVR debugger: the key's previous value | while SteamVR runs; after a power loss until the next SteamVR start or cleanup | SteamVR stopping; `steam-frame-nix-cleanup` |
| `/run/user/1000/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf`, `/run/user/1000/steam-frame-nix/steamvr-debugger-restore` | SteamVR debugger: puts the key back when SteamVR stops, without Nix | until reboot (tmpfs) | reboot; `steam-frame-nix-cleanup` while SteamVR is stopped and the debugger is off |
| `~/.local/state/steam-frame-nix/ui-patches/<name>.json` | Saved choices of dashboard patches ([persistent state](docs/ui-patches.md#persistent-state)): window control bar placements (`frame-controls`), "Steam hidden" (`steam-close-button`), the VR pet's spot, pose, model and whether it is hidden (`vr-pet`). SteamOS's `steamvr.service` deletes `~/.cache/SteamVR` (the dashboard's own browser storage) on every SteamVR start. | until removed: kept when a patch is disabled (the choices come back when you enable it again) | `steam-frame-nix-cleanup --all`, `install.sh uninstall` |
| `/run/user/1000/steam-frame-nix/applications/<id>.desktop` (with `.<id>.desktop.sum`, `.lock`) | [Launchers](docs/launchers.md) of Flatpaks and host files; `~/.local/share/applications/<id>.desktop` is a Home Manager link to it | until reboot (tmpfs), written again at login | reboot; the next switch or rewrite when the launcher or its app is gone; `steam-frame-nix-cleanup --all` |
| `/run/user/1000/steam-frame-nix/screenshots` | [SteamVR screenshots](docs/screenshots.md#how-it-works) without `steamUserId`: link to the current account's folder; `~/Pictures/<name>` is a Home Manager link to it | until reboot (tmpfs), written again at login | reboot; `steam-frame-nix-cleanup` once unused |
| `/run/user/1000/steam-frame-nix/vr-pet/icon.png` (with `.lock`) | [VR pet](docs/pet.md#how-it-works): link to the current model's "+" menu icon; `~/.local/share/icons/hicolor/256x256/apps/vr-pet.png` is a Home Manager link to it | until reboot (tmpfs), written again at login | reboot; `steam-frame-nix-cleanup` once unused |
| mtime of `~/.local/share/applications` | [Launchers](docs/launchers.md#how-it-works): a running Steam rescans the "+" menu | only the directory's timestamp | nothing to remove |
| mtime of `~/.local/share/icons/hicolor` | [icon fallbacks](docs/launcher-menu.md#icon-fallbacks), [VR pet](docs/pet.md#how-it-works) icon: a running Steam rescans icons | only the directory's timestamp | nothing to remove |

**`steam-frame-nix-cleanup`** (`install.sh cleanup`,
`steamFrame.cleanup.package`) knows everything any version of
steam-frame-nix wrote outside the store, removes only what is provably its
own (everything else is reported as "left alone") and can be run again
safely; `--dry-run` shows what it would do. How it decides and what older
versions left: [docs/cleanup.md](docs/cleanup.md).

- On every switch, `cleanup --orphans` removes what the configuration no
  longer uses (never the saved patch state).
- `steam-frame-nix-cleanup --all` removes everything, also the saved patch
  state. SteamVR's key can't be changed while SteamVR runs: it is then left
  to the runtime drop-in (restored when SteamVR stops).
- Without Nix or after a rollback it runs from the script:
  `curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all`.

### Only while running

- The UI patches (Steam, SteamVR dashboard, VR keyboard) live in the pages'
  memory; stopping `steam-ui-patches` / `steam-keyboard-patch` reverts them.
  The VR keyboard's relays (`vr-keyboard-relay`,
  `vr-keyboard-controllers-relay`) only pass messages and keep nothing.
- clipboard-sync runs from KDE autostart (a Home Manager link).
- Firefox: the desktop profile's `user.js` link exists only while its
  Firefox runs (see [Firefox](docs/firefox.md#how-it-works)).
- Launchers (Jellyfin, wallet access): the permissions are `flatpak run`
  options of the desktop entries, not Flatpak overrides.
- Docker: the daemon's socket in `/run/user/1000` (tmpfs) exists while
  `docker.service` runs.

### Set up by install.sh

`install.sh install` (the bootstrap, not the modules) also changes these, and
`install.sh uninstall` undoes it:

- Nix via [nix-installer](https://github.com/NixOS/nix-installer)
  (`steam-deck` planner, flakes on): `/nix` (bind mount of `/home/nix`,
  survives SteamOS updates), files in `/etc` (systemd units, profile scripts,
  `nix.conf`), its receipt `/nix/receipt.json`; the read-only root is
  unlocked only while it installs or uninstalls;
- `experimental-features = nix-command flakes` in `~/.config/nix/nix.conf`
  if Nix was already there without flakes;
- `~/nix-config` (your configuration, a git repository, from the template
  with your user name filled into `flake.nix`) and the link
  `~/.config/home-manager` to it, unless that exists or `--flake` is given;
  uninstall removes the link, never the configuration;
- dotfiles in Home Manager's way, renamed to `*.hm-backup-<time>` (kept);
- `~/.local/state/home-manager`, `~/.local/state/nix` (profiles,
  generations), `~/.nix-profile`, `~/.nix-defexpr`, `~/.nix-channels`,
  `~/.cache/nix`.

### App data you create

Not steam-frame-nix's to remove: the Firefox desktop profile
(`~/.var/app/org.mozilla.firefox/config/mozilla/firefox/desktop`, browser
data), secrets apps stored in the KDE wallet, and whatever apps keep in
`~/.var/app/*`, Flatpak apps and their runtimes.

Docker's images, containers and volumes (`~/.local/share/docker`) are partly
owned by the subordinate UIDs of your containers, so a plain `rm` fails.
With the daemon running, then stopped:

```sh
docker system prune -a --volumes
systemctl --user stop docker
nix shell nixpkgs#rootlesskit -c rootlesskit rm -rf ~/.local/share/docker
```

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

## Credits

The [VR pet](docs/pet.md)'s models are not in this repository: Nix fetches
them at build time from the URLs pinned (with their hashes) in
`modules/pet/package.nix` and `modules/pet/models/<id>/model.json`, and
bakes them into the store.

- **Toon Cat FREE** by [Omabuarts Studio](https://sketchfab.com/omabuarts)
  ([model](https://sketchfab.com/3d-models/toon-cat-free-b2bd1ee7858444bda366110a2d960386)),
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/): the cat (mesh,
  texture, rig, walk) and its coats. Modified: recoloured coats (Tuxedo,
  Blue, Cream, Snow), retargeted and hand-keyed animations, baked to one OBJ
  per frame. Fetched from a third-party GitHub mirror
  ([DevTakao/threejs-cat](https://github.com/DevTakao/threejs-cat), pinned
  commit and hash).
- **Tuxedo Cat Animated 2.0** by [DreamNoms](https://sketchfab.com/DreamNoms)
  ([model](https://sketchfab.com/3d-models/tuxedo-cat-animated-20-783fcb78b55b4394a212c2b6392e1113)),
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/): only its
  SitDown, IdleSit and StandUp clips, retargeted onto the Toon Cat and
  baked. Fetched from a third-party GitHub mirror
  ([xialin-he/xialin-he.github.io](https://github.com/xialin-he/xialin-he.github.io),
  pinned commit and hash).
- **Shiba Inu** and **Fox** from the
  [Ultimate Animated Animal Pack](https://quaternius.com/packs/ultimateanimatedanimals.html)
  by [Quaternius](https://quaternius.com),
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (credited
  anyway). Modified: clips sampled per frame, sit, lie, sleep and the
  held-by-the-scruff pose hand-keyed, a wagging tail and breathing added,
  material colours turned into a texture. Fetched from the Poly Pizza
  mirror ([Shiba Inu](https://poly.pizza/m/y4wdQpg767),
  [Fox](https://poly.pizza/m/Bc97C66HKi), pinned hashes).
- **Dachshund:** the Quaternius Shiba Inu (CC0 1.0), reshaped (longer back
  and ears, shorter legs) and recoloured black and tan.
- **three.js** (desktop preview only), [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE),
  fetched from npm.

The baked cat's store output carries a short `CREDITS.md` pointing here.

## License

[Apache License 2.0](LICENSE).
