# Jellyfin hardware decoding: how it works

`jellyfin.hardwareDecoding.*` (module `jellyfin`). What it does, how to
configure it and its caveats: README,
[Jellyfin hardware decoding](../README.md#jellyfin-hardware-decoding-jellyfinhardwaredecoding).

## Why mpv doesn't use the decoder

The Frame's hardware decoder is a V4L2 memory-to-memory device
(`qcom-iris`, `/dev/video*`), which

- the Flatpak can't open: its `devices=dri` covers only the GPU, and Flatpak
  has nothing between that and `devices=all`;
- mpv never tries: Jellyfin hard-sets `hwdec=auto-copy`, and mpv's `auto`
  probing leaves out V4L2 M2M on purpose (its quality varies by SoC).
  Jellyfin has no way to pass mpv options.

## The shim

An `LD_PRELOAD` shim (`modules/jellyfin/mpv-hwdec-shim.c`, a few libmpv
wrappers, only libc) rewrites an `hwdec` value starting with `auto` (set
through libmpv's `mpv_set_*` functions) to `$SFN_MPV_HWDEC` (the `hwdec`
option); explicit values such as `no` stay. It is preloaded from the Nix
store; only its store path is exposed (read-only) to the sandbox. It would
work for any libmpv app that sets `hwdec=auto*`, but only Jellyfin Desktop
is set up here.

## The desktop entry

Nothing is written to Flatpak's overrides: a desktop entry shadowing the
Flatpak's (`~/.local/share/applications/org.jellyfin.JellyfinDesktop.desktop`,
same ID, so the KDE menu and the "+" menu start it) passes device access and
the shim as `flatpak run` options, so they apply to launches from that entry
and are gone with it:

```sh
flatpak run --branch=stable --arch=aarch64 --command=jellyfin-desktop \
  --device=all --filesystem=<shim>:ro \
  --env=LD_PRELOAD=<shim>/lib/mpv-hwdec-shim.so \
  --env=SFN_MPV_HWDEC=v4l2m2m-copy,auto-copy org.jellyfin.JellyfinDesktop
```

(The exact line with the store path is the read-only option
`steamFrame.jellyfin.hardwareDecoding.command`.)

Older versions used a Flatpak override (via nix-flatpak or a Home Manager
link) and a shim copy in `~/.var/app/org.jellyfin.JellyfinDesktop`;
`steam-frame-nix-cleanup` removes their entries from the override and the
copy.
