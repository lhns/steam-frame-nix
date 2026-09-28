# Hardware video decoding for the Jellyfin Desktop Flatpak
# (org.jellyfin.JellyfinDesktop; installing it is up to the user).
# The Frame's decoder is a V4L2 M2M device (qcom-iris, /dev/video*): the
# Flatpak's devices=dri doesn't expose it (nothing finer than devices=all
# exists), and Jellyfin hard-sets mpv's hwdec=auto-copy, whose probe list
# leaves out V4L2 M2M, without a way to pass mpv options. So:
# - an LD_PRELOAD shim (jellyfin/mpv-hwdec-shim.c) rewrites an "auto*" hwdec
#   to $SFN_MPV_HWDEC. Preloaded from the store: only its store path is
#   exposed (read-only) to the sandbox.
# - a desktop entry shadowing the Flatpak's (same ID, also seen by the "+"
#   menu) starts it with those permissions as `flatpak run` options
#   (--device=all, --filesystem, --env): nothing is written to Flatpak's
#   override files, so they apply only to launches from this entry and
#   disappear with it.
# Earlier versions used an override file (nix-flatpak or Home Manager);
# steam-frame-nix-cleanup removes their entries.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.jellyfin.hardwareDecoding;
  app = "org.jellyfin.JellyfinDesktop";

  shim = pkgs.callPackage ./jellyfin/shim.nix { };

  run = lib.concatStringsSep " " [
    "flatpak run --branch=stable --arch=aarch64 --command=jellyfin-desktop"
    "--device=all"
    "--filesystem=${shim}:ro"
    "--env=LD_PRELOAD=${shim}/lib/mpv-hwdec-shim.so"
    "--env=SFN_MPV_HWDEC=${cfg.hwdec}"
    app
  ];
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.jellyfin.hardwareDecoding = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Hardware video decoding (the Frame's V4L2 decoder) in the Jellyfin
        Desktop Flatpak: a desktop entry (shadowing the Flatpak's) that
        starts it with device access (devices=all) and an LD_PRELOAD shim
        that makes mpv try hwdec's value below. Only launches from that
        entry (menus, the "+" menu) get it; nothing is written to Flatpak's
        overrides. Takes effect at the next start of Jellyfin.
      '';
    };
    hwdec = lib.mkOption {
      type = lib.types.strMatching "[^[:space:]]+";
      default = "v4l2m2m-copy,auto-copy";
      example = "v4l2m2m-copy";
      description = ''
        mpv hwdec value used instead of Jellyfin's automatic one ("auto*");
        tried in order, software decoding if none handles the stream.
        Set as SFN_MPV_HWDEC in the Flatpak's environment.
      '';
    };
    command = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = run;
      defaultText = lib.literalMD "`flatpak run … org.jellyfin.JellyfinDesktop` with the options";
      description = "The command line the desktop entry runs (for a terminal).";
    };
  };

  # Fields as in the Flatpak's own entry (1.x), which has no MimeType.
  config = lib.mkIf cfg.enable {
    xdg.dataFile."applications/${app}.desktop".text = ''
      [Desktop Entry]
      Version=1.0
      Name=Jellyfin
      Comment=Desktop client for Jellyfin
      Exec=${run}
      Icon=${app}
      Terminal=false
      Type=Application
      StartupWMClass=${app}
      Categories=AudioVideo;Video;Player;TV;
      Actions=DesktopF;DesktopW;TVF;TVW
      X-Flatpak=${app}

      [Desktop Action DesktopF]
      Name=Desktop [Fullscreen]
      Exec=${run} --fullscreen --desktop

      [Desktop Action DesktopW]
      Name=Desktop [Windowed]
      Exec=${run} --windowed --desktop

      [Desktop Action TVF]
      Name=TV [Fullscreen]
      Exec=${run} --fullscreen --tv

      [Desktop Action TVW]
      Name=TV [Windowed]
      Exec=${run} --windowed --tv
    '';
  };
}
