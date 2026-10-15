# Passthrough toggle

`dashboard.passthroughToggle.enable`, module `passthrough-toggle` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches) plus a
user service and a small native helper.

## Problem

The VR dashboard's room-view ("passthrough") button only has one state: an
eye icon that shows your surroundings in monochrome and hides them again.
With an Arcturus RGB accessory attached, SteamVR can show a colour feed
instead, but nothing in the stock UI lets you reach it.

## What you get

The same button now cycles **Off → colour → mono → Off**: Off turns room
view on and immediately tries colour; a second click swaps to mono; a third
turns it off again. The icon tints purple while in colour. Without an
Arcturus RGB accessory, colour is still tried but there is nothing colour
to show, so it quietly stays mono.

Reopening the dashboard, a SteamVR restart, or something else changing room
view (a controller binding, say) all pick up the real state the next time
the bar becomes visible or room view turns on -- never guessed, never
polled continuously.

## Configuration

```nix
steamFrame.dashboard.passthroughToggle.enable = true;
```

## Limitations

- Colour needs an Arcturus RGB accessory; without one the cycle still works
  (Off → mono → Off, see [Problem](#problem)).
- Uses SteamVR's private camera interface (below), which may change in a
  future SteamVR update. `scripts/check-signatures.mjs` and the helper's
  exit codes are the early warning: a changed interface makes the toggle
  fail safe (no write) rather than do something unexpected.

## How it works

Dashboard patch `passthrough-toggle` (`patch.js`), user service
`passthrough-toggle-relay` (`relay.mjs` + `request.mjs`), helper
`steam-frame-nix-passthrough` (`src/main.rs`, Rust) -- each has its own
header comment with the approach. Adapted from
[toorux/steam-frame-passthrough-toggle](https://github.com/toorux/steam-frame-passthrough-toggle)
and
[KominoVR/frame-passthrough-shortcuts](https://github.com/KominoVR/frame-passthrough-shortcuts)
(facts, not code; see the README's [Credits](../README.md#credits)); unlike
upstream, nothing here opens a network port, writes a preference file, or
needs Developer Mode.

- **Button and press:** found in the dock's own bar popups (never the "+"
  menu's lookalike) by the room-view action's shape, not its id, which
  changes across SteamVR restarts; each bar popup is its own window, so
  the listener and icon attach to every one. Every press is queued, one
  at a time, decided from live state (room view's `active` plus the
  helper's last read-back source): off tries colour and replays the stock
  click; on+colour asks for mono; on+mono replays the stock click (off).
  Quick presses wait their turn, and status refreshes share the same
  queue, so no stale reply overtakes a decision. The icon (a
  `data-sfui-passthrough` attribute plus a per-window stylesheet) follows
  within a tick of any change, from confirmed state only.
- **Relay:** a CDP binding (`__sfuiPassthroughCall`) on Steam's
  SharedJSContext; only `{op:"status"}` and
  `{op:"set",source:"rgb"|"mono"}` reach the helper, one call at a time,
  each with an 8 s timeout.
- **Helper (`steam-frame-nix-passthrough`):** the only process that talks
  to SteamVR, and never writes anything to disk. Dlopens SteamVR's own
  `vrclient.so` (found via `openvrpaths.vrpath`, falling back to
  `/opt/steamvr`) the same way `openvr_api.so` does internally, and
  changes only byte 2 of the camera's 5-byte configuration, only while
  byte 0 is already 1, then reads back to confirm. Exit codes: `0` ok;
  `2` SteamVR unreachable; `3` interface missing or holds values outside
  0/1 (nothing written either way); `4` anything else (a write SteamVR
  didn't retain, or bad usage).
- **Arcturus RGB camera detection:** `/sys/class/video4linux/<node>/name`
  starting with `arcimx616 ` names a sensor node (`v4l-subdevN` on the
  Frame, not `videoN`); a read-only ioctl on the matching `/dev/<node>`
  reports whether it is physically connected. Checked fresh on every
  helper call, not polled continuously.
- **Cleanup:** SteamVR writes its own per-process log the moment the
  helper runs, kept while the toggle is enabled and removed otherwise
  (see [Changes outside Nix](../README.md#changes-outside-nix-exceptions)).

Debugging: failed helper calls are logged in
`journalctl --user -u passthrough-toggle-relay`;
`steam-frame-nix-passthrough status` by hand (only while SteamVR runs; never
run `set` by hand while debugging something else -- it changes the live
camera source).
