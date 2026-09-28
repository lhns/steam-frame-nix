# Firefox: how it works

`firefox.*` (module `firefox`). What it does and how to configure it:
README, [Firefox](../README.md#firefox-firefox).

## Default prefs

`prefs` and the fixes are *default* values (`pref()`), not user values:
`about:config` can still change them per profile, and nothing is written to
`prefs.js`, so removing one leaves nothing behind. Firefox reads default
prefs from `defaults/pref/*.js` in its system config dir, which in the
Flatpak is `/app/etc/firefox`, the mount point of the
`org.mozilla.firefox.systemconfig` extension. home-manager provides that
extension as a link from
`~/.local/share/flatpak/extension/org.mozilla.firefox.systemconfig/aarch64/stable`
to a store directory; Flatpak mounts it itself, so the sandbox doesn't get
`/nix`. (A systemconfig extension of your own would conflict with it.)

## Desktop profile

The launcher (a desktop entry with the Flatpak's ID, shadowing its entry)
picks `desktopProfile` when started in the nested desktop. The desktop
profile undoes the fullscreen fix only while its Firefox runs: the launcher
links the profile's `user.js` to
`/app/etc/firefox/steam-frame-nix-desktop-user.js` (a sandbox path) right
before starting Firefox, waits for it, and once it has exited and the
profile is no longer in use removes the link and the value Firefox stored
from it in `prefs.js`. A second launch that just hands a URL to the running
Firefox leaves both in place. A `user.js` of your own is never touched (the
fix then stays on in that profile). After a crash, the next launch or
`steam-frame-nix-cleanup` (on switch) removes them.

## Older versions

Older versions linked or copied a `user.js` into every profile; those and
the values they left in `prefs.js` are removed by `steam-frame-nix-cleanup`
on switch, for each profile not in use at that moment.
