# Launchers

`launchers.<desktop ID>`, module `launchers`. Options:
[README, Options](../README.md#options).

## Problem

Starting an app the way the Frame needs often means changing its desktop
entry: extra `flatpak run` options, environment, a wrapper script, making it
a default handler. A hand-written entry with the same ID replaces the
original, but loses what the original has (translations, icon, actions,
MIME types) and goes stale when the app changes its entry in an update.

The most common case is the KDE wallet, where apps lose their logins between
the Frame's [two sessions](../README.md#two-sessions):

- **A second wallet:** the nested desktop has its own D-Bus. An app started
  there starts a second `kwalletd6` on that bus; what it stores there is
  invisible to the same app in the Steam session, which talks to the running
  `kwalletd6` on the outer bus.
- **Electron in the Steam session:** Electron picks its keyring from
  `XDG_CURRENT_DESKTOP`. In the Steam session that is `gamescope`, which it
  doesn't know, so it falls back to `basic` (a local, unencrypted store) and
  the login made in the desktop (stored in the wallet) is gone.
- **Flatpak permissions:** many Flatpaks may not talk to the wallet at all,
  or only to `org.kde.kwalletd6` while their KF6 wallet client reads through
  the Secret Service `org.freedesktop.secrets` (the app finds no password).
- **Login callbacks:** logins come back through a URL scheme (e.g.
  `signalcaptcha://`) opened by the portal. Unless the app
  is the default and a recommended handler, the portal opens an app chooser,
  which isn't shown in VR.

## What you get

For each `launchers.<desktop ID>`, the app's own desktop entry, rewritten,
under the same ID in `~/.local/share/applications`: it replaces the original
in the KDE menu and the "+" menu (which reads only that directory). Name,
icon, translations, categories, actions and MIME types stay the app's; only
the command lines (the entry's and every action's) and the keys you set
change. When a Flatpak update changes its entry, the launcher follows within
seconds.

- **`keyring.enable`:** the app runs on the outer bus (one `kwalletd6` for
  both sessions); a Flatpak may also talk to the wallet
  (`--talk-name=org.kde.kwalletd6 --talk-name=org.freedesktop.secrets`).
  **`keyring.electron`** adds `--password-store=kwallet6`. Logins then
  survive switching between the desktop and VR windows.
- **`defaultFor`:** the app becomes the default and a recommended handler of
  these MIME types / URL schemes (login callbacks open without a chooser).
- **`flatpakArgs`, `env`, `hostEnv`, `args`, `wrappers`:** options,
  environment and wrapper commands for the launch; Flatpak permissions this
  way apply only to launches from the entry (no Flatpak override files).
- **`mimeTypes`, `settings`:** further `MimeType=` entries; set, override or
  remove `[Desktop Entry]` keys.

Changes take effect at the next start of the app. [Firefox](firefox.md)
(`firefox.*`) and [Jellyfin](jellyfin.md) (`jellyfin.hardwareDecoding`) are
launchers too.

## Configuration

The desktop ID is the attribute name; the source is the Flatpak with that
app ID unless `source.package` or `source.file` is set. Installing the app
is up to you.

A Flatpak whose logins live in the wallet (Signal, an Electron app), with
its link callback schemes, and a non-Electron app:

```nix
steamFrame.launchers."org.signal.Signal" = {
  keyring = { enable = true; electron = true; };
  defaultFor = [ "x-scheme-handler/sgnl" "x-scheme-handler/signalcaptcha" ];
};
steamFrame.launchers."org.example.App".keyring.enable = true;
```

A program from a Nix package (installed by you, e.g. in `home.packages`),
from the package's own entry (`share/applications/<desktop ID>.desktop`,
rewritten at build time):

```nix
{ pkgs, ... }: {
  steamFrame.launchers.signal = {
    source.package = pkgs.signal-desktop;
    keyring = { enable = true; electron = true; };
  };
}
```

Flatpak permissions and environment for one app (what
[Jellyfin](jellyfin.md) sets):

```nix
steamFrame.launchers."org.jellyfin.JellyfinDesktop" = {
  flatpakArgs = [ "--device=all" ];
  env.SFN_MPV_HWDEC = "v4l2m2m-copy";          # --env= inside the sandbox
};
```

A wrapper, which gets the whole original command line as its arguments (how
[Firefox](firefox.md) picks its desktop profile), and keys of the entry:

```nix
{ pkgs, ... }: {
  steamFrame.launchers."org.chromium.Chromium" = {
    wrappers = [ "${pkgs.writeShellScript "no-gpu" ''exec "$@" --disable-gpu''}" ];
    settings = { Name = "Chromium (no GPU)"; Keywords = null; };  # null: removed
  };
}
```

