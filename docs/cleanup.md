# Cleanup and installer

How `steam-frame-nix-cleanup` and `install.sh` work. What steam-frame-nix
writes outside the Nix store, how to remove it, rollback and uninstall:
[README, Changes outside Nix](../README.md#changes-outside-nix-exceptions),
[Rollback](../README.md#rollback), [Uninstall](../README.md#uninstall).

## Cleanup

`steam-frame-nix-cleanup` (`steamFrame.cleanup.package`, module `cleanup`,
imported by every module) is `install.sh cleanup`, so the same code runs
with Nix (on every switch: `cleanup --orphans --keep <what the configuration
still uses>`) and without it, from the script (bash, coreutils, findutils,
jq, all in SteamOS' `/usr/bin`). Home Manager's `uninstall = true;` runs
`cleanup --all` from the activation. `--quiet` prints only actions,
deferrals and warnings.

It removes an artifact only when it is proven to be its own; anything else
is reported as "left alone" and never touched:

| Artifact | Proof / rule |
|---|---|
| `debugger`: `VRWebHelper.DebuggerEnabled` in `steamvr.vrsettings` | `~/.local/state/steam-frame-nix/steamvr-debugger.armed` holds the value before (older versions: the empty marker `steamvr-debugger`, value before = absent). Restored once SteamVR is stopped; while it runs the runtime drop-in restores it when SteamVR stops. Also the runtime drop-in and restore script themselves. |
| `icons`: `hicolor/scalable/apps/<name>.svg` | links to Breeze in the store, listed in `~/.local/state/steam-frame-nix/icon-fallbacks` (the icon-fallbacks script of 2026-09) |
| `firefox`: `user.js` in Firefox profiles | links to `/app/etc/firefox/steam-frame-nix-desktop-user.js` (left alone while the profile is in use), older links to `*-firefox-*user.js` and copies starting with the steam-frame-nix marker comment, and the values they left in `prefs.js` (only with Firefox closed) |
| `jellyfin` | the hwdec shim entries in the Jellyfin Flatpak's user override `~/.local/share/flatpak/overrides/org.jellyfin.JellyfinDesktop` (nix-flatpak), an empty override file, and the shim copy of earlier versions in `~/.var/app/org.jellyfin.JellyfinDesktop` (marker `~/.local/state/steam-frame-nix/jellyfin-hwdec-shim`) |
| `ui-state`: `~/.local/state/steam-frame-nix/ui-patches/<name>.json` | the dashboard patches' saved choices; `--all` only, never `--orphans`; stray `*.json.tmp` files |
| `launchers`: `/run/user/1000/steam-frame-nix/applications` | the entries of [launchers](launchers.md) (tmpfs); `--all` only (switches remove those of removed launchers themselves) |
| `screenshots`: `/run/user/1000/steam-frame-nix/screenshots` | a link to `*/userdata/*/760/remote/250820/screenshots` ([SteamVR screenshots](screenshots.md)); kept by `--orphans --keep screenshots` (while `steamUserId` is unset) |
| `dirs` | `~/.local/state/steam-frame-nix` and `/run/user/1000/steam-frame-nix` when empty |

### Left by older versions

Of the rows above, only older versions wrote: the icon fallback links and
their list, the debugger marker `steamvr-debugger`, Firefox `user.js` copies
and links and their `prefs.js` values, the Jellyfin hwdec override entries
(and an empty override file) and the old shim copy.

## Installer

What `install.sh install` sets up is listed in the README under
[Set up by install.sh](../README.md#set-up-by-installsh). The installer runs
`systemctl --user` against the outer session's user manager (the nested
desktop can't reach it with its own environment) and uses the installed
`home-manager` if there is one, else Home Manager's `master`.
