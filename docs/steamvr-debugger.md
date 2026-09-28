# SteamVR debugger

`steamvrDebugger.enable`, automatic: on when any patch in
`steamFrame.uiPatches.patches` uses port 8087 (all [dashboard](dashboard.md)
patches and the VR keyboard's strip below/above the keyboard).

**Problem:** dashboard patches need SteamVR's DevTools port, opened only
with `VRWebHelper/DebuggerEnabled` (port `VRWebHelper/DebuggerPort`, default
8087). SteamVR rewrites `~/.config/openvr/config/steamvr.vrsettings` from
memory, so the key can't be a link and can't be edited while SteamVR runs.

**What it does:** sets the key only while SteamVR runs:

- before every SteamVR start, the `steamvr-webhelper-debugger` oneshot
  (a drop-in on `steamvr.service`) stores the key's value in
  `~/.local/state/steam-frame-nix/steamvr-debugger.armed`, sets the key
  (with `jq`) and writes a runtime drop-in,
  `/run/user/1000/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf`,
  whose `ExecStopPost=` runs a restore script next to it
  (`/run/user/1000/steam-frame-nix/`, `/usr/bin` tools only);
- when SteamVR stops, the key goes back to its previous value (removed if
  it wasn't there) and `.armed` is removed.

The runtime files don't need Nix, so this also works after a rollback or
uninstall; they are gone at reboot. A key you set to `true` yourself is
never touched. Disabled, there is no unit; the switch restores the key if
SteamVR is stopped, otherwise the runtime drop-in does when it stops.

**The first time, restart SteamVR once** (e.g. reboot); until then
`steam-ui-patches` keeps polling.

**Security:** the port listens on `127.0.0.1` only; keep Developer Mode off
(see [DevTools on the LAN](ui-patches.md#devtools-on-the-lan)).

What it writes and when it is removed:
[changes outside Nix](changes-outside-nix.md).
