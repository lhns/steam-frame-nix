# Firefox

`firefox.*`, module `firefox`. Options:
[README, Options](../README.md#options).

## Problem

In the Steam session gamescope never shows fullscreen windows, so Firefox
looks frozen when a page goes fullscreen; sites send AV1, which the Frame
decodes in software; the two sessions can't see each other's Firefox,
so a second instance stops at the locked profile; and without a default
browser the portal opens links with the first installed `https` handler
(e.g. Chromium), in both sessions.

## What you get

A [launcher](launchers.md) for the Flathub Firefox Flatpak
(`org.mozilla.firefox`, stable; install it yourself): the Flatpak's own
entry with a wrapper in front, same ID, so default-browser associations
keep working.

- **`vrFullscreenFix`** (on): `full-screen-api.ignore-widgets` makes
  fullscreen fill just the window. Not applied in the desktop profile.
- **`disableAv1`** (off): `media.av1.enabled = false`. The Frame's decoder
  driver (`iris`) has no AV1, only H.264, HEVC and VP9, so YouTube and co.
  send VP9/H.264, decoded in hardware, instead of software AV1.
- **`prefs`:** further `about:config` values for every profile; they can
  also override the fixes above.
- **`desktopProfile`** (`"desktop"`): in the nested desktop the launcher
  uses this separate profile (not for "Open Profile Manager") (a normal Firefox profile with its own browser
  data, created on first use). `null`: the default profile in both sessions.
- **`defaultBrowser`** (off): the launcher becomes the default for `http`,
  `https` and `text/html` (the launcher's `defaultFor`: Home Manager's
  `xdg.mimeApps`, which then owns `~/.config/mimeapps.list`).

`prefs` and the fixes are *default* values, not user values: `about:config`
can still change them per profile, and removing one leaves nothing behind.
Changes take effect at the next start of Firefox.

## Configuration

```nix
steamFrame.firefox = {
  enable = true;
  disableAv1 = true;
  defaultBrowser = true;
  prefs."browser.startup.page" = 3;   # restore the previous session
};
```

## Caveats

- A `user.js` of your own in the desktop profile is never touched (the
  fullscreen fix then stays on there).
- A `org.mozilla.firefox.systemconfig` Flatpak extension of your own would
  conflict with the one this module provides.
- **Remove** `vrFullscreenFix` **when** gamescope shows fullscreen X11
  windows in VR, `disableAv1` **when** a SteamOS kernel adds AV1 to `iris`.

## How it works

### Default prefs

The prefs are written with `pref()`, and nothing goes to `prefs.js`.
Firefox reads default prefs from `defaults/pref/*.js` in its system config
dir, which in the Flatpak is `/app/etc/firefox`, the mount point of the
`org.mozilla.firefox.systemconfig` extension. home-manager provides that
extension as a link from
`~/.local/share/flatpak/extension/org.mozilla.firefox.systemconfig/aarch64/stable`
to a store directory; Flatpak mounts it itself, so the sandbox doesn't get
`/nix`.

### Desktop profile

The launcher's wrapper (`modules/firefox/wrapper.nix`) gets the entry's
`flatpak run …` command line and, in the nested desktop, adds `--profile
<desktopProfile>` (not to the profile manager action, `--ProfileManager`).
The desktop profile undoes the fullscreen fix only while its Firefox runs:
the wrapper links the
profile's `user.js` to `/app/etc/firefox/steam-frame-nix-desktop-user.js`
(a sandbox path) right before starting Firefox, waits for it, and once it
has exited and the profile is no longer in use removes the link and the
value Firefox stored from it in `prefs.js`. A second launch that just hands
a URL to the running Firefox leaves both in place. After a crash (or if
`prefs.js` can't be rewritten), the next launch or `steam-frame-nix-cleanup`
(on switch) removes them.

### Older versions

Older versions linked or copied a `user.js` into every profile; those and
the values they left in `prefs.js` are removed by `steam-frame-nix-cleanup`
on switch, for each profile not in use at that moment.
