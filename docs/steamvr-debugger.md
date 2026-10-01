# SteamVR debugger

`steamvrDebugger.enable`, module `steamvr-debugger`. Automatic; nothing to
set. Options: [README, Options](../README.md#options).

## Problem

The [dashboard patches](ui-patches.md#steamvr-dashboard-patches) (and the
[VR keyboard](keyboard.md#swipe-and-suggestions)'s strip below/above the
keyboard) need SteamVR's DevTools port, which SteamVR opens only with its
setting `VRWebHelper/DebuggerEnabled`. That setting lives in
`~/.config/openvr/config/steamvr.vrsettings`, which SteamVR rewrites from
memory, so it can't be a Nix link and can't be edited while SteamVR runs.

## What you get

The port, enabled automatically when any patch in
`steamFrame.uiPatches.patches` has an `endpoint` on port 8087. The setting
is **set only while SteamVR runs**: set before every SteamVR start, put back
to its previous value when SteamVR stops, also after a rollback or uninstall
(without Nix). A value you set to `true` yourself is never touched.

**The first time, restart SteamVR once** (e.g. reboot); until then the
dashboard patches wait. SteamVR opens the port only when it starts, so no
switch or install can do it for a running SteamVR; the switch (and
`install.sh install` at its end) says so while SteamVR runs without the port
(`install.sh restart-check`). Turned off, the setting is restored at the
switch (or when SteamVR stops, if it runs).

## Security

The port listens on `127.0.0.1` only; keep Developer Mode off (see
[DevTools on the LAN](ui-patches.md#devtools-on-the-lan)).

## How it works

Port: `VRWebHelper/DebuggerPort`, default 8087.

- before every SteamVR start, the `steamvr-webhelper-debugger` oneshot
  (a drop-in on `steamvr.service`, running `install.sh steamvr-debugger-arm`)
  stores the key's value in
  `~/.local/state/steam-frame-nix/steamvr-debugger.armed`, sets the key
  (with `jq`) and writes a runtime drop-in,
  `/run/user/1000/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf`,
  whose `ExecStopPost=` runs a restore script next to it
  (`/run/user/1000/steam-frame-nix/`, `/usr/bin` tools only);
- when SteamVR stops, the key goes back to its previous value (removed if
  it wasn't there) and `.armed` is removed.

The runtime files need no Nix (rollback, uninstall) and are gone at reboot;
`.armed`, the only trace after a power loss, is resolved by the next
SteamVR start or `steam-frame-nix-cleanup`.
