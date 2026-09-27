# steam-frame-nix

[Home Manager](https://github.com/nix-community/home-manager) modules for the
Valve Steam Frame: SteamOS on `aarch64-linux`, standalone home-manager on a
non-NixOS system. They work around quirks of the Frame's two graphical
sessions (portal config, keyboard layout, VR keyboard, "+" menu, VR
dashboard windows, a close button for Steam's VR window, clipboard, Firefox)
declaratively, so every change can be reverted by activating an older
home-manager generation.

All options live under `steamFrame.*`. The portal fix and clipboard sync are
on by default; everything else is opt-in.

## Install

On the Frame (or a Steam Deck), open a terminal (Konsole in the desktop
mode / nested desktop) and run:

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
```

`https://steam-frame-nix.lhns.de` redirects to
[`install.sh`](https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh)
on the `main` branch; use that URL directly if the short link is unreachable.

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
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- status

# uninstall Home Manager and Nix (--keep-nix keeps Nix)
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall
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
    launcherMenu = {
      sort = true;
      pinDesktop = "bottom";
      closeOnLaunch = true;
      launchDebounce = 10;
      grid = { enable = true; columns = 4; maxRows = 4; };
      showAllApps = true;
    };
    dashboard = {
      windowMaxScale = 4.0;
      windowDistance.world.max = 10.0;
      steamCloseButton.enable = true;
      windowCurvature.enable = true;
      frameControls.enable = true;
    };
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
`homeManagerModules.{session,portal,keyboard-layout,steam-keyboard-patch,hidden-apps,steam-ui-patches,launcher-menu,steamvr-debugger,dashboard-windows,steam-close-button,window-curvature,frame-controls,clipboard-sync,firefox}`;
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
| `steamFrame.uiPatches.patches` | list of submodules | `[ ]` | Runtime patches of Steam's web UIs over their local DevTools ports, see [UI patches](#ui-patches-uipatchespatches). |
| `steamFrame.uiPatches.lib` | attrs, read-only | | Helpers for patches: `mkPatch` (wraps a patch with the finder library and its signatures), see [Finders and signatures](#finders-and-signatures). |
| `steamFrame.launcherMenu.sort` | bool | `false` | Sort the VR "+" menu alphabetically. |
| `steamFrame.launcherMenu.pinDesktop` | null or `"top"` / `"bottom"` | `null` | Pin "Desktop" above or below the "+" menu's scrolling list (always visible). `null`: a normal list entry. |
| `steamFrame.launcherMenu.closeOnLaunch` | bool | `false` | Close the "+" menu as soon as a program in it is clicked. |
| `steamFrame.launcherMenu.launchDebounce` | unsigned int (seconds) | `0` | Ignore repeated launches of the same program from the "+" menu within this time. `0`: off. |
| `steamFrame.launcherMenu.grid.enable` | bool | `false` | Show the "+" menu's programs as a grid of tiles (large icon, name below) instead of a list. |
| `steamFrame.launcherMenu.grid.columns` | int, 1-8 | `4` | Tiles per row (popup is 300 px wide: 3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px tiles). |
| `steamFrame.launcherMenu.grid.maxRows` | null or positive int | `null` | Rows visible at once, the rest scrolls. `null`: fill up to the menu's max height (600 px). |
| `steamFrame.launcherMenu.showAllApps` | bool | `false` | List all programs in the "+" menu without Steam's Developer Mode (Konsole, KDE System Settings, Dolphin, Discover, VLC, ... are hidden otherwise). See [Launcher menu](#launcher-menu-launchermenu). |
| `steamFrame.launcherMenu.iconFallbacks.enable` | bool | `true` | On every switch, link hicolor fallbacks (Breeze app icons) for desktop entries whose icon Steam can't find, so the "+" menu shows them (SteamOS: Konsole, KDE System Settings). `false` removes the links. See [Icon fallbacks](#icon-fallbacks-launchermenuiconfallbacks). |
| `steamFrame.launcherMenu.iconFallbacks.extra` | list of str | `[ ]` | Further icon names to provide even if no desktop entry the scan sees uses them. |
| `steamFrame.dashboard.windowMaxScale` | null or number | `null` | Largest resize-handle scale of SteamVR dashboard windows, relative to their default size. `null`: stock (2). See [Dashboard windows](#dashboard-windows-dashboard). |
| `steamFrame.dashboard.windowDistance.{world,theater,dashboard}.{min,max}` | null or number (m) | `null` | How close / far grabbed windows can be pulled in / pushed back. `null`: stock (world 0.25-5, theater 1-6, dashboard 0.3-4 m). |
| `steamFrame.dashboard.steamCloseButton.enable` | bool | `false` | Close (X) button on the dashboard's Steam window: switches to the previous window, or leaves just the dashboard bar. See [Steam close button](#steam-close-button-dashboardsteamclosebuttonenable). |
| `steamFrame.dashboard.windowCurvature.enable` | bool | `false` | Adjustable curvature per dashboard window: the "Toggle Curvature" row of a window's More Options menu (and its bottom-bar button, when it sits there) becomes a control (click: toggle, drag up/down: curvature). See [Window curvature](#window-curvature-dashboardwindowcurvature). |
| `steamFrame.dashboard.windowCurvature.default` | number | `1.0` | Curvature of world/hand windows without a value of their own, once curved (relative to SteamVR's stock curve: 1 = stock, 2 = twice as curved, 0 = flat). Dashboard/theater windows start at 1. |
| `steamFrame.dashboard.windowCurvature.max` | number | `3.0` | Largest curvature the control goes to. |
| `steamFrame.dashboard.windowCurvature.step` | number | `0.05` | Step the value is rounded to while dragging. |
| `steamFrame.dashboard.windowCurvature.snap` | number | `0.15` | While dragging, values within ± this of a snap point snap to it. `0`: no snapping. |
| `steamFrame.dashboard.windowCurvature.snapPoints` | list of numbers | `[ 0 1.0 ]` | Snap points (flat, stock). |
| `steamFrame.dashboard.windowCurvature.dragThreshold` | unsigned int (px) | `8` | Vertical laser travel before a press becomes a drag instead of a click. |
| `steamFrame.dashboard.windowCurvature.dragPixelsPerUnit` | number (px) | `60` | Drag distance per 1.0 of curvature (the laser stops at the menu's edge, ~190 px above the row). |
| `steamFrame.dashboard.windowCurvature.barDragPixelsPerUnit` | number (px) | `30` | Drag distance per 1.0 of curvature on the bottom-bar button. |
| `steamFrame.dashboard.windowCurvature.barDragRoom` | unsigned int (px) | `160` | Transparent room added above and below a window's bottom bar while its curvature button is dragged, so the laser stays on the bar. `0`: none. |
| `steamFrame.dashboard.windowCurvature.haptics` | bool | `true` | Controller haptics while dragging: snap at snap points, edge at 0 and `max`, a tick per other step. |
| `steamFrame.dashboard.frameControls.enable` | bool | `false` | Move the control icons under dashboard windows between the bottom bar and the More Options (three-dot) menu: long press an icon or menu row, then "Show in bar". Per control type, for all windows, kept across SteamVR restarts. See [Window control bar](#window-control-bar-dashboardframecontrols). |
| `steamFrame.dashboard.frameControls.longPressMs` | int, 300-10000 (ms) | `1500` | Hold time of the long press. A ring shows the progress from half of it (at most after 1 s). |
| `steamFrame.dashboard.frameControls.inBar` | list of control names | `[ ]` | Controls that start in the bar: `keyboard`, `float`, `dashboard`, `theater`, `dockLeft`, `dockRight`, `close`, `curvature`, or `"icon:<n>"`. A popup choice wins until the entry changes. |
| `steamFrame.dashboard.frameControls.inMenu` | list of control names | `[ ]` | Controls that start in the three-dot menu (same names). |
| `steamFrame.dashboard.frameControls.floatInTheater` | bool | `false` | Give theater windows the "Float" control (stock only shows it for dashboard-docked windows). |
| `steamFrame.steamvrDebugger.enable` | bool | `true` if a UI patch uses port 8087, else `false` | SteamVR dashboard DevTools on `127.0.0.1:8087` (`VRWebHelper/DebuggerEnabled`), needed by dashboard patches. See [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable). |
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

**Caveat:** the patch depends on Steam UI internals: the keyboard layouts
module, the VR keyboard status and the keyboard manager. They are found by
signature (content and shape, see [Finders and signatures](#finders-and-signatures)),
not by webpack module id or minified export name, so ordinary Steam updates
don't break it. If a signature stops matching, the patch leaves Steam
untouched (stock keyboard) and logs which one
(`journalctl --user -u steam-keyboard-patch`); see
[After a Steam update](#after-a-steam-update). Tested with Steam client
1790377368 (UI build 11041156).

**Remove when** Steam's VR keyboard gets these keys itself.

### UI patches (`uiPatches.patches`)

Steam's client UI (and SteamVR's dashboard, `vrwebhelper`) are web pages in
CEF with a local DevTools port: `127.0.0.1:8080` for Steam (SteamOS starts
it with `-cef-enable-debugging`), `127.0.0.1:8087` for SteamVR when its
debugger is enabled (`VRWebHelper/DebuggerEnabled` in
`steamvr.vrsettings`, see [SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)). The `steam-ui-patches` user service (`injector.mjs`,
Node) uses them to patch the running UI; Steam's files are never modified.

Each entry of `steamFrame.uiPatches.patches`:

| Attribute | Default | Description |
|---|---|---|
| `name` | | Unique name (log). |
| `endpoint` | `"http://127.0.0.1:8080"` | DevTools base URL; its `/json/list` is polled every 5 s. |
| `target.title` / `target.titleRegex` / `target.urlRegex` | `null` | Pages to patch: all given criteria must match (regexes are JavaScript). |
| `patch` | | JS file evaluated in every matching page (awaited). |
| `unpatch` | `null` | JS file evaluated when the service stops, reverting the patch. |

The injector keeps one DevTools session per matching page and evaluates its
patches right away, after the page creates new JS contexts (reloads,
debounced) and every 15 s, so patches must be idempotent: return e.g.
`"patched"` once and `"unchanged"` (not logged) afterwards; other results
are logged when they change (`journalctl --user -u steam-ui-patches`). On
stop it evaluates the `unpatch` files, so the UI is stock again without a
Steam restart. The service only exists while the list is non-empty; it is
restarted on every switch (changed patches re-injected, removed ones
reverted) and stopped once the list is empty.

```nix
steamFrame.uiPatches.patches = [ {
  name = "my-patch";
  target.title = "SharedJSContext";   # Steam's main JS context
  patch = ./my-patch/patch.js;
  unpatch = ./my-patch/unpatch.js;
} ];
```

**DevTools on the LAN:** SteamOS images also forward these ports to all
interfaces: `steam-web-debug-portforward.service` (`0.0.0.0:8081` →
`8080`) and `steamvr-web-debug-portforward.service` (`0.0.0.0:8088` →
`8087`), and firewalld's `public` zone allows ports 1024-65535. Anyone on
the same network can then run code in Steam's UI. Masking both units is
recommended; it is a system-level change, outside Home Manager (e.g. with
[system-manager](https://github.com/numtide/system-manager): links
`/etc/systemd/system/<unit>` → `/dev/null`). The injector itself only uses
`127.0.0.1`.

**Caveat:** patches depend on Steam UI internals and can break with a Steam
update. Find modules by signature rather than by id (below).

### Finders and signatures

Steam's UI is a webpack bundle: module ids (`40222`) and export names (`G$`,
`r_`) are generated anew by every Steam UI build. The patches therefore
never use them. `modules/lib/finders.js` (in the spirit of Decky Loader's
`findModule`/`findModuleChild`/`findInReactTree` and Vencord's `find`)
locates what they need by *signature*:

- a **module** by strings (or regexes) in its factory's source, e.g. the
  keyboard layouts module contains `name:"qwerty"`, `rgLayout:` and
  `GetKeyboardLayoutSettings`;
- an **export** of that module by its shape: type, source of a function
  (`GetKeyboardLayoutSettings` + `currentLayout`, without `selectedLayouts`),
  arity, data properties (`{ key: "ArrowLeft" }`), prototype methods
  (`HandleVirtualKeyDown`, `SendClientPasteCommand`) or getters
  (`VRKeyboardStatus`);
- **React** fibers by props (`findFiberUp`, `findFiberDown`,
  `findInReactTree`).

Every signature must match exactly once, otherwise the patch changes nothing
and reports the failing signature (e.g. `signature not found, Steam left
unpatched: layouts.currentLayout (module 40222): ambiguous export, candidates
r_, xy`). Results are cached per page, so re-injection every 15 s is cheap.

The signatures are data, in `modules/lib/signatures.json`, shared by the
patches and the offline checker. Besides `module`/`exports`, an entry can
list `expects` (strings the patch relies on, e.g. internal property names,
only checked offline) or be `checkOnly` (anchors a patch uses without the
finder, e.g. the React prop names of the "+" menu, checked offline only). A
`checkOnly` entry with `stylesheet` instead of `module` is matched against
the bundle's CSS files (`styles` directory of the bundle), e.g. the scroll
fade's gradient the grid relies on.

For your own patches, `steamFrame.uiPatches.lib.mkPatch` wraps a patch
written as a function expression with the library, its signatures, options
and the shared method hooks (below):

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

**Shared method hooks** (`modules/lib/hooks.js`, 4th argument `hooks`,
also `window.__sfuiHooks`): patches that intercept the same method, e.g.
the SteamVR dashboard mailbox's `SendMessage` ([Dashboard
windows](#dashboard-windows-dashboard) and [Window
curvature](#window-curvature-dashboardwindowcurvature) both rewrite outgoing
scene graphs), register a named hook instead of each wrapping the method:
one wrapper per method runs all hooks (in registration order), so patches
can be injected, upgraded and reverted in any order without piling up
wrappers or running one twice.

```js
hooks.before(Mailbox.prototype, 'SendMessage', 'my-patch', (args) => {
  if (args[1]?.type === 'update_scene_graph') rewrite(args[1].scene_graph);
});
hooks.remove(Mailbox.prototype, 'SendMessage', 'my-patch');   // in unpatch
```

### After a Steam update

The patches keep working as long as their signatures match. To check
without touching the running UI (no browser, Steam need not run), run the
offline checker from a checkout of this repository:

```sh
nix shell nixpkgs#nodejs -c node scripts/check-signatures.mjs
```

It reads the bundles Steam's UI page loads (`~/.local/share/Steam/steamui`:
the scripts of `index.html` and every chunk its webpack runtime can load; for
[Dashboard windows](#dashboard-windows-dashboard) and the other dashboard
patches also SteamVR's dashboard,
`/opt/steamvr/resources/webinterface/dashboard/systemui.html`),
extracts all webpack module factories and evaluates every signature of
`modules/lib/signatures.json` against them with the same finder code the
patches use (exports are checked by running the matched module in an inert
sandbox). Per patch it prints `found` (with the current module id and export
name), `ambiguous` (all candidates) or `missing`, and warnings for missing
`expects`; exit status 1 if anything is missing or ambiguous:

```
bundle steamui: 2827 modules in /home/deck/.local/share/Steam/steamui (build 11041156)

steam-keyboard-patch (steamui)
  layouts                found      module 40222 (chunk~2dcc5aaf7.js)
    .currentLayout        found      export r_
    …
OK: all signatures match exactly once
```

If something is missing, look at the module that used to match (the new
bundle's module sources: `scripts/webpack-modules.mjs`) and adjust the
signature in `signatures.json` (bump the patch's `VERSION` if its code
changes). Options: `--signatures FILE` adds your own signatures (same
format; bundles `steamui` and `vrwebui-systemui`, SteamVR's dashboard),
`--dir steamui=DIR` checks another copy, `--patch NAME`, `--strict` (fail on
warnings), `--json`. Live, `journalctl --user -u steam-keyboard-patch -u
steam-ui-patches` shows what each patch reported.

### Launcher menu (`launcherMenu.*`)

**Problem:** the VR dashboard's "+" menu (non-Steam programs) lists programs
in the order `SteamClient.Apps.ScanForInstalledNonSteamApps()` returns them:
GLib hash-table order, effectively random and changing with installed apps,
with "Desktop" (the nested Plasma session) somewhere in the middle of a
scrolling list.

Also, clicking a program only calls `SteamClient.Apps.LaunchNonSteamApp()`:
the menu stays open until the program's window appears, which can take a
while, so it looks as if the click did nothing, and a second click starts
the program twice.

**Fix:** UI patches (see above) in Steam's `SharedJSContext`:

- `sort = true`: a wrapper around `ScanForInstalledNonSteamApps` sorts the
  programs by name (case-insensitive), Desktop included.
- `pinDesktop = "top"` / `"bottom"`: Desktop is hidden in the scrolling list
  and pinned above it (right below the menu heading) or below it, separated
  by a thin line, so it is always visible without scrolling. The menu keeps
  its size (the scrolling list gets shorter). Clicking the pinned copy clicks
  the hidden original, so Steam's own launch handler runs. `null` (default)
  leaves Desktop a normal list entry.

  **Limitation:** the pinned copy is a plain DOM element, not part of Steam's
  controller navigation: it works with the laser pointer, but thumbstick /
  D-pad focus can't reach it.
- `closeOnLaunch = true` / `launchDebounce = <seconds>`: a wrapper around
  `LaunchNonSteamApp` (called only by this menu, for list entries and the
  pinned Desktop alike). With `closeOnLaunch`, it closes the menu right after
  the launch through the "+" button's own popup handle (as Steam does after
  adding a desktop window). With `launchDebounce`, another launch of the same
  command line within that many seconds of the last one that went through is
  ignored and logged (`journalctl --user -u steam-ui-patches`, on the next
  re-injection, i.e. within 15 s). Consequence: a program that exits right
  away can only be started again once the time is up.
- `grid.enable = true`: the programs section ("Launch Program") becomes a
  grid of tiles: large icon, name centred below (up to two lines). The
  "Add desktop window" section stays a list. This only restyles Steam's own
  items (found through React: the section keyed `programs`), so launching,
  sounds and the other options above work unchanged; Desktop is a normal
  tile, or with `pinDesktop` a slim, centred full-width row.

  The popup window is a fixed 300 px wide, so `columns` sets the tile size:

  | `columns` | tile width |
  |---|---|
  | 3 | ≈ 92 px |
  | 4 (default) | ≈ 68 px |
  | 5 | ≈ 53 px |

  Icons scale with the tile (up to 64 px). `maxRows = n` limits the menu to
  n rows of tiles (measured, since names take one or two lines); the rest
  scrolls inside the menu. `null` (default) lets the grid grow up to the
  menu's stock maximum height (600 px). Steam's scroll fade (the gradient at
  the top/bottom edge) is shown only where there is more to scroll: Steam
  computes it only when React re-renders or the list scrolls, so the patch
  recomputes it after the grid changes the layout.

  Controller navigation keeps working: Steam derives thumbstick / D-pad
  directions from the panel's CSS grid, so up/down/left/right move between
  tiles.

- `showAllApps = true`: without Steam's Developer Mode, the menu hides a
  fixed list of programs by executable name (`konsole`, `systemsettings`,
  `dolphin`, `plasma-discover`, `vlc`, `firewall-config`, `cmake-gui`,
  `qrenderdoc`, `lxterminal`, `sh`); Steam's scan still finds them. The
  menu's filter adds that list to its block list only when Developer Mode
  is off (`bDevMode || block.push(...list)`), and nothing else uses the list,
  so the patch gives that one array an empty iterator: nothing is added,
  the setting itself (used by other settings pages) is untouched. So
  Developer Mode can stay off: it also turns on sshd, xrdp, the devkit
  service and SteamOS's LAN forwards of the DevTools ports (0.0.0.0:8081 and
  8088), none of which the patches need. Hide single programs with
  `steamFrame.hiddenApps`. Found by signature (webpack module with the
  `developer_mode_enabled` accessor and the list); the offline checker also
  verifies the filter still spreads the list.

All are reverted when the options are turned off (next switch). These
patches use Steam APIs (`SteamClient.Apps`), React props and CSS rather
than webpack modules; the offline checker verifies those anchors too
(including the scroll fade's class names and stylesheet, checked as a
`stylesheet` signature against Steam's CSS files).
Tested with Steam client 1790377368.

#### Icon fallbacks (`launcherMenu.iconFallbacks`)

**Problem:** Steam's scan of host programs resolves a desktop entry's
`Icon=` name only in the hicolor icon theme (and `pixmaps`), not in the
desktop's icon theme. Konsole (`Icon=utilities-terminal`) and KDE System
Settings (`Icon=preferences-system`), which SteamOS ships, have their icons
only in Breeze, so they show up without an icon in the "+" menu.

**Fix:** on every `home-manager switch`, a small activation script looks
through the desktop entries Steam sees (`applications/` in
`~/.local/share` and Steam's `XDG_DATA_DIRS`; an entry shadowed by one with
the same desktop-file ID, and `Hidden`/`NoDisplay` entries, are skipped).
For each `Icon=` name that no hicolor theme dir (or `pixmaps`) has but
nixpkgs' `kdePackages.breeze-icons` app icons do, it links the largest
Breeze SVG as `~/.local/share/icons/hicolor/scalable/apps/<name>.svg`.
Desktop entries are left alone. `iconFallbacks.extra` adds names to
provide even if no scanned entry uses them (a name Breeze lacks is
reported and skipped). The links made are listed in
`~/.local/state/steam-frame-nix/icon-fallbacks`; links no longer needed are
removed, and `iconFallbacks.enable = false` removes them all. Only those
links (still pointing into a breeze-icons store path) are ever removed;
other files in the icon dir are never touched. Programs installed later get
their fallback on the next switch.

`iconFallbacks` used to be a list of icon names; setting a list now fails
evaluation with a message: use `iconFallbacks.extra` for additional names,
`iconFallbacks.enable = false` for what `[ ]` meant.

A running Steam picks up the change without a restart: it caches the icon
theme (GTK) and rescans it only when a theme directory's mtime changes, so
the script bumps the mtime of `~/.local/share/icons/hicolor` whenever it
adds or removes links.

### Dashboard windows (`dashboard.*`)

**Problem:** SteamVR dashboard windows (Steam, app windows, overlays, the
theater screen) can only be enlarged to twice their default size, and
grabbed windows can only be pushed back to 5 m (6 m in theater mode), too
close for a big virtual screen.

**Fix:** a UI patch (see above) of SteamVR's dashboard page (`vrwebhelper`,
`127.0.0.1:8087`, title `systemui`); it turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable). The dashboard
describes its windows to `vrcompositor` as a scene graph
(`update_scene_graph` messages over its mailbox WebSocket), and the
compositor enforces the limits it finds there. They are constants in the
dashboard's JS, so the patch hooks the mailbox's `SendMessage` (through the
[shared method hooks](#finders-and-signatures)) and rewrites them in every
outgoing scene graph:

| Option | Scene-graph property | Stock |
|---|---|---|
| `windowMaxScale` | `frame-resize-scale-max` of every window frame | 2 (range 0.25-2, relative to the window's default size; the theater screen's default is 2.8x larger) |
| `windowDistance.world.{min,max}` | `min-distance` / `max-distance` of `grab-scale` nodes: windows placed in the world | 0.25-5 m |
| `windowDistance.theater.{min,max}` | same, `grab-transform` of the theater screen | 1-6 m |
| `windowDistance.dashboard.{min,max}` | same, `grab-transform` of the dashboard itself | 0.3-4 m |
| (not patched) | `grab-transform` of the keyboard | 0.2-1 m |

Distances are how close / far a grabbed window can be pulled in / pushed
back (thumbstick or scroll while dragging). `null` (default) keeps the stock
value; unset `min`/`max` of a set range stay stock. The patch is only
registered when at least one option is set.

After patching, the dashboard is asked to send its (unchanged) scene graph
once more, so changes take effect immediately, without touching any window;
turning the options off reverts to stock the same way (next switch).

```nix
steamFrame.dashboard = {
  windowMaxScale = 4.0;              # resize up to 4x (theater: 11.2x)
  windowDistance.world.max = 10.0;   # push windows back up to 10 m
  windowDistance.theater.max = 12.0;
};
```

**Caveats:** depends on SteamVR UI internals: the mailbox class and the
scene-graph scheduler are found by signature (`dashboard-windows` in
`modules/lib/signatures.json`, checked offline by
`scripts/check-signatures.mjs` after a SteamVR update); if one doesn't match,
the patch reports it and leaves the dashboard stock. Grab nodes are recognized by their type *and* their
exact stock values, so if a SteamVR update changes those, the distance
options silently do nothing (the scale option still applies). The patch's
state, including counters of rewritten nodes per kind, is
`window.__sfuiDashboardWindows` in the `systemui` page (DevTools).

### Steam close button (`dashboard.steamCloseButton.enable`)

**Problem:** every SteamVR dashboard window has a close (X) button except
Steam's own (the library, overlay `valve.steam.gamepadui.main`): it can't be
put away, and with no other window open the dashboard always shows it.

**Fix:** a UI patch (see above) of SteamVR's dashboard page (`vrwebhelper`,
`127.0.0.1:8087`, title `systemui`; it turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)) gives the Steam
window an X. The window can't really be closed, so clicking it:

- docks the window back into the dashboard if it was placed in the world
  (or theater / hand);
- if it was the dashboard's active window, switches to the most recently
  active other window that is still open, in the dashboard and has a tab in
  the dashboard bar (like a tab click);
- with none left, leaves the dashboard open with **just its bar** ("bar
  only"), no window shown.

Bar-only is kept when the dashboard is closed and reopened (SteamVR would
otherwise pick Steam again) and across restarts of the patch service
(`home-manager switch`, re-injection); it ends as soon as any window becomes
active: the Steam tab or another tab, a Steam menu pick, a launched app or a
new window. It does not survive a SteamVR restart (or a reload of the
dashboard page): the dashboard then starts with Steam as usual.

```nix
steamFrame.dashboard.steamCloseButton.enable = true;
```

How: the X of a dashboard window is its `closing` component, shown when a
close method is possible; the patch adds an `onCloseRequested` to the Steam
window's default component props. For bar-only it clears the active frame
and overrides two methods of the dashboard instance while bar-only is on:
`autoSwitchOverlayIfNeeded` (stock: no active frame → show Steam) does
nothing, and `onShowOverlayRequestFromSteam` drops the first
`ShowOverlay("valve.steam.gamepadui.main")` Steam sends by itself after each
dashboard open (within 10 s). The patch's state (bar-only, recent windows,
ignored requests) is `window.__sfuiSteamCloseState` in the `systemui` page;
`window.__sfuiSteamClose.plan()` tells what a click would do right now,
without doing it. The journal (`journalctl --user -u steam-ui-patches`)
shows `bar-only` and the number of ignored Steam requests.

**Limitations:**

- If Steam ever doesn't send that automatic request after an open, the
  first Steam menu pick (e.g. Library) in bar-only is swallowed once; a
  second one works.
- Showing Steam through SteamVR's own `CVRSteamPrivate::SwitchToDashboardOverlay`
  path (not through the dashboard page) isn't filtered and ends bar-only.
- With a VRLink remote dashboard, SteamVR ignores the local active-frame
  change, so bar-only has no effect there.
- Turning the option off (next switch) removes the button but leaves a
  dashboard that is bar-only at that moment without an active window until
  the next tab click or dashboard open.

**Caveats:** depends on SteamVR UI internals: MobX, the dock-location enum
and the `closing` component class are found by signature, and the names the
patch relies on (`DashboardStore._setActiveFrame`, `mainSteamFrame`,
`Dashboard.autoSwitchOverlayIfNeeded`, …) are checked offline
(`steam-close-button` in `modules/lib/signatures.json`,
`scripts/check-signatures.mjs`); if a lookup fails, the patch reports it and
leaves the dashboard stock. Tested with SteamVR build 11008059.

### Window curvature (`dashboard.windowCurvature.*`)

**Problem:** SteamVR's dashboard windows are either curved (fixed radius) or
flat: the "Toggle Curvature" entry of a window's More Options (three-dot)
menu only switches between the two, and windows placed in the world start
flat.

**Fix:** a UI patch (see above) of SteamVR's dashboard page (`vrwebhelper`,
`127.0.0.1:8087`, title `systemui`; it turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)) makes the whole
"Toggle Curvature" row a control, with the window's value on its right and
small arrows above/below it. When the control sits in the window's bottom
bar instead (e.g. moved there by a patch of your own), that button works
the same way, without the value: the steps are felt as haptics.

- **click**: curved → flat, flat → stock curve (1);
- **press and drag up/down** with the laser (after `dragThreshold` px): the
  curvature follows live, `dragPixelsPerUnit` px per 1.0, rounded to `step`,
  from 0 (flat) to `max`. Near a snap point (`snapPoints`, by default 0 and
  1, within ± `snap`) it snaps to it exactly; dragging on moves past.
  With `haptics`, the controller gives a snap at a snap point, an edge
  bump at 0 and `max` and a light tick for other steps (SteamVR's own
  overlay haptic effects).
- on the **bar button**, `barDragPixelsPerUnit` px per 1.0; the bar panel is
  only one button high and the laser's position stops at the edge of the
  pressed panel, so while dragging the panel gets `barDragRoom` px of
  transparent room above and below (its origin is shifted in the scene
  graph by the same amount, so the bar stays in place).

```nix
steamFrame.dashboard.windowCurvature = {
  enable = true;
  # default = 1.0;  max = 3.0;  step = 0.05;
  # snap = 0.15;  snapPoints = [ 0 1.0 ];
  # dragThreshold = 8;  dragPixelsPerUnit = 60;
  # barDragPixelsPerUnit = 30;  barDragRoom = 160;  haptics = true;
};
```

How curvature works in SteamVR: each window frame has a *curvature origin*,
a scene-graph transform node (`frame:<id>:curvature-origin`) at a distance
in front of it, which all of the window's panels reference
(`curvature-origin-id`); `vrcompositor` bends the panels onto a cylinder
around that point. The stock distance is the dashboard's curvature distance
(`DashboardStore.curvatureDistance`: dashboard distance + 1.8, e.g. 2.95, in
the dashboard's scaled units; a radius of roughly 1.1 m, the same for all
docked windows, so they are concentric with the dashboard bar), and "flat"
is just an origin 1000 units away. The curvature is 1 / radius,
so the value here is the curvature relative to stock: the patch hooks the
mailbox's `SendMessage` (like [Dashboard windows](#dashboard-windows-dashboard),
through the [shared method hooks](#finders-and-signatures)) and puts the
origin at *stock distance / value* in outgoing scene graphs (2 = half the
radius). On/off stays SteamVR's own toggle (`ToggleCurvature`), so the value
0 and the stock state always agree; SteamVR resets that toggle when a window
is docked somewhere else.

A window without a value of its own is shown at `default` once curved in the
world or on a hand, at 1 (stock) in the dashboard or theater. Values are
kept per window (its overlay key) in the `systemui` page
(`window.__sfuiWindowCurvatureState`): across restarts of the patch service
(`home-manager switch`), but not across a SteamVR restart (or a reload of the
dashboard page). `window.__sfuiWindowCurvature.dump()` lists every window's
state, `.log` recent events.

**Other patches** that handle presses on the same controls (e.g. a long
press on frame controls) coordinate through a small contract instead of
guessing each other's timing: every element the patch drives has the class
`sfui-curv-ctl`; when a press on one becomes a drag, a bubbling
`CustomEvent` `sfui-curv-dragstart` (detail `{ frameID, where: 'menu' | 'bar' }`)
is dispatched on it, and `sfui-curv-dragend` when the drag ends;
`window.__sfuiWindowCurvature.cancelPress()` ends a press without its
click. A patch with its own gesture there lets `mousemove` through while
that gesture is undecided, drops it on `sfui-curv-dragstart`, and calls
`cancelPress()` when it takes the press over.

**Limitations:**

- Only the laser adjusts the value: with controller (gamepad) navigation of
  the menu, the row is the stock toggle.
- The thumbstick doesn't scroll there (SteamVR delivers no wheel events to
  the menu), so there are no steps by scrolling.
- The laser's position stops at the menu's edge: the whole range has to fit
  into the room above/below the row (`dragPixelsPerUnit` × `max` ≲ 190 px
  upwards), otherwise the top end can't be reached in one drag.

**Caveats:** depends on SteamVR UI internals: MobX, the dock-location enum,
the mailbox, the scene-graph scheduler, the `curvature` frame component,
the action store and the menu's CSS class names are found by signature, and
the names and strings the patch relies on (`curvature-origin`,
`curvature-origin-id`, `ToggleCurvature`, `m_bCurveOverride`, the
curvature action's icons, `isControlAdditionalOptionsOpen`, …) are checked
offline (`window-curvature` in `modules/lib/signatures.json`,
`scripts/check-signatures.mjs`); if a lookup fails, the patch reports it and
leaves the dashboard stock. Tested with SteamVR build 11008059.

### Window control bar (`dashboard.frameControls.*`)

**Problem:** the controls under a SteamVR dashboard window are fixed: some
sit in the window's bottom bar (keyboard, float or back to the dashboard,
theater, close), others only in its More Options (three-dot) menu
(curvature, dock to a controller), and in the theater the "Float" button is
gone.

**Fix:** a UI patch (see above) of SteamVR's dashboard page (`vrwebhelper`,
`127.0.0.1:8087`, title `systemui`; it turns on the
[SteamVR debugger](#steamvr-debugger-steamvrdebuggerenable)):

- **long press** (`longPressMs`) a bar icon or a three-dot menu row: after
  half the time (at most after 1 s) a ring around the icon shows the
  progress, so ordinary clicks show nothing; moving the laser or leaving
  the icon doesn't cancel it, releasing early does. Then a small popup
  opens above the icon (or above the menu) with **Show in bar**; toggling
  it moves that control between the bar and the menu, **for all windows**.
  The release after the long press doesn't trigger the control. The
  popup closes on a press elsewhere, Escape, 1 s after the laser left it,
  and after toggling.
- a control moved into the bar joins the group left of the three-dot
  button; the three-dot button itself can't be moved and, as in SteamVR,
  shows only while its menu has entries.
- `inBar` / `inMenu` set where controls start; a choice made in the popup
  wins until that control's entry changes. `floatInTheater` gives theater
  windows the "Float" button back (same call as the stock one: the window
  floats in the world).

```nix
steamFrame.dashboard.frameControls = {
  enable = true;
  # longPressMs = 1500;
  # inBar = [ "curvature" ];  inMenu = [ "theater" ];
  # floatInTheater = true;
};
```

How it works: each window hands its control lists to
`Frame.prototype.SetControlsItems(bottom, tabHover, additional)`; the patch
wraps it and stores a re-partitioned copy (stock order kept, gaps merged).
Controls are identified by their action icon (`icon:<n>`), the same in every
window and language. Placements are kept in the `systemui` page
(`window.__sfuiFrameControlsState`) and in its `localStorage`, so they
survive restarts of the patch service and of SteamVR. The popup is a
scene-graph panel of its own, attached to the pressed button's anchor like
SteamVR's tooltips and three-dot menu, so the bar and the menu don't change
size or move. SteamVR closes the three-dot menu as soon as the laser's focus
leaves the bar and the menu; while its popup is open that close is held
back and applied (unless the laser is on the bar or menu again) when the
popup closes. `window.__sfuiFrameControls.dump()` lists every window's
controls, `.placement()` the current choices, `.reset()` forgets them,
`.log` recent events.

With [Window curvature](#window-curvature-dashboardwindowcurvature), the
curvature control keeps its drag: a drag that starts before the ring shows
cancels the long press; once the ring shows, the long press takes the press
over (its `sfui-curv-*` contract), so a still hold on the curvature control
opens the popup.

**Limitations:**

- SteamVR delivers no right-click or thumbstick click to the dashboard, so
  there is no context menu on a secondary button.
- Only the laser: with controller (gamepad) navigation the controls are
  stock.
- Placements are per control type, not per window.

**Caveats:** depends on SteamVR UI internals: MobX, the `Frame` class, the
action store, the dock-location enum, the input-focus store and the
localization function are found by signature, and the rest (the control
list layout, the icon numbers, the frame-controls panel and anchor ids, the
scene-graph DOM walk and `SGApp`'s embedded-UV table, the menu's auto-close)
is checked offline (`frame-controls` in `modules/lib/signatures.json`,
`scripts/check-signatures.mjs`); if a lookup fails, the patch reports it and
leaves the dashboard stock. Tested with SteamVR build 11008059.

### SteamVR debugger (`steamvrDebugger.enable`)

Patches of the SteamVR dashboard need its DevTools port, which SteamVR only
opens with the setting `VRWebHelper/DebuggerEnabled` (port
`VRWebHelper/DebuggerPort`, default 8087). It is enabled automatically
(`mkDefault`) as soon as a patch in `steamFrame.uiPatches.patches` uses port
8087 (e.g. [Dashboard windows](#dashboard-windows-dashboard),
[Steam close button](#steam-close-button-dashboardsteamclosebuttonenable),
[Window curvature](#window-curvature-dashboardwindowcurvature),
[Window control bar](#window-control-bar-dashboardframecontrols)).

SteamVR rewrites `~/.config/openvr/config/steamvr.vrsettings` while it runs
and on exit, so the file can't be managed by Home Manager, and edits while it
runs are lost. Instead the `steamvr-webhelper-debugger` oneshot merges just
that key (with `jq`, other settings untouched) before every SteamVR start (a
drop-in on SteamOS's `steamvr.service` makes it Want/After the oneshot).
SteamVR reads the setting only at startup: **the first time, restart SteamVR
once** (e.g. reboot) before dashboard patches work; until then the
`steam-ui-patches` service keeps polling `127.0.0.1:8087`.

Turning it off sets the key back to `false` at the next SteamVR start, but
only if this module set it (marker in
`~/.local/state/steam-frame-nix/`); a setting you made yourself is left
alone.

**Security:** SteamOS's `steamvr-web-debug-portforward.service` forwards
`0.0.0.0:8088` to this port, so with the debugger on, anyone on the same
network could run code in the SteamVR dashboard. Masking it is recommended
(see "DevTools on the LAN" in [UI patches](#ui-patches-uipatchespatches));
the patches only use `127.0.0.1`.

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
