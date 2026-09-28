# Changes outside Nix

Everything not listed here is a Home Manager link into the Nix store or
lives in memory (the [UI patches](ui-patches.md)).

## Written at runtime

| Path | Feature | Lifetime | Removed by |
|---|---|---|---|
| `VRWebHelper.DebuggerEnabled` in `~/.config/openvr/config/steamvr.vrsettings` | [SteamVR debugger](steamvr-debugger.md) | only while SteamVR runs | SteamVR stopping (runtime drop-in below); `steam-frame-nix-cleanup` while SteamVR is stopped |
| `~/.local/state/steam-frame-nix/steamvr-debugger.armed` | SteamVR debugger: the key's previous value | while SteamVR runs; after a power loss until the next SteamVR start or cleanup | SteamVR stopping; `steam-frame-nix-cleanup` |
| `/run/user/1000/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf`, `/run/user/1000/steam-frame-nix/steamvr-debugger-restore` | SteamVR debugger: puts the key back when SteamVR stops, without Nix | until reboot (tmpfs) | reboot; `steam-frame-nix-cleanup` while SteamVR is stopped and the debugger is off |
| `~/.local/state/steam-frame-nix/ui-patches/<name>.json` | [persistent state](ui-patches.md#persistent-state) of dashboard patches: window control bar placements (`frame-controls`), "Steam hidden" (`steam-close-button`). SteamOS's `steamvr.service` deletes `~/.cache/SteamVR` (the dashboard's own browser storage) on every SteamVR start. | until removed: kept when a patch is disabled (the choices come back when you enable it again) | `steam-frame-nix-cleanup --all`, `install.sh uninstall` |
| mtime of `~/.local/share/icons/hicolor` | [icon fallbacks](launcher-menu.md#icon-fallbacks): a running Steam rescans icons | only the directory's timestamp | nothing to remove |

## Only while running

- The UI patches (Steam, SteamVR dashboard, VR keyboard) live in the pages'
  memory; stopping `steam-ui-patches` / `steam-keyboard-patch` reverts them.
- clipboard-sync runs from KDE autostart (a Home Manager link).
- Firefox: the desktop profile's `user.js` link exists only while its
  Firefox runs (see [Firefox](firefox.md#how-it-works)).
- Jellyfin: the hardware decoding permissions are `flatpak run` options of
  the desktop entry, not a Flatpak override.

## Cleanup

**`steam-frame-nix-cleanup`** (`install.sh cleanup`,
`steamFrame.cleanup.package`) knows everything any version of
steam-frame-nix wrote outside the store, removes only what is provably its
own (everything else is reported as "left alone") and can be run again
safely; `--dry-run` shows what it would do.

- On every switch, `cleanup --orphans` removes what the configuration no
  longer uses (never the saved patch state).
- `steam-frame-nix-cleanup --all` removes everything, also the saved patch
  state. SteamVR's key can't be changed while SteamVR runs: it is then left
  to the runtime drop-in (restored when SteamVR stops).
- Without Nix or after a rollback it runs from the script
  (bash, coreutils, findutils, jq, all in SteamOS' `/usr/bin`):
  `curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all`.
- It also removes what older versions left: the icon fallback links and
  their list (`~/.local/state/steam-frame-nix/icon-fallbacks`), the
  debugger marker `steamvr-debugger`, Firefox `user.js` copies and links
  and their `prefs.js` values, the Jellyfin hwdec entries of
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
  with your user name) and the link `~/.config/home-manager` to it, unless
  `~/.config/home-manager` exists or `--flake <dir-or-flakeref>` is given;
  uninstall removes the link, never the configuration;
- dotfiles Home Manager found in its way, renamed to `*.hm-backup-<time>`
  (kept by uninstall);
- `~/.local/state/home-manager` and `~/.local/state/nix` (profiles,
  generations), `~/.nix-profile`, `~/.nix-defexpr`, `~/.nix-channels`,
  `~/.cache/nix`.

## App data you create

Not steam-frame-nix's to remove: the Firefox desktop profile
(`~/.var/app/org.mozilla.firefox/config/mozilla/firefox/desktop`, browser
data), and whatever apps keep in `~/.var/app/*`, Flatpak apps and their
runtimes.

## Rollback

`home-manager generations` lists previous generations; run
`<store path>/activate` of the one you want. Generations with
steam-frame-nix clean up after themselves on activation (orphans). After
rolling back to a generation **without** steam-frame-nix, or to one older
than `steam-frame-nix-cleanup` (2026-09-29), remove what the newer one wrote
outside the store:

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all
# or: nix run github:lhns/steam-frame-nix#cleanup -- --all
```

## Uninstall

```sh
curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall   # --keep-nix keeps Nix
```

stops Home Manager's user services (reverting the UI patches), runs
`cleanup --all`, runs `home-manager uninstall`, then removes Nix and the
per-user Nix state (see [Set up by install.sh](#set-up-by-installsh)). If
SteamVR is running, its key is restored when SteamVR stops (the closing
message says so). Your configuration, `*.hm-backup-*` files, app data and
Flatpaks stay.

To drop steam-frame-nix from a Home Manager configuration you keep, first
run `steam-frame-nix-cleanup --all`, then remove it and switch. Or set Home
Manager's `uninstall = true;` in the configuration that still imports
steam-frame-nix and switch: its activation runs `cleanup --all` while Home
Manager removes its files. (`home-manager uninstall` alone doesn't load
steam-frame-nix's modules, so it can't clean up after them.)