`args`, `flatpakArgs`, `wrappers` and the environment values are plain
strings, quoted for the entry for you; `settings` values are written as
given (key-file syntax). Each launcher's `command` (read only) is roughly its
command line, to start it the same way from a terminal. A host file as
source: `source.file = "/usr/share/applications/<ID>.desktop"`.

**From `keyring.*` (until 2026-09):** `keyring.flatpaks.<ID>` and
`keyring.programs.<ID>` are gone; using them fails with the new form.
`electron = true` is `keyring = { enable = true; electron = true; }`,
`schemeHandlers = [ "x" ]` is `defaultFor = [ "x-scheme-handler/x" ]`,
`programs.<ID>.executable` becomes `source.package`; name, icon, categories,
actions and field codes come from the app's entry.

## Caveats

- Only launches from the entry get the changes: a Flatpak started with plain
  `flatpak run`, or a program from `~/.nix-profile/bin`, doesn't.
- A Flatpak's or host file's launcher exists only while its source does: an
  app not installed (or uninstalled) has none. The entry is written at
  runtime into `/run/user/1000` (tmpfs); until then, e.g. right after boot
  before the Steam session's user services started, the link in
  `~/.local/share/applications` points nowhere, and menus show neither the
  launcher nor the original entry.
- An entry whose command line isn't recognised (a Flatpak's without
  `flatpak run ... <app ID>`, a program's starting with `env -…`) is used
  unchanged, with a warning in the journal.
- Edits with KDE's "Edit Application" don't last: use `settings`. An
  edited entry is overwritten at the next rewrite; a file that replaced the
  link is reported, and Home Manager refuses the next switch until it is
  removed. Warnings go to the journal
  (`journalctl --user -u steam-frame-nix-launchers`).
- `defaultFor` turns on Home Manager's `xdg.mimeApps`, which then owns
  `~/.config/mimeapps.list`: set other defaults there too. Two launchers
  claiming the same type fail the build.
- The wallet must be KDE's (`kwalletd6`, and `ksecretd` for the Secret
  Service), as SteamOS ships it.

## How it works

The Exec lines are rewritten, everything else is copied line by line
(comments, unknown and localized keys as they are):

| Source | Exec= becomes |
|---|---|
| Flatpak | `<hostEnv> <wrappers> <original up to the app ID> <flatpakArgs> <--env=…> <app ID> <args> <rest>` |
| package, file | `<hostEnv + env> <wrappers> <original up to the program> <args> <rest>` |

For a Flatpak the app ID is the first token equal to `X-Flatpak=` (or the
source ID) after `flatpak run`; for others the program is the first token
after an optional leading `env A=B …`. The rest (`--file-forwarding`,
`@@u %U @@`, `%c`, action arguments) stays. `DBusActivatable=true` becomes
`false` (otherwise the desktop would start the app over D-Bus, skipping
Exec), `defaultFor` and `mimeTypes` are added to `MimeType=`, and
`X-SteamFrameNix-Source=` names the source. A Flatpak's entry with
`keyring = { enable = true; electron = true; }`:

```sh
env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  /usr/bin/flatpak run --branch=stable --arch=aarch64 --command=/app/bin/example-chat \
  --file-forwarding --talk-name=org.kde.kwalletd6 --talk-name=org.freedesktop.secrets \
  org.example.Chat --password-store=kwallet6 @@u %U @@
```

`flatpak run` connects the sandbox's D-Bus proxy (and portals) to the bus in
its own environment, so `hostEnv` (not `--env=`) moves the app to the outer
bus. `defaultFor` goes into `xdg.mimeApps.defaultApplications` and
`associations.added` (Added Associations, what the portal treats as
recommended).

**When it is written:** a package's entry at build time (a Home Manager link
into the store). Flatpak and host file entries can't be read at build time,
so `steam-frame-nix-launchers` (`modules/launchers/generate.sh`,
`rewrite.awk`) writes them to `/run/user/1000/steam-frame-nix/applications`
(tmpfs, `session.runtimeDir`), where the Home Manager links in
`~/.local/share/applications` point. It runs

- on every switch (Home Manager activation; skipped with a message when the
  Steam session isn't running),
- at login (`steam-frame-nix-launchers.service` of the Steam session's user
  manager),
- when Flatpak installs, updates or removes apps
  (`steam-frame-nix-launchers.path` watches `.changed` of both Flatpak
  installations and their exported `applications` directories).

Sources: `~/.local/share/flatpak/exports/share/applications/<ID>.desktop`,
then `/var/lib/flatpak/exports/share/applications/<ID>.desktop`. An entry is
replaced (temp file and rename) only when its content changes; entries of
launchers no longer configured or without a source are removed. If anything
changed, the mtime of `~/.local/share/applications` is updated, so a running
Steam rescans the "+" menu. A hash of the last written entry
(`.<ID>.desktop.sum`) shows edits by others.
