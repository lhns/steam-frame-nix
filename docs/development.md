# Development

Which file does what and where it runs, for working on steam-frame-nix
itself. Writing your own patches: [UI patches](ui-patches.md).

## Conventions

- `modules/<name>.nix` is `homeManagerModules.<name>`; files only it uses
  are in `modules/<name>/`.
- `patch.js` / `unpatch.js`: a runtime patch of a web page and the
  expression that reverts it. A module with several patches has one
  directory per patch (`launcher-menu/grid/`,
  `vr-keyboard/suggestions-panel/`).
- `*.js` in `modules/` is browser JavaScript evaluated in Steam's or
  SteamVR's pages (single expressions, no imports); `*.mjs` is a Node
  program (user service, test or script).
- `check.nix` is the module's flake check (`nix flake check`, attribute
  `checks.<system>.<name>`); `tests/*.test.mjs` are run by it.
- Runtime names (patch names, user services, state files) are listed
  [below](#runtime-names); they stay stable when files move.

Where things run:

| Tag | Where |
|---|---|
| **Steam** | Steam's UI, page `SharedJSContext`, DevTools `127.0.0.1:8080` |
| **SteamVR** | SteamVR's dashboard (`vrwebhelper`), page `systemui`, DevTools `127.0.0.1:8087` |
| **service** | systemd user service (outer Steam/VR session) |
| **switch** | Home Manager activation (`home-manager switch`) |
| **build** | Nix build time |
| **app** | started with an app (launcher, `LD_PRELOAD`, autostart) |
| **test** | `nix flake check` |
| **dev** | run by hand from a checkout |

## Repository layout

```text
flake.nix                      homeManagerModules, packages/apps (cleanup, pet-*), checks, template
install.sh                     install / uninstall / cleanup (curl | bash; also the
                               steam-frame-nix-cleanup package and the debugger arm step)
template/                      `nix flake init -t` / installer config: flake.nix, home.nix
docs/                          one page per feature; ui-patches.md for patch authors
scripts/
  check-signatures.mjs         dev: check signatures.json against the installed Steam
  webpack-modules.mjs          dev: webpack module extraction (used by check-signatures)
  vr-keyboard-replay.mjs       dev: replay recorded swipes through the swipe decoder
modules/
  session.nix                  switch: outer bus/runtime dir, user services on switch
  cleanup.nix                  switch: `cleanup --orphans`; steam-frame-nix-cleanup on PATH
  cleanup/package.nix          build: install.sh as a command (cleanup, steamvr-debugger-arm, restart-check)
  cleanup/check.nix            test: install.sh cleanup and restart-check on fake home/runtime dirs
  portal.nix                   Steam session portal config (session.portalFix)
  portal/check.nix             test: KDE FileChooser on by default, absent when disabled
  applications-menu.nix        applications.menu link for KDE apps (session.applicationsMenu)
  applications-menu/check.nix  test: the link on by default, absent when disabled
  keyboard-layout.nix          gamescope-session drop-in with XKB_DEFAULT_* (keyboard.layout)
  clipboard-sync.nix           app: KDE autostart of clipboard-sync (clipboardSync)
  hidden-apps.nix              Hidden=true desktop entries (launcherMenu.hiddenApps)
  launchers.nix                links, MIME defaults, units of the launchers (launchers.<id>)
  launchers/
    lib.nix                    the launcher option type, Exec quoting, package entries (build)
    rewrite.awk                build+service: rewrites a desktop entry's Exec lines and keys
    generate.sh                service steam-frame-nix-launchers (+ .path), switch: entries
                               of Flatpaks/host files in <runtimeDir>/steam-frame-nix/applications
    check.nix, fixtures/       test: real entries rewritten (fixtures/expected), generator runs
  docker.nix                   service: rootless dockerd (docker)
  screenshots.nix              ~/Pictures link to the SteamVR screenshots (screenshots)
  screenshots/
    link.sh, package.nix       service steam-frame-nix-screenshots (+ .path), switch:
                               <runtimeDir>/steam-frame-nix/screenshots -> account folder
    check.nix                  test: account detection on fake Steam dirs
  firefox.nix                  Flatpak prefs extension and launcher (firefox)
  firefox/wrapper.nix          app: launcher wrapper (desktop profile, fullscreen fix)
  firefox/check.nix            test: wrapper against a fake flatpak
  jellyfin.nix                 launcher with flatpak run options (jellyfin.hardwareDecoding)
  jellyfin/mpv-hwdec-shim.c    app: LD_PRELOAD shim, hwdec auto* -> v4l2m2m-copy
  jellyfin/shim.nix            build: the shim as lib/mpv-hwdec-shim.so
  jellyfin/check.nix           test: shim ELF and rewriting
  steam-ui-patches.nix         service steam-ui-patches: runs the injector (uiPatches.*)
  steam-ui-patches/
    injector.mjs               service: injects/re-injects/reverts patches over DevTools
    lib/default.nix            build: mkPatch (wraps a patch.js with the library)
    lib/finders.js             Steam+SteamVR: signature lookup of webpack modules/React fibers
    lib/hooks.js               Steam+SteamVR: shared method hooks (e.g. SendMessage)
    lib/signatures.json        build+dev: per-patch signatures (also check-signatures)
  steamvr-debugger.nix         service steamvr-webhelper-debugger: DevTools port 8087
  launcher-menu.nix            the VR "+" menu (launcherMenu.*), icon fallbacks
  launcher-menu/
    order/                     Steam: sort the list
    pinned-desktop/            Steam: pin Desktop above/below the list
    launch/                    Steam: close on launch, debounce
    grid/                      Steam: programs as a grid of tiles
    show-all/                  Steam: all programs without Developer Mode
    icon-fallbacks.sh          switch: hints for iconFallbacks (read-only)
  vr-keyboard-extra-keys.nix   Esc/Ctrl/Alt/arrows etc. (keyboard.vr.extraKeys)
  vr-keyboard-extra-keys/
    patch.js, unpatch.js       Steam: the extra bottom row and key routing
    xdotool-helper.mjs         service steam-keyboard-patch: own injector + xdotool keys
    allowlist.mjs              service: the keys the helper may send
    check.nix, tests/          test: the allowlist
  vr-keyboard.nix              swipe, suggestions, Backspace drag (keyboard.vr)
  vr-keyboard/
    patch.js, unpatch.js       Steam: gestures, text model, suggestion strip
    swipe-decoder.js           Steam (argument of patch.js): swipe path -> words
    textmodel.js               Steam (argument of patch.js): what the keyboard typed
    corrector.js               Steam (argument of patch.js): corrections, completions
    gesture-input.js           Steam (argument of patch.js): a gesture's own events, its hand's bridge path
    function-keys.js           Steam (argument of patch.js): F1-F12 in the strip while AltGr is active
    suggestions-panel/
      patch.js, unpatch.js     SteamVR: the strip as a panel above/below the keyboard
      relay.mjs                service vr-keyboard-relay: strip state Steam <-> SteamVR
    dictionary.nix, gen-dict.py  build: dictionary from wordfreq + Hunspell
    check.nix, tests/          test (also built before the patch): text model,
                               corrector, swipe-decoder accuracy, gesture input,
                               the F-key strip
  vr-keyboard-controllers.nix  controller bridge for keyboard features (internal option)
  vr-keyboard-controllers/
    bridge-patch.js, unpatch.js  SteamVR: keyboard pose, tips, laser hits, triggers
    geometry.js                SteamVR (argument of bridge-patch.js): tip/laser -> keyboard
    hub.js                     Steam (argument of consumer patches): __sfuiControllers
    relay.mjs                  service vr-keyboard-controllers-relay: frames SteamVR -> Steam, demand back
    check.nix, tests/          test: geometry, hub
  vr-keyboard-touch.nix        touch typing (keyboard.vr.touchTyping)
  vr-keyboard-touch/
    keyboard-patch.js, keyboard-unpatch.js  Steam: presses touched keys
    tracker.js                 Steam (argument of keyboard-patch.js): contact, hysteresis
    check.nix, tests/          test (also built before the patch): touch paths
  dashboard-windows.nix, dashboard-windows/     SteamVR: window scale/distance limits
  steam-close-button.nix, steam-close-button/   SteamVR: X on the Steam window
  window-curvature.nix, window-curvature/       SteamVR: curvature wheel
  frame-controls.nix, frame-controls/           SteamVR: window control bar
  pet.nix                      the VR pet (pet): patch, CLI, "+" menu entry, icon units
  pet/
    package.nix                build: bakes, catalog, patch, CLI, icons, preview, tests
    core.js                    SteamVR+preview+test (in the patch): behaviour, interaction
    systemui.js, unpatch.js    SteamVR: draws the pet in the scene graph, grip bar, menu
    cli.mjs                    app: `vr-pet` over DevTools (also the "+" menu entry)
    icon.sh                    service steam-frame-nix-pet-icon (+ .path), switch:
                               <runtimeDir>/steam-frame-nix/vr-pet/icon.png -> model icon
    bake.py, bake_gltf.py, rig.py  build: the cat's / a glTF animal's frames (OBJ per frame)
    index.py, skin.py, thumb.py    build: catalog (models.json), coats, thumbnails, icons
    models/<id>/model.json     build: the built-in models (spec: docs/pet-models.md)
    preview/                   dev: desktop preview (`nix run .#pet-preview`)
    check.nix, tests/          test: core, adapter, CLI, models, icons, private-model guard
```

## Runtime names

Patch names appear in the journal, key `signatures.json` and name the
state files (`~/.local/state/steam-frame-nix/ui-patches/<name>.json`), so
they are kept even where a file name says more:

| Module | Option | Patches (page) | User services |
|---|---|---|---|
| `launcher-menu` | `launcherMenu` | `launcher-menu-{order,pinned-desktop,launch,grid,show-all}` (Steam) | `steam-ui-patches` |
| `vr-keyboard` | `keyboard.vr` | `vr-keyboard` (Steam), `vr-keyboard-panel` = `suggestions-panel/` (SteamVR) | `steam-ui-patches`, `vr-keyboard-relay` |
| `vr-keyboard-extra-keys` | `keyboard.vr.extraKeys` | `steam-keyboard-patch` (Steam) | `steam-keyboard-patch` |
| `vr-keyboard-touch` | `keyboard.vr.touchTyping` | `vr-keyboard-touch` (Steam) | `steam-ui-patches` |
| `vr-keyboard-controllers` | (internal, `keyboard.vr.controllers`) | `vr-keyboard-controllers` (SteamVR) | `steam-ui-patches`, `vr-keyboard-controllers-relay` |
| `dashboard-windows` | `dashboard.windows` | `dashboard-windows` (SteamVR) | `steam-ui-patches` |
| `steam-close-button` | `dashboard.steamCloseButton` | `steam-close-button` (SteamVR, state) | `steam-ui-patches` |
| `window-curvature` | `dashboard.windowCurvature` | `window-curvature` (SteamVR) | `steam-ui-patches` |
| `frame-controls` | `dashboard.frameControls` | `frame-controls` (SteamVR, state) | `steam-ui-patches` |
| `steamvr-debugger` | `steamvrDebugger` | | `steamvr-webhelper-debugger` |
| `launchers` | `launchers` | | `steam-frame-nix-launchers` (`.service`, `.path`) |
| `screenshots` | `screenshots` | | `steam-frame-nix-screenshots` (`.service`, `.path`) |
| `pet` | `pet` | `vr-pet` (SteamVR, state) | `steam-ui-patches`, `steam-frame-nix-pet-icon` (`.service`, `.path`) |
| `docker` | `docker` | | `docker` |

Log of all patches:
`journalctl --user -u steam-ui-patches -u steam-keyboard-patch -u vr-keyboard-relay -u vr-keyboard-controllers-relay`.

## Checks

```sh
nix flake check                                            # all checks, on aarch64-linux
nix shell nixpkgs#nodejs -c node scripts/check-signatures.mjs --strict   # on the Frame
```
