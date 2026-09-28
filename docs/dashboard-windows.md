# Dashboard windows

`dashboard.windows.*`, module `dashboard-windows` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches).

## Problem

SteamVR dashboard windows can only be enlarged to 2x, and grabbed windows
pushed back only to 5 m (6 m in theater), too close for a big screen.

## What you get

Higher limits (`null` keeps stock):

| Option | Stock |
|---|---|
| `maxScale` | 2 (relative to the window's default size; the theater screen's default is 2.8x larger) |
| `distance.world.{min,max}` | 0.25-5 m |
| `distance.theater.{min,max}` | 1-6 m |
| `distance.dashboard.{min,max}` | 0.3-4 m |

Distances limit pulling in / pushing back a grabbed window (thumbstick or
scroll while dragging). Changes apply immediately, and turning options off
reverts on the next switch. The keyboard's range is not patched.

## Configuration

```nix
steamFrame.dashboard.windows = {
  maxScale = 4.0;              # resize up to 4x (theater: 11.2x)
  distance.world.max = 10.0;   # push windows back up to 10 m
  distance.theater.max = 12.0;
};
```

## Caveats

If SteamVR changes its stock grab distances, the distance options silently
do nothing.

## How it works

`systemui` sends its scene graph to vrcompositor via
`mailbox.SendMessage("vrcompositor_systemlayer", { type: "update_scene_graph", scene_graph })`,
and vrcompositor enforces the limits in it:

- `frame-resize-scale-min` / `-max` on window frames;
- `min-distance` / `max-distance` on grab nodes: `grab-scale` for world
  windows, `grab-transform` for the theater screen and the dashboard (the
  keyboard's `grab-transform`, 0.2 / 1 m, is left alone).

They are literals in the bundle, so the patch hooks `SendMessage` on the
mailbox prototype ([shared hooks](ui-patches.md#shared-method-hooks), shared
with [window curvature](window-curvature.md)) and edits outgoing scene graphs
in place. Grab nodes are matched by type plus exact stock values, which is
why a change of them makes the distance rewrite a no-op. A scene-graph
resend applies new limits at once.

State: `window.__sfuiDashboardWindows` in the `systemui` page (counters in
`.hits`).
