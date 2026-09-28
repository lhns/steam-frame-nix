# Keyring launchers

`keyring.flatpaks.<app ID>`, `keyring.programs.<desktop ID>`, module
`keyring`. Options: [README, Options](../README.md#options).

## Problem

Apps that keep logins or passwords in the KDE wallet lose them between the
Frame's [two sessions](../README.md#two-sessions):

- **A second wallet:** the nested desktop has its own D-Bus. An app started
  there starts a second `kwalletd6` on that bus; what it stores there is
  invisible to the same app in the Steam session, which talks to the running
  `kwalletd6` on the outer bus.
- **Electron in the Steam session:** Electron picks its keyring from
  `XDG_CURRENT_DESKTOP`. In the Steam session that is `gamescope`, which it
  doesn't know, so it falls back to `basic` (a local, unencrypted store) and
  the login made in the desktop (stored in the wallet) is gone.
- **Flatpak permissions:** many Flatpaks may not talk to the wallet at all
  (Element), or only to `org.kde.kwalletd6` while their KF6 wallet client
  reads through the Secret Service `org.freedesktop.secrets` (KRDC: "Password
  not found").
- **Login callbacks:** SSO logins come back through a URL scheme
  (`io.element.desktop://`, `claude://`) opened by the portal. Unless the app
  is the default and a recommended handler, the portal opens an app chooser,
  which isn't shown in VR.

## What you get

For each listed app, a desktop entry in `~/.local/share/applications` with
the app's own desktop ID, so it replaces the Flatpak's or package's entry in
the KDE menu and the "+" menu. It starts the app

- on the outer bus (`session.busEnv`): one `kwalletd6` for both sessions;
- for Flatpaks, with `--talk-name=org.kde.kwalletd6` and
  `--talk-name=org.freedesktop.secrets` as `flatpak run` options (not a
  Flatpak override: they apply only to launches from this entry and are
  gone with it);
- with `electron = true`, with `--password-store=kwallet6`;
- as the default and recommended handler of its `schemeHandlers`
  (`xdg.mimeApps`).

Logins then survive switching between the desktop and VR windows. Changes
take effect at the next start of the app.

## Configuration

The Flatpak isn't in the Nix store, so its entry can't be read at build
time: give the fields you want in menus (`name` is required; `icon`
defaults to the app ID, as Flatpaks export it). A Flatpak (installing it is
up to you):

```nix
steamFrame.keyring.flatpaks = {
  "im.riot.Riot" = {
    name = "Element";
    electron = true;
    categories = [ "Network" "InstantMessaging" ];
    schemeHandlers = [ "element" "io.element.desktop" ];  # SSO callback
  };
  "org.kde.krdc" = {
    name = "KRDC";
    fieldCode = "%u";
    categories = [ "Qt" "KDE" "Network" "RemoteAccess" ];
    mimeTypes = [ "x-scheme-handler/vnc" "x-scheme-handler/rdp" ];  # listed, not made default
  };
};
```

A program from a Nix package: use the package's own desktop ID (without
`.desktop`), so the entry replaces the package's:

```nix
{ pkgs, ... }: {
  home.packages = [ pkgs.claude-desktop ];
  steamFrame.keyring.programs."com.anthropic.Claude" = {
    name = "Claude";
    executable = "${pkgs.claude-desktop}/bin/claude-desktop";
    icon = "claude-desktop";
    electron = true;
    startupWMClass = "com.anthropic.Claude";
    schemeHandlers = [ "claude" ];  # login callback
    settings.StartupNotify = "true";
    actions.NewChat = {
      name = "New Chat";
      args = [ ''"claude://claude.ai/new?surface=chat&source=desktop_action"'' ];
    };
  };
}
```

`args`, `actions.<name>.args` and `settings` are written into the entry as
given (desktop entry syntax: quote yourself). Each app's `command` (read
only) is its command line without arguments, to start it from a terminal
the same way. The fields each entry takes are in the
[options](../README.md#options).

## Caveats

- The wallet must be KDE's (`kwalletd6`, and `ksecretd` for the Secret
  Service), as SteamOS ships it.
- Only launches from the entry get the fixes: a Flatpak started with plain
  `flatpak run`, or a program from `~/.nix-profile/bin`, doesn't.
- `schemeHandlers` turns on Home Manager's `xdg.mimeApps`, which then owns
  `~/.config/mimeapps.list`: set other defaults there too.
- A Flatpak's own entry may have fields not given here (translations,
  `Keywords`, actions); add what you need through `settings` and `actions`.

## How it works

For `"im.riot.Riot" = { name = "Element"; electron = true; ... }` the entry's
command line is

```sh
env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  flatpak run --talk-name=org.kde.kwalletd6 --talk-name=org.freedesktop.secrets \
  im.riot.Riot --password-store=kwallet6 %U
```

`flatpak run` connects the sandbox's D-Bus proxy to the bus in its own
environment, so the prefix (not `--env=`) moves the app to the outer bus.
`--talk-name` adds to the Flatpak's permissions for this launch only. The
entry also sets `X-Flatpak=<app ID>`. For `programs` the prefix runs
`executable` directly.

`schemeHandlers` go into `xdg.mimeApps.defaultApplications` and
`associations.added` (Added Associations, what the portal treats as
recommended), and into the entry's `MimeType=` with `mimeTypes`.
