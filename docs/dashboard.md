# SteamVR dashboard

Four patches of SteamVR's dashboard (`systemui` page): [window size and
distance](#dashboard-windows), [Steam close button](#steam-close-button),
[window curvature](#window-curvature), [window control bar](#window-control-bar).
Options: [options.md#dashboard](options.md#dashboard).

All are [UI patches](ui-patches.md) and turn on the
[SteamVR debugger](steamvr-debugger.md). Each is found by signature (its
entry in `signatures.json` has the patch's name); on mismatch the dashboard
stays stock. Tested with SteamVR build 11008059.

## Dashboard windows

`dashboard.windows.*`.

**Problem:** dashboard windows can only be enlarged to 2x, and grabbed
windows pushed back only to 5 m (6 m in theater), too close for a big
screen.

**What it does:** raises these limits, which the dashboard sends to the
compositor in its scene graph. `null` keeps stock:

| Option | Stock |
|---|---|
| `maxScale` | 2 (relative to the window's default size; the theater screen's default is 2.8x larger) |
| `distance.world.{min,max}` | 0.25-5 m |
| `distance.theater.{min,max}` | 1-6 m |
| `distance.dashboard.{min,max}` | 0.3-4 m |

Distances limit pulling in / pushing back a grabbed window (thumbstick or
scroll while dragging). Changes apply immediately; turning options off
reverts on the next switch. The keyboard's range is not patched.

```nix
steamFrame.dashboard.windows = {
  maxScale = 4.0;              # resize up to 4x (theater: 11.2x)
  distance.world.max = 10.0;   # push windows back up to 10 m
  distance.theater.max = 12.0;
};
```

**Caveat:** grab nodes are recognized by their exact stock values, so if
SteamVR changes them the distance options silently do nothing. State:
`window.__sfuiDashboardWindows`.

## Steam close button

`dashboard.steamCloseButton.enable`.

**Problem:** every dashboard window has a close (X) button except Steam's
own, and with no other window open the dashboard always shows it.

**What it does:** gives the Steam window an X that hides Steam: it docks the
window back if it was in the world, theater or on a hand, then shows the
most recently active other dashboard window, or **just the dashboard bar**
if there is none.

Steam stays hidden until you bring it back (Steam tab, a Steam menu pick,
SteamVR asking for it): closing the active window, or a theater window, then
goes to the previous window or the bar instead of Steam. This survives
dashboard reopens, patch-service restarts, SteamVR restarts and reboots
("Steam hidden" is saved in
`~/.local/state/steam-frame-nix/ui-patches/steam-close-button.json`, see
[persistent state](ui-patches.md#persistent-state)). After a restart the
patch attaches a few seconds after the dashboard appears, possibly after
SteamVR has already shown Steam: if Steam is (or first becomes) the active
window then, it is hidden once like with X (only the bar at that point);
otherwise it just stays hidden.

**Limitations:** SteamVR's rarer "go home" paths (Now Playing after a game
quits, message overlays) still show Steam; no effect with a VRLink remote
dashboard; turning the option off while bar-only leaves no active window
until the next tab click or dashboard open.

Debugging: `window.__sfuiSteamClose.plan()` / `homePlan()` and
`window.__sfuiSteamCloseState`.

## Window curvature

`dashboard.windowCurvature.*`.

**Problem:** dashboard windows are either curved (fixed radius) or flat, and
world windows start flat.

**What it does:** turns the "Toggle Curvature" row of a window's three-dot
menu into a control showing the window's value; the same control in the
bottom bar (see [window control bar](#window-control-bar)) works without the
value, with haptic steps.

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

Debugging: `window.__sfuiWindowCurvature.dump()` (`.log` recent events).

### Contract for other patches

For patches handling presses on the curvature controls: every
element the patch drives has class `sfui-curv-ctl`; when a press becomes a
drag, a bubbling `CustomEvent` `sfui-curv-dragstart` (detail
`{ frameID, where: 'menu' | 'bar' }`) is dispatched on it, and
`sfui-curv-dragend` when it ends;
`window.__sfuiWindowCurvature.scalePressDragThreshold(factor)` sets the
current press's drag threshold to `factor` × `dragThresholdPixels` (from the
press start; returns whether it applied, i.e. a press that is not yet a
drag); `window.__sfuiWindowCurvature.cancelPress()` ends a press without its
click. A patch with its own gesture lets `mousemove` through while
undecided, drops its gesture on `sfui-curv-dragstart`, may raise the
threshold while its gesture is under way, and calls `cancelPress()` when it
takes the press over.

## Window control bar

`dashboard.frameControls.*`.

**Problem:** the controls under a dashboard window are fixed: some in the
bottom bar, others only in the three-dot menu (curvature, dock to a
controller), and theater windows have no "Float".

**What it does:**

- **long press** a bar icon or menu row (`longPressMs`; a progress ring
  shows from half the time, at most after 1 s), then **Show in bar** in the
  popup moves that control between bar and menu **for all windows**.
  Placements survive SteamVR restarts and reboots (saved in
  `~/.local/state/steam-frame-nix/ui-patches/frame-controls.json`, see
  [persistent state](ui-patches.md#persistent-state)).
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

With [window curvature](#window-curvature), a drag on the curvature control
adjusts curvature and cancels the long press, also after the ring shows;
once the ring shows, the drag needs 3× the usual travel
(`dragThresholdPixels`, counted from where the press started), so laser
drift during the hold doesn't cancel it.

**Limitations:** laser only (no right-click or thumbstick click reaches the
dashboard; gamepad navigation sees stock controls); placements are per
control type, not per window.

Debugging: `window.__sfuiFrameControls.dump()`, `.placement()`, `.reset()`
(forget choices), `.log`, `window.__sfuiFrameControlsState`.
