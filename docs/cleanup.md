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
grep, sed, awk, jq, all in SteamOS' `/usr/bin`). Home Manager's
`uninstall = true;` runs `cleanup --all` from the activation. `--quiet`
prints only actions, deferrals and warnings.

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
| `pet`: `/run/user/1000/steam-frame-nix/vr-pet` | `icon.png`, a link to `*-vr-pet-icons/*.png` in the store ([VR pet](pet.md#how-it-works)), its empty `.lock` and stray `.icon.tmp.*` links, then the directory if empty; kept by `--orphans --keep pet` (while `pet.enable`) |
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

`install --clone` takes SteamOS' `git`, else `nix run nixpkgs#git`. An
existing directory is reused only if it is the top of a clone whose
`origin` is the same repository: URLs are compared as lower-case
host/path without `.git` (so `git@host:o/r`, `ssh://git@host/o/r` and
`https://host/o/r.git` match), and with `--ref` it must be on that branch.

`restart-check` (run by the session module's activation after
`steamFrameUserServices`, and by `install` at its end) compares the
keyboard layout drop-in on `gamescope-session.service` with
`XKB_DEFAULT_*` in the environment of the first readable process in that
unit's cgroup (gamescope's own isn't readable), and, while SteamVR runs
with the debugger drop-in, looks for a listener on port 8087 in
`/proc/net/tcp*`. Tests use `STEAM_FRAME_NIX_PROC` and
`STEAM_FRAME_NIX_CGROUP` (section F of `modules/cleanup/check.nix`).

`uninstall` removes Nix with nix-installer, which fails when it can't
unmount `/nix` (`systemctl stop nix.mount`). Before that it scans `/proc`
for processes using `/nix`: their `exe`, `cwd`, `root` or an `fd` links into
`/nix`, or `maps` names a file there (e.g. an app started before the
uninstall that mapped Home Manager's `mime.cache`). Only the user's own
processes are readable; the Nix daemon is nix-installer's to stop. Skipped:
the script itself, its subshells (descendants) and its process group (the
`curl | bash` pipeline). Its ancestors are listed with a hint to run
`uninstall` from another terminal. Nothing is killed: it asks to close them
and re-checks on Enter, or (`--yes`, no terminal) stops before Nix. A bash
from the Nix store re-executes the script with `/usr/bin/bash` first, and
nix-installer runs from a root-owned copy in `/tmp`. The check uses
`STEAM_FRAME_NIX_PROC` as a fake `/proc` (section H of
`modules/cleanup/check.nix`).
