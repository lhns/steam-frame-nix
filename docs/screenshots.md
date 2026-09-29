# SteamVR screenshots

`screenshots.*`, module `screenshots`. Options:
[README, Options](../README.md#options).

## Problem

Steam keeps VR screenshots deep in its data directory, under the Steam
account ID, where Dolphin, Gwenview and the file pickers don't look.

## What you get

`~/Pictures/SteamVR Screenshots` (`screenshots.name`), a link to Steam's
folder of SteamVR screenshots (app 250820):
`~/.local/share/Steam/userdata/<account ID>/760/remote/250820/screenshots`.
Nothing is copied; the link goes away when you turn the option off.

**Taking a screenshot:** hold the Steam button and click a trigger
(SteamVR's `TakeScreenshot` chord). Steam writes the capture as a PNG to
`/run/user/1000/Screenshot_*.png` (tmpfs, temporary), then imports it as a
1920x1080 JPG into the folder above (small copies in `thumbnails/`, listed
in `…/760/screenshots.vdf`). The JPG is the only copy that stays.

## Configuration

```nix
steamFrame.screenshots.enable = true;
# steamFrame.screenshots.steamUserId = "80511808";   # optional
```

The account ID is found at runtime: the account last logged in to Steam
(`MostRecent`, else the latest `timestamp` in
`~/.local/share/Steam/config/loginusers.vdf`), else the only folder in
`~/.local/share/Steam/userdata`; it follows when you switch accounts.
`steamUserId` (the folder name, `ls ~/.local/share/Steam/userdata`) fixes
it instead: a plain Home Manager link, no service.

## Caveats

- Steam creates the folder with the first screenshot: until then the link
  points nowhere.
- Only SteamVR's folder is linked; screenshots Steam files under another app
  are in `…/760/remote/<app ID>/screenshots`.
- Without `steamUserId`, when no account is found there is no link (the
  service warns in `journalctl --user -u steam-frame-nix-screenshots`).

## How it works

Without `steamUserId`, `~/Pictures/<name>` is a Home Manager link to
`/run/user/1000/steam-frame-nix/screenshots`, a link that the oneshot user
service `steam-frame-nix-screenshots` points to the account's folder: on
switch, at login and when `loginusers.vdf` or `userdata` changes (path
unit). Its lifetime and cleanup:
[Changes outside Nix](../README.md#changes-outside-nix-exceptions).
