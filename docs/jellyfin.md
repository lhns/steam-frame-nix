# Jellyfin hardware decoding

`jellyfin.hardwareDecoding.*`, module `jellyfin`, for the Flathub
[Jellyfin Desktop](https://github.com/jellyfin/jellyfin-desktop) Flatpak
(`org.jellyfin.JellyfinDesktop`), which plays video with libmpv. Options:
[README, Options](../README.md#options).

## Problem

Video is decoded in software (1080p H.264: ~40 % CPU). The Frame's hardware
decoder is a V4L2 memory-to-memory device (`qcom-iris`, `/dev/video*`),
which

- the Flatpak can't open: its `devices=dri` covers only the GPU, and Flatpak
  has nothing between that and `devices=all`;
- mpv never tries: Jellyfin hard-sets `hwdec=auto-copy`, and mpv's `auto`
  probing leaves out V4L2 M2M on purpose (its quality varies by SoC).
  Jellyfin has no way to pass mpv options.

## What you get

A [launcher](launchers.md) (the Flatpak's own entry, rewritten under its
ID, so the KDE menu and the "+" menu start it) runs the Flatpak with device
access (`devices=all`)
and makes mpv use `hwdec` (default `v4l2m2m-copy,auto-copy`); explicit
values such as `no` stay. mpv tries the listed decoders in order and falls
back to software decoding per stream. With the default, 1080p H.264 plays
at ~15-20 % CPU. Changes take effect at the next start of Jellyfin.

## Configuration

Installing the Flatpak is up to you, e.g.
`flatpak install --user flathub org.jellyfin.JellyfinDesktop`, or with
nix-flatpak:

```nix
services.flatpak.packages = [ "org.jellyfin.JellyfinDesktop" ];
steamFrame.jellyfin.hardwareDecoding.enable = true;
```

From a terminal, start it with the command line of
`steamFrame.jellyfin.hardwareDecoding.command` (or the one of `grep ^Exec=
~/.local/share/applications/org.jellyfin.JellyfinDesktop.desktop`); its
output shows `mpv-hwdec-shim: hwdec "auto-copy" -> "v4l2m2m-copy,auto-copy"`,
then mpv's `Using hardware decoding (v4l2m2m-copy)`.

## Caveats

- `devices=all` gives the app all of `/dev` (cameras, input devices, ...),
  not just the decoder.
- V4L2 M2M decoding quality varies with drivers and codecs. Tested: 8-bit
  H.264; 10-bit HEVC is untested. mpv falls back to software only when the
  decoder fails; for streams that decode with artifacts, disable the option
  (or set `hwdec = "auto-copy"`, Jellyfin's own value).

## How it works

### The shim

An `LD_PRELOAD` shim (`modules/jellyfin/mpv-hwdec-shim.c`, a few libmpv
wrappers, only libc) rewrites an `hwdec` value starting with `auto` (set
through libmpv's `mpv_set_*` functions) to `$SFN_MPV_HWDEC` (the `hwdec`
option). It is preloaded from the Nix store; only its store path is exposed
(read-only) to the sandbox. It would work for any libmpv app that sets
`hwdec=auto*`, but only Jellyfin Desktop is set up here.

### The launcher

Nothing is written to Flatpak's overrides: the launcher
`steamFrame.launchers."org.jellyfin.JellyfinDesktop"` passes device access
and the shim as `flatpak run` options (`flatpakArgs`, `env`), so they apply
to launches from the entry and are gone with it. Its command lines (the
entry's and the four actions') become

```sh
flatpak run --branch=stable --arch=aarch64 --command=jellyfin-desktop \
  --device=all --filesystem=<shim>:ro \
  --env=LD_PRELOAD=<shim>/lib/mpv-hwdec-shim.so \
  --env=SFN_MPV_HWDEC=v4l2m2m-copy,auto-copy org.jellyfin.JellyfinDesktop
```

(`command` is about this line, with the store path and without the
entry's `--branch`/`--arch`/`--command`.)

Older versions used a Flatpak override (via nix-flatpak or a Home Manager
link) and a shim copy in `~/.var/app/org.jellyfin.JellyfinDesktop`;
`steam-frame-nix-cleanup` removes their entries from the override and the
copy.
