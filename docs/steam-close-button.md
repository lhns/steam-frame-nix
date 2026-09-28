# Steam close button

`dashboard.steamCloseButton.enable`, module `steam-close-button` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches).

## Problem

Every dashboard window has a close (X) button except Steam's own, and with
no other window open the dashboard always shows it.

## What you get

The Steam window gets an X that hides Steam: it docks the window back if it
was in the world, theater or on a hand, then shows the most recently active
other dashboard window, or **just the dashboard bar** if there is none.

Steam stays hidden until you bring it back (Steam tab, a Steam menu pick,
SteamVR asking for it): closing the active window, or a theater window,
then goes to the previous window or the bar instead of Steam. This survives
dashboard reopens, patch-service restarts, SteamVR restarts and reboots
("Steam hidden" is saved in
`~/.local/state/steam-frame-nix/ui-patches/steam-close-button.json`, see
[Changes outside Nix](../README.md#changes-outside-nix-exceptions)). After a
restart the patch attaches a few seconds after the dashboard appears,
possibly after SteamVR has already shown Steam: if Steam is (or first
becomes) the active window then, it is hidden once like with X (only the bar
at that point); otherwise it just stays hidden.

## Configuration

```nix
steamFrame.dashboard.steamCloseButton.enable = true;
```

## Limitations

- SteamVR's rarer "go home" paths (Now Playing after a game quits, message
  overlays) still show Steam.
- No effect with a VRLink remote dashboard.
- Turning the option off while bar-only leaves no active window until the
  next tab click or dashboard open.

## How it works

`steam-close-button`, with [persistent state](ui-patches.md#persistent-state)
(`{ schema: 1, steamHidden }`).

- **Button:** the frame's `closing` component shows X when
  `componentProps.onCloseRequested` exists; the Steam window's instance
  (overlay `valve.steam.gamepadui.main`) gets one and its props are
  re-assigned so the MobX computed re-evaluates.
- **Staying hidden:** while hidden, stock fallbacks to Steam go to the
  previous window or bar-only instead: `Dashboard.autoSwitchOverlayIfNeeded`
  (instance override) and the mailbox handler `dashboard_overlay_destroyed`.
  Mailbox show/switch requests for Steam with reason `SetDockLocation` (the
  echo of X docking Steam) are dropped, "theater frame destroyed" ones are
  passed on without the Steam key. Explicit requests (tab click, Steam menu
  pick, `SwitchToDashboardOverlay`) show Steam again.
- **Restarts:** a restored hidden state stays pending (`restorePending`)
  until Steam's frame is seen, since the injector attaches within ~5 s of
  the page appearing.

Debugging: `window.__sfuiSteamClose.plan()` / `homePlan()` in the `systemui`
page; state in `window.__sfuiSteamCloseState` (survives re-injection;
teardown restores all overrides and never switches frames).
