# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame (SteamOS, `aarch64-linux`, standalone home-manager). They
work around quirks of the Frame's two graphical sessions (portal, keyboard
layout, clipboard, Firefox) and extend Steam's and SteamVR's UIs at runtime
(VR keyboard, "+" menu, dashboard windows, Steam close button, window
curvature, window controls). Everything is declarative and reverts by
activating an older generation.

All options live under `steamFrame.*`. The portal fix and clipboard sync are
on by default; everything else is opt-in.

- [Install](#install) · [Two sessions](#two-sessions) · [Usage](#usage) ·
  [Options](#options)
- [UI patches](#ui-patches-uipatchespatches):
  [finders and signatures](#finders-and-signatures),
  [after a Steam update](#after-a-steam-update)
- [Fixes in detail](#fixes-in-detail):
  [session](#session-settings-and-background-services-sessionnix),
  [portal](#portal-sessionportalfix),
  [keyboard layout](#keyboard-layout-keyboardlayout-keyboardvariant),
  [Steam keyboard](#steam-keyboard-patch-keyboardvrextrakeysenable),
  [launcher menu](#launcher-menu-launchermenu),
  [dashboard windows](#dashboard-windows-dashboardwindows),
  [Steam close button](#steam-close-button-dashboardsteamclosebuttonenable),
  [window curvature](#window-curvature-dashboardwindowcurvature),
  [window control bar](#window-control-bar-dashboardframecontrols),
  [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable),
  [hidden apps](#hidden-apps-launchermenuhiddenapps),
  [clipboard sync](#clipboard-sync-clipboardsyncenable),
  [Firefox](#firefox-firefox)
- [Rollback](#rollback)

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
   `~/.config/home-manager`) from the template with your user name;
3. runs `home-manager switch`; conflicting dotfiles are renamed to
   `*.hm-backup-<time>`.

Re-running it just switches again. Afterwards edit `~/nix-config/home.nix`
and run `home-manager switch` from a terminal in the nested desktop.

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- status      # Nix, generation, services
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
```

Uninstall stops the Home Manager user services (reverting the Steam keyboard
patch), runs `home-manager uninstall`, then removes Nix and per-user Nix
state. Your configuration, `*.hm-backup-*` files, app data and Flatpaks stay.

Manual setup: `nix flake init -t github:lhns/steam-frame-nix`.

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

- **Wallet:** there should be one `kwalletd6`, on the outer bus; apps started
  from the desktop would otherwise start a second one whose secrets VR can't
  see. Prefix launchers' `Exec=` with `steamFrame.session.busEnv`.
- **User services:** home-manager skips `reloadSystemd` when switching from
  the desktop terminal, so `steamFrame.session.services` talks to the outer
  user manager directly.
- **Launchers:** the "+" menu only sees `~/.local/share/applications` (not
  `~/.nix-profile/share`), so entries are written there, shadowing
  Flatpak/package entries with the same ID.

## Usage

Requirements: Nix with flakes and standalone home-manager (see
[Install](#install)). `nix flake init -t github:lhns/steam-frame-nix` creates
a commented version of these two files ([`template/`](template)):

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
  home.stateVersion = "26.05";
  targets.genericLinux.enable = true;

  steamFrame = {
    keyboard.layout = "de";
    keyboard.vr.extraKeys.enable = true;
    launcherMenu = {
      sort = true;
      pinDesktop = "bottom";
      closeOnLaunch = true;
      launchDebounceSeconds = 10;
      grid = { enable = true; columns = 4; maxRows = 4; };
      showAllApps = true;
      # Listed in the "+" menu only with showAllApps or Steam Developer Mode.
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
home-manager switch --flake .#steamos
```

Individual modules:
`homeManagerModules.{session,portal,keyboard-layout,steam-keyboard-patch,hidden-apps,steam-ui-patches,launcher-menu,steamvr-debugger,dashboard-windows,steam-close-button,window-curvature,frame-controls,clipboard-sync,firefox}`;
`default` imports all.

**Steam Developer Mode** (a Steam setting, not managed here) makes the "+"
menu list every desktop entry; `launcherMenu.showAllApps` does the same
without it.

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
| `steamFrame.uiPatches.patches` | list of submodules | `[ ]` | Runtime patches of Steam's web UIs, see [UI patches](#ui-patches-uipatchespatches). |
| `steamFrame.uiPatches.lib` | attrs, read-only | | Patch helpers (`mkPatch`), see [Finders and signatures](#finders-and-signatures). |
| `steamFrame.launcherMenu.sort` | bool | `false` | Sort the "+" menu alphabetically. |
| `steamFrame.launcherMenu.pinDesktop` | null or `"top"` / `"bottom"` | `null` | Pin "Desktop" above/below the "+" menu's list; `null`: normal entry. |
| `steamFrame.launcherMenu.closeOnLaunch` | bool | `false` | Close the "+" menu when a program is clicked. |
| `steamFrame.launcherMenu.launchDebounceSeconds` | unsigned int (s) | `0` | Ignore repeat launches of a program within this time; `0`: off. |
| `steamFrame.launcherMenu.grid.enable` | bool | `false` | Show the "+" menu's programs as a grid of tiles. |
| `steamFrame.launcherMenu.grid.columns` | int, 1-8 | `4` | Tiles per row (3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px). |
| `steamFrame.launcherMenu.grid.maxRows` | null or positive int | `null` | Visible rows, the rest scrolls; `null`: up to 600 px. |
| `steamFrame.launcherMenu.showAllApps` | bool | `false` | List all programs without Developer Mode, see [Launcher menu](#launcher-menu-launchermenu). |
| `steamFrame.launcherMenu.iconFallbacks.enable` | bool | `true` | Link Breeze icons into hicolor for entries Steam shows without icon, see [Icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks). |
| `steamFrame.launcherMenu.iconFallbacks.extra` | list of str | `[ ]` | Extra icon names to provide. |
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
| `steamFrame.steamvrDebugger.enable` | bool | automatic | SteamVR dashboard DevTools on `127.0.0.1:8087`; on when a dashboard patch is, see [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable). |
| `steamFrame.clipboardSync.enable` | bool | `true` | Clipboard bridge between the Steam session and the nested desktop. |
| `steamFrame.clipboardSync.package` | package | built from `dnut/clipboard-sync` | The clipboard-sync package. |
| `steamFrame.firefox.enable` | bool | `false` | Launcher for the Flathub Firefox Flatpak with the fixes below. |
| `steamFrame.firefox.vrFullscreenFix` | bool | `true` | Link a `user.js` with `full-screen-api.ignore-widgets` into profiles. |
| `steamFrame.firefox.desktopProfile` | null or str | `"desktop"` | Separate profile for the nested desktop; `null`: none. |

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

## UI patches (`uiPatches.patches`)

Steam's UI and SteamVR's dashboard (`vrwebhelper`) are CEF web pages with a
local DevTools port: `127.0.0.1:8080` for Steam (SteamOS passes
`-cef-enable-debugging`), `127.0.0.1:8087` for SteamVR once
[its debugger](#steamvr-debugger-steamvrdebuggerenable) is on. The
`steam-ui-patches` user service (`injector.mjs`) patches the running pages
through them; Steam's files are never modified. The launcher menu and
dashboard features are such patches, and you can add your own:

| Attribute | Default | Description |
|---|---|---|
| `name` | | Unique name (log). |
| `endpoint` | `"http://127.0.0.1:8080"` | DevTools base URL; `/json/list` is polled every 5 s. |
| `target.title` / `target.titleRegex` / `target.urlRegex` | `null` | Pages to patch; all given criteria must match (JS regexes). |
| `patch` | | JS file evaluated in every matching page (awaited). |
| `unpatch` | `null` | JS file evaluated when the service stops. |

```nix
steamFrame.uiPatches.patches = [ {
  name = "my-patch";
  target.title = "SharedJSContext";   # Steam's main JS context
  patch = ./my-patch/patch.js;
  unpatch = ./my-patch/unpatch.js;
} ];
```

Patches are evaluated on attach, after new JS contexts (reloads) and every
15 s, so they must be idempotent: return e.g. `"patched"` once, then
`"unchanged"` (not logged); other results are logged when they change
(`journalctl --user -u steam-ui-patches`). On stop, `unpatch` restores the
stock UI without a Steam restart. The service exists only while the list is
non-empty and is restarted on every switch.

**DevTools on the LAN:** Steam's Developer Mode enables
`steam-web-debug-portforward` (`0.0.0.0:8081` → `8080`) and
`steamvr-web-debug-portforward` (`0.0.0.0:8088` → `8087`), and firewalld
allows ports 1024-65535, so anyone on the network could run code in Steam's
UI. No patch needs Developer Mode, so keep it off. If it was on while those
units were masked, they may stay enabled: check with
`systemctl is-enabled steam-web-debug-portforward steamvr-web-debug-portforward`
and `sudo systemctl disable` them.

**Caveat:** patches depend on Steam UI internals and can break with an
update; find modules by signature, not id (below).

### Finders and signatures

Webpack module ids and export names change with every Steam UI build, so
patches never use them. `modules/lib/finders.js` (like Decky Loader's
`findModule`/`findInReactTree` or Vencord's `find`) locates by *signature*:

- a **module** by strings/regexes in its factory source;
- an **export** by shape: type, function source, arity, data properties,
  prototype methods or getters;
- **React** fibers by props (`findFiberUp`, `findFiberDown`,
  `findInReactTree`).

Every signature must match exactly once, otherwise the patch changes nothing
and reports it (e.g. `signature not found, Steam left unpatched:
layouts.currentLayout (module 40222): ambiguous export, candidates r_, xy`).
Results are cached per page.

Signatures live in `modules/lib/signatures.json`, shared by patches and the
offline checker. An entry can also list `expects` (strings the patch relies
on, checked offline only) or be `checkOnly` (anchors not used through the
finder, checked offline only; with `stylesheet` instead of `module` it is
matched against the bundle's CSS).

`steamFrame.uiPatches.lib.mkPatch` wraps a patch file — a function expression
`(find, sigs, opts, hooks) => …` returning a status string — with the finder
library, its signatures, options and the shared hooks (details in
`modules/lib/default.nix`):

```nix
steamFrame.uiPatches.patches = [ {
  name = "my-patch";
  target.title = "SharedJSContext";
  patch = config.steamFrame.uiPatches.lib.mkPatch {
    name = "my-patch";
    src = ./my-patch/patch.js;          # ((find, sigs, opts, hooks) => { … })
    signatures.thing = {
      module.includes = [ "SomeUniqueString" ];
      exports.Thing = { type = "class"; protoMethods = [ "DoIt" ]; };
    };
    opts.factor = 2;
  };
  unpatch = ./my-patch/unpatch.js;
} ];
```

```js
((find, sigs, opts, hooks) => {
  let mods;
  try { mods = find.resolveAll(find.getWebpackRequire('webpackChunksteamui'), sigs); }
  catch (e) { return `not patched: ${e.message}`; }
  const Thing = mods.thing.exports.Thing;   // SteamVR dashboard: 'webpackChunkvrwebui'
  …
})
```

**Shared method hooks** (`modules/lib/hooks.js`, argument `hooks`, also
`window.__sfuiHooks`): patches intercepting the same method (e.g. the
dashboard mailbox's `SendMessage`, used by
[Dashboard windows](#dashboard-windows-dashboardwindows) and
[Window curvature](#window-curvature-dashboardwindowcurvature)) register
named hooks; one wrapper per method runs them in registration order, so
patches can be injected, upgraded and reverted in any order.

```js
hooks.before(Mailbox.prototype, 'SendMessage', 'my-patch', (args) => {
  if (args[1]?.type === 'update_scene_graph') rewrite(args[1].scene_graph);
});
hooks.remove(Mailbox.prototype, 'SendMessage', 'my-patch');   // in unpatch
```

### After a Steam update

Check the signatures offline (Steam need not run) from a checkout:

```sh
nix shell nixpkgs#nodejs -c node scripts/check-signatures.mjs
```

It loads Steam's UI bundle (`~/.local/share/Steam/steamui`) and SteamVR's
dashboard (`/opt/steamvr/resources/webinterface/dashboard/systemui.html`),
evaluates every signature with the patches' finder code (exports in an inert
sandbox) and prints per patch `found` (module id, export name), `ambiguous`
or `missing`, plus warnings for missing `expects`; exit status 1 if anything
is missing or ambiguous:

```
bundle steamui: 2827 modules in /home/deck/.local/share/Steam/steamui (build 11041156)

steam-keyboard-patch (steamui)
  layouts                found      module 40222 (chunk~2dcc5aaf7.js)
    .currentLayout        found      export r_
    …
OK: all signatures match exactly once
```

To fix a signature, inspect the new module sources
(`scripts/webpack-modules.mjs`), adjust `signatures.json` and bump the
patch's `VERSION` if its code changes. Flags: `--signatures FILE` (your own,
bundles `steamui` / `vrwebui-systemui`), `--dir steamui=DIR`,
`--patch NAME`, `--strict` (fail on warnings), `--json`. Live:
`journalctl --user -u steam-keyboard-patch -u steam-ui-patches`.

## Fixes in detail

### Session settings and background services (`session.nix`)

Used by the other modules; normally nothing to set.

- `session.runtimeDir` / `session.bus` point at the Steam session's runtime
  dir and bus (services, KDE wallet), which the nested desktop can't see;
  `session.busEnv` is a launcher prefix to reach them
  (`Exec=${config.steamFrame.session.busEnv} flatpak run …`).
- Switching from the nested desktop, Home Manager can't reach the service
  manager ("User systemd daemon not running"). So after every switch this
  module reloads the Steam session's user manager and applies
  `session.services.start` / `stop` / `restart`, which other modules fill.

### Portal (`session.portalFix`)

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

**Remove when** SteamOS applies a layout setting to gamescope.

### Steam keyboard patch (`keyboard.vr.extraKeys.enable`)

**Problem:** Steam's VR keyboard has no Ctrl, Alt or Esc, can't press real
keys, and its text emulation only maps plain ASCII: non-ASCII and
AltGr/dead-key characters on the German keymap (`| @ { [ ] } \ ~ ^`,
backtick, `ä ö ü €`) come out as `1`.

**Fix:** the `steam-keyboard-patch` user service (`helper.mjs`) injects a
patch over DevTools (`127.0.0.1:8080`) and re-injects it after Steam
restarts; stopping it (or disabling the option) reverts the patch. No
reboot or Steam restart needed.

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
- Ctrl/Alt chords and Esc are sent with `xdotool key` on `:0` (focus follows
  the VR-selected window); a toggled Ctrl/Alt is held down while the
  keyboard is open (e.g. Ctrl+scroll).
- Problem characters are typed with `xdotool type`; everything else goes
  through Steam.
- Enter always types Return (stock Steam may send it to a Steam search box).

**Layouts:** the character routing targets the German keymap; on others it
is harmless (those characters are typed by xdotool), and Esc/Ctrl/Alt/arrows
work regardless.

**Security:** the helper only accepts single-key Ctrl/Alt chords, the extra
keys, Ctrl/Alt hold/release and single non-ASCII/AltGr characters; it cannot
type ASCII text or press Enter.

**Caveat:** found by signature (see
[Finders and signatures](#finders-and-signatures)); if one stops matching,
the keyboard stays stock and the journal says why (see
[After a Steam update](#after-a-steam-update)). Tested with Steam client
1790377368 (UI build 11041156).

**Remove when** Steam's VR keyboard gets these keys.

### Launcher menu (`launcherMenu.*`)

**Problem:** the VR dashboard's "+" menu (non-Steam programs) is in random
order with "Desktop" somewhere in a scrolling list, and a click shows no
feedback until the window appears, so programs often get started twice.

**Fix:** UI patches in Steam's `SharedJSContext`:

- `sort`: programs sorted by name (case-insensitive), Desktop included.
- `pinDesktop = "top"` / `"bottom"`: Desktop pinned above/below the list,
  always visible. **Limitation:** the pinned copy works with the laser but
  not with thumbstick / D-pad navigation.
- `closeOnLaunch`: the menu closes on click.
- `launchDebounceSeconds = <seconds>`: a repeat launch of the same command within
  that time is ignored (and logged); a program that exits right away can
  only be restarted once the time is up.
- `grid.enable`: the programs section becomes a grid of tiles (icon, name
  below); "Add desktop window" stays a list. Only restyles Steam's items, so
  launching, sounds and controller navigation keep working. The popup is
  300 px wide, so `columns` sets the tile size (see [Options](#options));
  `maxRows` limits visible rows, the rest scrolls.
- `showAllApps`: without Developer Mode Steam hides `konsole`,
  `systemsettings`, `dolphin`, `plasma-discover`, `vlc`, `firewall-config`,
  `cmake-gui`, `qrenderdoc`, `lxterminal` and `sh`; this lifts that filter
  only, so Developer Mode (sshd, xrdp, LAN DevTools forwards) can stay off.
  Hide single programs with [`hiddenApps`](#hidden-apps-launchermenuhiddenapps).

All revert when turned off (next switch). The anchors (APIs, React props,
CSS) are verified by the offline checker. Tested with Steam client
1790377368.

#### Icon fallbacks (`launcherMenu.iconFallbacks`)

**Problem:** Steam resolves `Icon=` only in the hicolor theme (and
`pixmaps`), so Konsole and KDE System Settings, whose icons only Breeze has,
show without icon.

**Fix:** on every switch, a script scans the desktop entries Steam sees and,
for each icon name missing from hicolor but present in nixpkgs' Breeze app
icons, links the Breeze SVG into
`~/.local/share/icons/hicolor/scalable/apps/`. `extra` adds names regardless
of the scan. Links are tracked in
`~/.local/state/steam-frame-nix/icon-fallbacks`; stale ones are removed,
`enable = false` removes all, and no other file is touched. A running Steam
picks them up (the script bumps the icon dir's mtime). New programs get
their fallback on the next switch.

`iconFallbacks` used to be a list; a list now fails with a hint (use
`extra`, or `enable = false` for `[ ]`).

### Dashboard windows (`dashboard.windows.*`)

**Problem:** SteamVR dashboard windows can only be enlarged to 2x, and
grabbed windows pushed back only to 5 m (6 m in theater), too close for a big
screen.

**Fix:** a UI patch of SteamVR's dashboard (turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)) raises these
limits, which the dashboard sends to the compositor in its scene graph:

| Option | Stock |
|---|---|
| `maxScale` | 2 (relative to the window's default size; the theater screen's default is 2.8x larger) |
| `distance.world.{min,max}` | 0.25-5 m |
| `distance.theater.{min,max}` | 1-6 m |
| `distance.dashboard.{min,max}` | 0.3-4 m |

Distances limit pulling in / pushing back a grabbed window (thumbstick or
scroll while dragging); `null` keeps stock. Changes apply immediately, and
turning options off reverts on the next switch. The keyboard's range is not
patched.

```nix
steamFrame.dashboard.windows = {
  maxScale = 4.0;              # resize up to 4x (theater: 11.2x)
  distance.world.max = 10.0;   # push windows back up to 10 m
  distance.theater.max = 12.0;
};
```

**Caveats:** found by signature (`dashboard-windows` in `signatures.json`);
on mismatch the dashboard stays stock. Grab nodes are recognized by their
exact stock values, so if SteamVR changes them the distance options silently
do nothing. State: `window.__sfuiDashboardWindows` in the `systemui` page.

### Steam close button (`dashboard.steamCloseButton.enable`)

**Problem:** every dashboard window has a close (X) button except Steam's
own, and with no other window open the dashboard always shows it.

**Fix:** a UI patch of SteamVR's dashboard (turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)) gives the Steam
window an X that hides Steam: it docks the window back if it was in the
world, theater or on a hand, then shows the most recently active other
dashboard window, or **just the dashboard bar** if there is none.

Steam stays hidden until you bring it back (Steam tab, a Steam menu pick,
SteamVR asking for it): closing the active window, or a theater window,
then goes to the previous window or the bar instead of Steam. This
survives dashboard reopens and patch-service restarts; a SteamVR restart
starts with Steam. Debugging: `window.__sfuiSteamClose.plan()` /
`homePlan()` and `window.__sfuiSteamCloseState` in the `systemui` page.

**Limitations:** SteamVR's rarer "go home" paths (Now Playing after a game
quits, message overlays) still show Steam; no effect with a VRLink remote
dashboard; turning the option off while bar-only leaves no active window
until the next tab click or dashboard open.

**Caveats:** found by signature (`steam-close-button` in `signatures.json`);
on mismatch the dashboard stays stock. Tested with SteamVR build 11008059.

### Window curvature (`dashboard.windowCurvature.*`)

**Problem:** SteamVR dashboard windows are either curved (fixed radius) or
flat, and world windows start flat.

**Fix:** a UI patch of SteamVR's dashboard (turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)) turns the
"Toggle Curvature" row of a window's three-dot menu into a control showing
the window's value; the same control in the bottom bar (see
[window control bar](#window-control-bar-dashboardframecontrols)) works
without the value, with haptic steps.

- **click:** curved → flat, flat → stock (1);
- **drag up/down** with the laser: curvature from 0 (flat) to `max`,
  relative to stock (2 = half the radius), with a detent of `detentPixels`
  of drag at each of `detentPoints` (no values skipped), and haptics for
  detents, edges and steps.

A window without its own value is shown at `initial` once curved in the
world or on a hand, at 1 in the dashboard or theater. Values are kept per
window until SteamVR restarts. Debugging: `window.__sfuiWindowCurvature.dump()`
(`.log` recent events).

**Limitations:**

- Laser only; with gamepad navigation the row is the stock toggle.
- No thumbstick scrolling (SteamVR sends no wheel events to the menu).
- The laser stops at the menu's edge (~190 px above the row): with the
  default 120 px per 1.0, 0 → 1 fits into one drag, 0 → 3 takes two. Lower
  `dragPixelsPerUnit` (≤ 60) for the full range in one drag.

**For patch authors** (other patches handling presses on these controls):
every element the patch drives has class `sfui-curv-ctl`; when a press
becomes a drag, a bubbling `CustomEvent` `sfui-curv-dragstart` (detail
`{ frameID, where: 'menu' | 'bar' }`) is dispatched on it, and
`sfui-curv-dragend` when it ends; `window.__sfuiWindowCurvature.cancelPress()`
ends a press without its click. A patch with its own gesture lets
`mousemove` through while undecided, drops its gesture on
`sfui-curv-dragstart`, and calls `cancelPress()` when it takes the press
over.

**Caveats:** found by signature (`window-curvature` in `signatures.json`);
on mismatch the dashboard stays stock. Tested with SteamVR build 11008059.

### Window control bar (`dashboard.frameControls.*`)

**Problem:** the controls under a dashboard window are fixed: some in the
bottom bar, others only in the three-dot menu (curvature, dock to a
controller), and theater windows have no "Float".

**Fix:** a UI patch of SteamVR's dashboard (turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)):

- **long press** a bar icon or menu row (`longPressMs`; a progress ring
  shows from half the time, at most after 1 s), then **Show in bar** in the
  popup moves that control between bar and menu **for all windows**.
  Placements survive SteamVR restarts.
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
before the ring shows adjusts curvature; once the ring shows, the long press
wins. Debugging: `window.__sfuiFrameControls.dump()`, `.placement()`,
`.reset()` (forget choices), `.log`.

**Limitations:** laser only (no right-click or thumbstick click reaches the
dashboard; gamepad navigation sees stock controls); placements are per
control type, not per window.

**Caveats:** found by signature (`frame-controls` in `signatures.json`); on
mismatch the dashboard stays stock. Tested with SteamVR build 11008059.

### SteamVR debugger (`steamvrDebugger.enable`)

Dashboard patches need SteamVR's DevTools port, opened only with
`VRWebHelper/DebuggerEnabled` (port `VRWebHelper/DebuggerPort`, default
8087). It is enabled automatically when any patch in
`steamFrame.uiPatches.patches` uses port 8087.

SteamVR rewrites `~/.config/openvr/config/steamvr.vrsettings` itself, so a
oneshot merges just that key (with `jq`) before every SteamVR start.
**The first time, restart SteamVR once** (e.g. reboot); until then
`steam-ui-patches` keeps polling. Disabling resets the key at the next
SteamVR start, but only if this module set it.

**Security:** the port listens on `127.0.0.1` only; keep Developer Mode off
(see "DevTools on the LAN" in [UI patches](#ui-patches-uipatchespatches)).

### Hidden apps (`launcherMenu.hiddenApps`)

**Problem:** with Developer Mode or `launcherMenu.showAllApps`, the "+" menu
lists every desktop entry, including system tools.

**Fix:** a user entry with `Hidden=true` in `~/.local/share/applications`
masks the system one (also in the KDE menu). The "+" menu always hides
`steam` and `vrurlhandler`; for Konsole in VR use
[`launcherMenu.showAllApps`](#launcher-menu-launchermenu).

### Clipboard sync (`clipboardSync.enable`)

**Problem:** the Steam session's X displays and the nested desktop have
separate clipboards.

**Fix:** [clipboard-sync](https://github.com/dnut/clipboard-sync), built from
source (its flake is x86-only), started via KDE autostart (the desktop can't
reach the user manager, and `:2` must exist first). Each switch restarts it
if outdated, so switch from a desktop terminal.

### Firefox (`firefox.*`)

For the Flathub Firefox Flatpak (`org.mozilla.firefox`, stable). The
launcher shadows the Flatpak's own entry (same ID), so default-browser
associations keep working.

- **`vrFullscreenFix`:** gamescope never shows fullscreen windows, so
  Firefox looks frozen. A `user.js` with `full-screen-api.ignore-widgets`
  makes fullscreen fill just the window; it is linked into every profile
  (existing non-symlink `user.js` files are left alone). **Remove when**
  gamescope shows fullscreen X11 windows in VR.
- **`desktopProfile`:** the sessions can't see each other's Firefox, so a
  second instance stops at the locked profile; in the nested desktop the
  launcher uses this separate profile.

## Rollback

`home-manager generations` lists previous generations; run
`<store path>/activate` of the one you want.

## License

[Apache License 2.0](LICENSE).
