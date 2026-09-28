# SteamVR debugger: how it works

`steamvrDebugger.enable` (module `steamvr-debugger`). What it is for and
what you need to do: README,
[SteamVR debugger](../README.md#steamvr-debugger-steamvrdebuggerenable).

Enabled automatically when any patch in `steamFrame.uiPatches.patches` has
an `endpoint` on port 8087 (all [dashboard](dashboard.md) patches and the VR
keyboard's strip below/above the keyboard).

SteamVR opens its DevTools port only with `VRWebHelper/DebuggerEnabled`
(port `VRWebHelper/DebuggerPort`, default 8087). SteamVR rewrites
`~/.config/openvr/config/steamvr.vrsettings` from memory, so the key can't
be a link and can't be edited while SteamVR runs. It is set only while
SteamVR runs:

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

The runtime files don't need Nix, so this also works after a rollback or
uninstall; they are gone at reboot, and `.armed` (the only trace after a
power loss) is resolved by the next SteamVR start or
`steam-frame-nix-cleanup`. A key set to `true` by the user is never touched.
Disabled, there is no unit; the switch (cleanup) restores the key if SteamVR
is stopped, otherwise the runtime drop-in does when it stops.

Until SteamVR has been restarted once with the drop-in, the port is closed
and `steam-ui-patches` keeps polling it.
