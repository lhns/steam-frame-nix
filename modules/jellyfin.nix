# Hardware video decoding for the Jellyfin Desktop Flatpak
# (org.jellyfin.JellyfinDesktop; installing it is up to the user).
# The Frame's decoder is a V4L2 M2M device (qcom-iris, /dev/video*): the
# Flatpak's devices=dri doesn't expose it (nothing finer than devices=all
# exists), and Jellyfin hard-sets mpv's hwdec=auto-copy, whose probe list
# leaves out V4L2 M2M, without a way to pass mpv options. So:
# - an LD_PRELOAD shim (jellyfin/mpv-hwdec-shim.c) rewrites an "auto*" hwdec
#   to $SFN_MPV_HWDEC. Preloaded from the store: only its store path is
#   exposed (read-only) to the sandbox.
# - a launcher (launchers.nix: the Flatpak's own entry, same ID, also seen
#   by the "+" menu) starts it with those permissions as `flatpak run`
#   options (--device=all, --filesystem, --env): nothing is written to
#   Flatpak's override files, so they apply only to launches from the entry
#   and disappear with it.
# Earlier versions used an override file (nix-flatpak or Home Manager);
# steam-frame-nix-cleanup removes their entries.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.jellyfin.hardwareDecoding;
  app = "org.jellyfin.JellyfinDesktop";

  shim = pkgs.callPackage ./jellyfin/shim.nix { };

  launcher = {
    flatpakArgs = [ "--device=all" "--filesystem=${shim}:ro" ];
    env = {
      LD_PRELOAD = "${shim}/lib/mpv-hwdec-shim.so";
      SFN_MPV_HWDEC = cfg.hwdec;
    };
  };
  L = import ./launchers/lib.nix { inherit lib pkgs; };
in {
  imports = [ ./launchers.nix ];

  options.steamFrame.jellyfin.hardwareDecoding = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Hardware video decoding (the Frame's V4L2 decoder) in the Jellyfin
        Desktop Flatpak: a launcher (the Flatpak's entry, rewritten) that
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
      # Its launcher's, which exists only when enabled.
      default = if cfg.enable then config.steamFrame.launchers.${app}.command
        else L.command (launcher // {
          id = app; source = { flatpak = null; package = null; file = null; };
          hostEnv = { }; wrappers = [ ]; args = [ ];
        });
      defaultText = lib.literalMD "`flatpak run … org.jellyfin.JellyfinDesktop` with the options";
      description = ''
        About the command line the launcher runs (for a terminal; the same
        as `steamFrame.launchers."org.jellyfin.JellyfinDesktop".command`).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    steamFrame.launchers.${app} = launcher;
  };
}
