# Window control bar

`dashboard.frameControls.*`, module `frame-controls` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches).

## Problem

The controls under a dashboard window are fixed: some in the bottom bar,
others only in the three-dot menu (curvature, dock to a controller), and
theater windows have no "Float".

## What you get

- **long press** a bar icon or menu row (`longPressMs`; a progress ring
  shows from half the time, at most after 1 s), then **Show in bar** in the
  popup moves that control between bar and menu **for all windows**.
  Placements survive SteamVR restarts and reboots (saved in
  `~/.local/state/steam-frame-nix/ui-patches/frame-controls.json`, see
  [Changes outside Nix](../README.md#changes-outside-nix-exceptions)).
  Short presses stay stock.
- `inBar` / `inMenu` set where controls start; a popup choice wins until
  that control's entry changes.
- `floatInTheater` gives theater windows the "Float" control.

With [window curvature](window-curvature.md), a drag on the curvature
control adjusts curvature and cancels the long press, also after the ring
shows; once the ring shows, the drag needs 3× the usual travel
(`dragThresholdPixels`, counted from where the press started), so laser
drift during the hold doesn't cancel it.

## Configuration

```nix
steamFrame.dashboard.frameControls = {
  enable = true;
  # longPressMs = 1500;
  # inBar = [ "curvature" ];  inMenu = [ "theater" ];
  # floatInTheater = true;
};
```

## Limitations

- Laser only: no right-click or thumbstick click reaches the dashboard;
  gamepad navigation sees stock controls.
- Placements are per control type, not per window.
- The three-dot button itself can't be moved.

## How it works

`frame-controls`, with [persistent state](ui-patches.md#persistent-state)
(placements). Works with window curvature through its
[contract](window-curvature.md#contract-for-other-patches).

Debugging: `window.__sfuiFrameControls.dump()`, `.placement()`, `.reset()`
(forget choices), `.log`, `window.__sfuiFrameControlsState`.
