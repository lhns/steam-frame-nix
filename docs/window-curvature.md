# Window curvature

`dashboard.windowCurvature.*`, module `window-curvature` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches).

## Problem

SteamVR dashboard windows are either curved (fixed radius) or flat, and
world windows start flat.

## What you get

The "Toggle Curvature" row of a window's three-dot menu becomes a control
showing the window's value; the same control in the bottom bar (see
[window control bar](window-control-bar.md)) works without the value, with
haptic steps.

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

## Configuration

```nix
steamFrame.dashboard.windowCurvature = {
  enable = true;
  # initial = 1.0;  max = 3.0;  step = 0.05;
  # detentPoints = [ 0 1.0 ];  detentPixels = 24;
  # dragPixelsPerUnit = 60;    # full range in one drag (see below)
};
```

## Limitations

- Laser only; with gamepad navigation the row is the stock toggle.
- No thumbstick scrolling (SteamVR sends no wheel events to the menu).
- The laser stops at the menu's edge (~190 px above the row): with the
  default 120 px per 1.0, 0 → 1 fits into one drag, 0 → 3 takes two. Lower
  `dragPixelsPerUnit` (≤ 60) for the full range in one drag.

## How it works

Stock curvature: the frame renders a transform `frame:<id>:curvature-origin`
at `z = DashboardStore.curvatureDistance` when curved, else 1000; its panels
reference it as `curvature-origin-id` and vrcompositor bends them onto a
cylinder around it (curvature = 1/radius). Those MobX properties are
non-configurable, so the patch hooks the mailbox `SendMessage`
([shared hooks](ui-patches.md#shared-method-hooks), shared with
[dashboard windows](dashboard-windows.md)) and rewrites the origin's z in
outgoing scene graphs to stock / value. On/off stays the stock toggle state,
so stock toggle and wheel always agree.

Values are kept per window (key: first overlay key) in
`window.__sfuiWindowCurvatureState`, across re-patch and unpatch, not across
a dashboard reload. The bar button uses the coordinates SteamVR keeps
sending past the pressed panel's edge while the trigger is held; the bar
panel is never resized.

Debugging: `window.__sfuiWindowCurvature.dump()` (`.log` recent events).

### Contract for other patches

For patches handling presses on the curvature controls (e.g. the window
control bar's long press); the curvature patch owns press-and-drag on them:

- Every element the patch drives has class `sfui-curv-ctl`.
- When a press becomes a drag (`dragThresholdPixels` vertical from where the
  press started), a bubbling `CustomEvent` `sfui-curv-dragstart` (detail
  `{ frameID, where: 'menu' | 'bar' }`) is dispatched on the element, and
  `sfui-curv-dragend` when that drag ends (release or `cancelPress()`).
- `window.__sfuiWindowCurvature.scalePressDragThreshold(factor)` sets the
  current press's drag threshold to `factor` × `dragThresholdPixels`, still
  measured from the press start; returns whether it applied (a press that
  is not yet a drag). The next press starts at 1×.
- `window.__sfuiWindowCurvature.cancelPress()` ends the current press
  without its click (a drag keeps its value); returns whether a press was
  active.

A patch with its own gesture lets `mousemove` through while undecided,
drops its gesture on `sfui-curv-dragstart`, may raise the threshold while
its gesture is under way, and calls `cancelPress()` when it takes the press
over. Neither side reads the other's thresholds or restores the other's
state.
