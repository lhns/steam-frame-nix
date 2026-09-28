# Cleanup and installer: how they work

What steam-frame-nix writes outside the Nix store, how to remove it, and
rollback/uninstall: README,
[Changes outside Nix](../README.md#changes-outside-nix-exceptions),
[Rollback](../README.md#rollback), [Uninstall](../README.md#uninstall).

## Cleanup

`steam-frame-nix-cleanup` (`steamFrame.cleanup.package`, module `cleanup`,
imported by every module) is `install.sh cleanup`, so the same code runs
with Nix (on every switch: `cleanup --orphans --keep <what the configuration
still uses>`) and without it, from the script (bash, coreutils, findutils,
jq, all in SteamOS' `/usr/bin`). Home Manager's `uninstall = true;` runs
`cleanup --all` from the activation.

It knows everything any version wrote outside the store and removes an
artifact only when it is proven to be its own; anything else is reported as
"left alone" and never touched:

| Artifact | Proof / rule |
|---|---|
| `debugger`: `VRWebHelper.DebuggerEnabled` in `steamvr.vrsettings` | `~/.local/state/steam-frame-nix/steamvr-debugger.armed` holds the value before (older versions: the empty marker `steamvr-debugger`, value before = absent). Restored once SteamVR is stopped; while it runs the runtime drop-in restores it when SteamVR stops. Also the runtime drop-in and restore script themselves. |
| `icons`: `hicolor/scalable/apps/<name>.svg` | links to Breeze in the store, listed in `~/.local/state/steam-frame-nix/icon-fallbacks` (the icon-fallbacks script of 2026-09) |
| `firefox`: `user.js` in Firefox profiles | links to `/app/etc/firefox/steam-frame-nix-desktop-user.js` (left alone while the profile is in use), older links to `*-firefox-*user.js` and copies starting with the steam-frame-nix marker comment, and the values they left in `prefs.js` (only with Firefox closed) |
| `jellyfin` | the hwdec shim entries in the Jellyfin Flatpak's user override `~/.local/share/flatpak/overrides/org.jellyfin.JellyfinDesktop` (nix-flatpak), an empty override file, and the shim copy of earlier versions in `~/.var/app/org.jellyfin.JellyfinDesktop` (marker `~/.local/state/steam-frame-nix/jellyfin-hwdec-shim`) |
| `ui-state`: `~/.local/state/steam-frame-nix/ui-patches/<name>.json` | the dashboard patches' saved choices; `--all` only, never `--orphans`; stray `*.json.tmp` files |
| `dirs` | `~/.local/state/steam-frame-nix` and `/run/user/1000/steam-frame-nix` when empty |

### Left by older versions

The rows above include what only older versions wrote: the icon fallback
links and their list (`~/.local/state/steam-frame-nix/icon-fallbacks`), the
debugger marker `steamvr-debugger`, Firefox `user.js` copies and links and
their `prefs.js` values, the Jellyfin hwdec entries of
`~/.local/share/flatpak/overrides/org.jellyfin.JellyfinDesktop` (an empty
override file too) and the old shim copy in
`~/.var/app/org.jellyfin.JellyfinDesktop`.

## Set up by install.sh

`install.sh install` (the bootstrap, not the modules) changes more, and
`install.sh uninstall` undoes it:

- Nix via [nix-installer](https://github.com/NixOS/nix-installer)
  (`steam-deck` planner, flakes on): `/nix` (bind mount of `/home/nix`,
  survives SteamOS updates), files in `/etc` (systemd units, profile
  scripts, `nix.conf`) and its receipt `/nix/receipt.json`; the read-only
  root is unlocked only while it installs or uninstalls. Skipped if Nix
  already works;
- `experimental-features = nix-command flakes` in `~/.config/nix/nix.conf`
  if Nix was already there without flakes;
- `~/nix-config` (your configuration, a git repository, from the template
  with your user name filled into `flake.nix`) and the link
  `~/.config/home-manager` to it, unless `~/.config/home-manager` exists or
  `--flake <dir-or-flakeref>` is given; uninstall removes the link, never
  the configuration;
- dotfiles Home Manager found in its way, renamed to `*.hm-backup-<time>`
  (kept by uninstall);
- `~/.local/state/home-manager` and `~/.local/state/nix` (profiles,
  generations), `~/.nix-profile`, `~/.nix-defexpr`, `~/.nix-channels`,
  `~/.cache/nix`.

The installer runs `systemctl --user` against the outer session's user
manager (the nested desktop can't reach it with its own environment) and
uses the installed `home-manager` if there is one, else Home Manager's
`master`.
