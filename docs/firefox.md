# Firefox

`firefox.enable`: a launcher for the Flathub Firefox Flatpak
(`org.mozilla.firefox`, stable). It shadows the Flatpak's own entry (same
ID), so default-browser associations keep working. Options:
[options.md#firefox](options.md#firefox).

## Options

- **`vrFullscreenFix`** (on): gamescope never shows fullscreen windows, so
  Firefox looks frozen. `full-screen-api.ignore-widgets` makes fullscreen
  fill just the window. Not applied in the desktop profile. **Remove when**
  gamescope shows fullscreen X11 windows in VR.
- **`disableAv1`** (off): `media.av1.enabled = false`. The Frame's decoder
  driver (`iris`) has no AV1, only H.264, HEVC and VP9, so YouTube and co.
  send VP9/H.264, decoded in hardware, instead of software AV1. **Remove
  when** a SteamOS kernel adds AV1 to `iris`.
- **`prefs`:** further `about:config` values for every profile; they can
  also override the fixes above.
- **`desktopProfile`** (`"desktop"`): the sessions can't see each other's
  Firefox, so a second instance stops at the locked profile; in the nested
  desktop the launcher uses this separate profile (a normal Firefox profile
  with its own browser data, created on first use). `null`: the default
  profile in both sessions.

Changes take effect at the next start of Firefox.

## How it works

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

The desktop profile undoes the fullscreen fix only while its Firefox runs:
the launcher links the profile's `user.js` to
`/app/etc/firefox/steam-frame-nix-desktop-user.js` (a sandbox path) right
before starting Firefox, waits for it, and once it has exited and the
profile is no longer in use removes the link and the value Firefox stored
from it in `prefs.js`. A second launch that just hands a URL to the running
Firefox leaves both in place. A `user.js` of your own is never touched (the
fix then stays on in that profile). After a crash, the next launch or
`steam-frame-nix-cleanup` (on switch) removes them.

Older versions linked or copied a `user.js` into every profile; those and
the values they left in `prefs.js` are removed by `steam-frame-nix-cleanup`
on switch, for each profile not in use at that moment.
