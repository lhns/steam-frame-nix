# Jellyfin hardware decoding

`jellyfin.hardwareDecoding.enable`, for the Flathub
[Jellyfin Desktop](https://github.com/jellyfin/jellyfin-desktop) Flatpak
(`org.jellyfin.JellyfinDesktop`), which plays video with libmpv. Options:
[options.md#jellyfin](options.md#jellyfin).

**Problem:** video is decoded in software (1080p H.264: ~40 % CPU). The
Frame's hardware decoder is a V4L2 memory-to-memory device (`qcom-iris`,
`/dev/video*`), which

- the Flatpak can't open: its `devices=dri` covers only the GPU, and Flatpak
  has nothing between that and `devices=all`;
- mpv never tries: Jellyfin hard-sets `hwdec=auto-copy`, and mpv's `auto`
  probing leaves out V4L2 M2M on purpose (its quality varies by SoC).
  Jellyfin has no way to pass mpv options.

**What it does:** device access (`devices=all`) and an `LD_PRELOAD` shim
that rewrites an `hwdec` value starting with `auto` (set through libmpv's
`mpv_set_*` functions) to `$SFN_MPV_HWDEC` (the `hwdec` option, default
`v4l2m2m-copy,auto-copy`); explicit values such as `no` stay. mpv tries the
listed decoders in order and falls back to software decoding per stream.
With the default, 1080p H.264 plays through `v4l2m2m-copy` at ~15-20 % CPU.
Changes take effect at the next start of Jellyfin.

Installing the Flatpak is up to you, e.g.
`flatpak install --user flathub org.jellyfin.JellyfinDesktop`, or with
nix-flatpak:

```nix
services.flatpak.packages = [ "org.jellyfin.JellyfinDesktop" ];
```

**Caveats:**

- `devices=all` gives the app all of `/dev` (cameras, input devices, ...),
  not just the decoder.
- V4L2 M2M decoding quality varies with drivers and codecs. Tested: 8-bit
  H.264; 10-bit HEVC is untested. mpv falls back to software only when the
  decoder fails; for streams that decode with artifacts, disable the option
  (or set `hwdec = "auto-copy"`, Jellyfin's own value).

## How it works

The shim (a few libmpv wrappers, only libc) is preloaded from the Nix store;
only its store path is exposed (read-only) to the sandbox. It would work for
any libmpv app that sets `hwdec=auto*`, but only Jellyfin Desktop is set up
here.

Nothing is written to Flatpak's overrides: a desktop entry shadowing the
Flatpak's (`~/.local/share/applications/org.jellyfin.JellyfinDesktop.desktop`,
same ID, so the KDE menu and the "+" menu start it) passes them as
`flatpak run` options, so they apply to launches from that entry and are
gone with it. From a terminal:

```sh
flatpak run --branch=stable --arch=aarch64 --command=jellyfin-desktop \
  --device=all --filesystem=<shim>:ro \
  --env=LD_PRELOAD=<shim>/lib/mpv-hwdec-shim.so \
  --env=SFN_MPV_HWDEC=v4l2m2m-copy,auto-copy org.jellyfin.JellyfinDesktop
```

The exact line with the store path: `grep ^Exec=
~/.local/share/applications/org.jellyfin.JellyfinDesktop.desktop`, or the
read-only option `steamFrame.jellyfin.hardwareDecoding.command`. In its
output: `mpv-hwdec-shim: hwdec "auto-copy" -> "v4l2m2m-copy,auto-copy"`,
then mpv's `Using hardware decoding (v4l2m2m-copy)`.

Older versions used a Flatpak override (via nix-flatpak or a Home Manager
link); `steam-frame-nix-cleanup` removes their entries from it.
