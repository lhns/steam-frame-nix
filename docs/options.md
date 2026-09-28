# Options

All options live under `steamFrame.*`. The portal fix and clipboard sync
are on by default; everything else is opt-in.

## Session

Details: [desktop-integration.md](desktop-integration.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.session.runtimeDir` | str | `"/run/user/1000"` | `XDG_RUNTIME_DIR` of the outer (Steam/VR) session. |
| `steamFrame.session.bus` | str | `"unix:path=${runtimeDir}/bus"` | Outer session D-Bus (user manager, `kwalletd6`). |
| `steamFrame.session.busEnv` | str, read-only | `"env DBUS_SESSION_BUS_ADDRESS=${bus}"` | Prefix for launchers that must use the outer bus. |
| `steamFrame.session.services.start` | list of str | `[ ]` | User units started on switch if not running. |
| `steamFrame.session.services.restart` | list of str | `[ ]` | User units restarted on every switch. |
| `steamFrame.session.services.stop` | list of str | `[ ]` | User units stopped on switch if running (e.g. of a disabled feature). |
| `steamFrame.session.portalFix.enable` | bool | `true` | Working portal config (OpenURI) for the Steam session. |

## Keyboard

Details: [keyboard.md](keyboard.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.keyboard.layout` | null or str | `null` | XKB layout for the Steam session, e.g. `"de"`; `null`: US. |
| `steamFrame.keyboard.variant` | null or str | `null` | XKB variant for the Steam session, e.g. `"nodeadkeys"`; see [Keyboard layout](keyboard.md#layout). |
| `steamFrame.keyboard.vr.extraKeys.enable` | bool | `false` | VR keyboard with Esc/Ctrl/Alt, arrows, real chords, AltGr/non-ASCII. |
| `steamFrame.keyboard.vr.enable` | bool | `false` | Swipe typing, suggestions and Backspace drag on the VR keyboard; the sub-features below are on by default, see [VR keyboard](keyboard.md#swipe-and-suggestions). |
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

## UI patches

Details: [ui-patches.md](ui-patches.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.uiPatches.patches` | list of submodules | `[ ]` | Runtime patches of Steam's web UIs, see [UI patches](ui-patches.md). |
| `steamFrame.uiPatches.lib` | attrs, read-only | | Patch helpers (`mkPatch`), see [Finders and signatures](ui-patches.md#mkpatch). |

## Launcher menu

Details: [launcher-menu.md](launcher-menu.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.launcherMenu.sort` | bool | `false` | Sort the "+" menu alphabetically. |
| `steamFrame.launcherMenu.pinDesktop` | null or `"top"` / `"bottom"` | `null` | Pin "Desktop" above/below the "+" menu's list; `null`: normal entry. |
| `steamFrame.launcherMenu.closeOnLaunch` | bool | `false` | Close the "+" menu when a program is clicked. |
| `steamFrame.launcherMenu.launchDebounceSeconds` | unsigned int (s) | `0` | Ignore repeat launches of a program within this time; `0`: off. |
| `steamFrame.launcherMenu.grid.enable` | bool | `false` | Show the "+" menu's programs as a grid of tiles. |
| `steamFrame.launcherMenu.grid.columns` | int, 1-8 | `4` | Tiles per row (3 ≈ 92 px, 4 ≈ 68 px, 5 ≈ 53 px). |
| `steamFrame.launcherMenu.grid.maxRows` | null or positive int | `null` | Visible rows, the rest scrolls; `null`: up to 600 px. |
| `steamFrame.launcherMenu.showAllApps` | bool | `false` | List all programs without Developer Mode, see [Launcher menu](launcher-menu.md#menu-patches). |
| `steamFrame.launcherMenu.iconFallbacks.enable` | bool | `true` | Breeze icons of Konsole and KDE System Settings in hicolor, so the "+" menu shows them, see [Icon fallbacks](launcher-menu.md#icon-fallbacks). |
| `steamFrame.launcherMenu.iconFallbacks.extra` | list of str | `[ ]` | Further Breeze app icon names to provide (a name Breeze lacks fails the build). |
| `steamFrame.launcherMenu.hiddenApps` | list of str | `[ ]` | Desktop entry ids (no `.desktop`) hidden from the "+" and KDE menus. |

## Dashboard

Details: [dashboard.md](dashboard.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.dashboard.windows.maxScale` | null or positive number | `null` | Max resize scale of dashboard windows; `null`: stock (2), see [Dashboard windows](dashboard.md#dashboard-windows). |
| `steamFrame.dashboard.windows.distance.{world,theater,dashboard}.{min,max}` | null or positive number (m) | `null` | Pull-in / push-back limits of grabbed windows; `null`: stock (world 0.25-5, theater 1-6, dashboard 0.3-4 m). |
| `steamFrame.dashboard.steamCloseButton.enable` | bool | `false` | X button on the dashboard's Steam window, see [Steam close button](dashboard.md#steam-close-button). |
| `steamFrame.dashboard.windowCurvature.enable` | bool | `false` | Adjustable curvature per window, see [Window curvature](dashboard.md#window-curvature). |
| `steamFrame.dashboard.windowCurvature.initial` | non-negative number | `1.0` | Curvature of curved world/hand windows without own value (1 = stock, 0 = flat). |
| `steamFrame.dashboard.windowCurvature.max` | positive number | `3.0` | Largest curvature. |
| `steamFrame.dashboard.windowCurvature.step` | positive number | `0.05` | Rounding step while dragging (at most `max`). |
| `steamFrame.dashboard.windowCurvature.detentPixels` | unsigned int (px) | `24` | Detent at each detent point in drag pixels: the value holds there, then continues (nothing skipped); `0`: none. |
| `steamFrame.dashboard.windowCurvature.detentPoints` | list of non-negative numbers | `[ 0 1.0 ]` | Detent points (flat, stock), at most `max`. |
| `steamFrame.dashboard.windowCurvature.dragThresholdPixels` | unsigned int (px) | `8` | Vertical travel before a press becomes a drag. |
| `steamFrame.dashboard.windowCurvature.dragPixelsPerUnit` | positive number (px) | `120` | Drag distance per 1.0 in the menu (6 px per 0.05 step). |
| `steamFrame.dashboard.windowCurvature.barDragPixelsPerUnit` | positive number (px) | `60` | Drag distance per 1.0 on the bar button. |
| `steamFrame.dashboard.windowCurvature.haptics` | bool | `true` | Controller haptics while dragging (steps, detents, edges); the dashboard's hover clicks are muted during a drag. |
| `steamFrame.dashboard.frameControls.enable` | bool | `false` | Move window controls between bar and three-dot menu, see [Window control bar](dashboard.md#window-control-bar). |
| `steamFrame.dashboard.frameControls.longPressMs` | int, 300-10000 (ms) | `1500` | Long-press duration. |
| `steamFrame.dashboard.frameControls.inBar` | list of control names | `[ ]` | Controls that start in the bar: `keyboard`, `float`, `dashboard`, `theater`, `dockLeft`, `dockRight`, `close`, `curvature`, `"icon:<n>"`. |
| `steamFrame.dashboard.frameControls.inMenu` | list of control names | `[ ]` | Controls that start in the three-dot menu. |
| `steamFrame.dashboard.frameControls.floatInTheater` | bool | `false` | "Float" control on theater windows. |

## SteamVR debugger

Details: [steamvr-debugger.md](steamvr-debugger.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.steamvrDebugger.enable` | bool | automatic | SteamVR dashboard DevTools on `127.0.0.1:8087` (set only while SteamVR runs); on when a dashboard patch is, see [SteamVR debugger](steamvr-debugger.md). |

## Clipboard sync

Details: [desktop-integration.md](desktop-integration.md#clipboard-sync).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.clipboardSync.enable` | bool | `true` | Clipboard bridge between the Steam session and the nested desktop. |
| `steamFrame.clipboardSync.package` | package | built from `dnut/clipboard-sync` | The clipboard-sync package. |

## Firefox

Details: [firefox.md](firefox.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.firefox.enable` | bool | `false` | Launcher for the Flathub Firefox Flatpak with the fixes below. |
| `steamFrame.firefox.vrFullscreenFix` | bool | `true` | Default `full-screen-api.ignore-widgets` to `true` (not in the desktop profile). |
| `steamFrame.firefox.disableAv1` | bool | `false` | Default `media.av1.enabled` to `false`: the Frame's decoder driver has no AV1, so sites send VP9/H.264, decoded in hardware. |
| `steamFrame.firefox.prefs` | attrs of bool, int or str | `{ }` | Further `about:config` default values for every profile (override the fixes too). |
| `steamFrame.firefox.desktopProfile` | null or str | `"desktop"` | Separate profile (directory name) for the nested desktop; `null`: the default profile in both sessions. |

## Jellyfin

Details: [jellyfin.md](jellyfin.md).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.jellyfin.hardwareDecoding.enable` | bool | `false` | Hardware video decoding in the Jellyfin Desktop Flatpak, see [Jellyfin](jellyfin.md). |
| `steamFrame.jellyfin.hardwareDecoding.hwdec` | str | `"v4l2m2m-copy,auto-copy"` | mpv `hwdec` used instead of Jellyfin's automatic one. |
| `steamFrame.jellyfin.hardwareDecoding.command` | str, read-only | | The `flatpak run …` command line of the desktop entry, for a terminal. |

## Cleanup

Details: [changes-outside-nix.md](changes-outside-nix.md#cleanup).

| Option | Type | Default | Description |
|---|---|---|---|
| `steamFrame.cleanup.package` | package, read-only | | `steam-frame-nix-cleanup` (on `PATH` too), see [Changes outside Nix](changes-outside-nix.md#cleanup). |

## Renamed options

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
