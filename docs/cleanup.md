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

`install --clone` takes SteamOS' `git`, else `nix run nixpkgs#git`, always
with `GIT_TERMINAL_PROMPT=0`. "The unchanged template": `create_config`
writes the hash of the configuration's files (without `.git`) to
`.git/steam-frame-nix-template`; it must still match, with at most one
commit. `create_config` locks the template as `path:` (no "dirty" warning)
and commits everything once, with the user's git identity or, missing
that, `-c user.name=<user> -c user.email=<user>@localhost` for that commit
only. Any other directory is used as it is, `--ref` ignored. The template
is created and activated only into an empty target without
`~/.config/home-manager`; with another configuration linked, git clones
with that one's helpers. The switch to an existing template is skipped when
it is linked, Home Manager is installed and git has a credential helper.
The clone goes to `.<dir>.clone.XXXXXX` next to the target (removed on
failure or exit), then replaces the template (checked unchanged again).
`gh auth login --hostname github.com --git-protocol https`, with the Home
Manager profile's `gh`, is offered only for `https://github.com/` URLs and
with a terminal. Tests: section G of `modules/cleanup/check.nix` (a logging
git, a fake nix, `STEAM_FRAME_NIX_TTY` instead of `/dev/tty`).

`restart-check` (run by the session module's activation after
`steamFrameUserServices`, and by `install` at its end) compares the
keyboard layout drop-in on `gamescope-session.service` with
`XKB_DEFAULT_*` in the environment of the first readable process in that
unit's cgroup (gamescope's own isn't readable), and, while SteamVR runs
with the debugger drop-in, looks for a listener on port 8087 in
`/proc/net/tcp*`. Tests use `STEAM_FRAME_NIX_PROC` and
`STEAM_FRAME_NIX_CGROUP` (section F of `modules/cleanup/check.nix`).

`uninstall` removes Nix with nix-installer (from a root-owned copy in
`/tmp`), whose `systemctl stop nix.mount` fails while a process uses `/nix`;
in the Steam session some always do until logout (e.g. Steam and
xdg-desktop-portal, once they mapped a file from the store). So a runtime
drop-in, `/run/systemd/system/nix.mount.d/50-steam-frame-nix-lazy-unmount.conf`
with `LazyUnmount=yes`, makes that stop detach `/nix` (`umount -l`): the
programs keep their open files until they exit. The drop-in is removed
afterwards, also on failure or Ctrl+C. Listed first, for information: the
processes whose `exe`, `cwd`, `root` or an `fd` links into `/nix`, or whose
`maps` names a file there (only the user's own are readable), except the
script itself, its subshells and its process group (the `curl | bash`
pipeline). Tests: section H of `modules/cleanup/check.nix`
(`STEAM_FRAME_NIX_PROC` as a fake `/proc`, `STEAM_FRAME_NIX_SYSTEM_RUNTIME`
for the drop-in, a logging nix-installer).
