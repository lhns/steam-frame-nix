# Hardware video decoding for the Jellyfin Desktop Flatpak
# (org.jellyfin.JellyfinDesktop; installing it is up to the user).
# The Frame's decoder is a V4L2 M2M device (qcom-iris, /dev/video*): the
# Flatpak's devices=dri doesn't expose it (nothing finer than devices=all
# exists), and Jellyfin hard-sets mpv's hwdec=auto-copy, whose probe list
# leaves out V4L2 M2M, without a way to pass mpv options. So:
# - an LD_PRELOAD shim (jellyfin/mpv-hwdec-shim.c) rewrites an "auto*" hwdec
#   to $SFN_MPV_HWDEC. Preloaded from the store: the override exposes just
#   its store path (read-only) to the sandbox.
# - override: devices=all, that filesystem, LD_PRELOAD, SFN_MPV_HWDEC.
#   Through nix-flatpak's services.flatpak.overrides if it is imported and
#   enabled (merged with the user's own overrides there); else home-manager
#   owns the app's override file.
{ config, options, lib, pkgs, ... }:
let
  cfg = config.steamFrame.jellyfin.hardwareDecoding;
  app = "org.jellyfin.JellyfinDesktop";

  shim = pkgs.callPackage ./jellyfin/shim.nix { };

  override = {
    Context = { devices = [ "all" ]; filesystems = [ "${shim}:ro" ]; };
    Environment = { LD_PRELOAD = "${shim}/lib/mpv-hwdec-shim.so"; SFN_MPV_HWDEC = cfg.hwdec; };
  };

  useNixFlatpak = options ? services.flatpak.overrides && config.services.flatpak.enable;

  # Flatpak's keyfile format (lists as "a;b;").
  overrideFile = pkgs.writeText "${app}-override" (lib.concatStringsSep "\n" (lib.mapAttrsToList
    (section: entries: "[${section}]\n" + lib.concatStrings (lib.mapAttrsToList (key: value:
      "${key}=${if lib.isList value then lib.concatMapStrings (v: "${v};") value else value}\n") entries))
    override));
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.jellyfin.hardwareDecoding = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Hardware video decoding (the Frame's V4L2 decoder) in the Jellyfin
        Desktop Flatpak: device access for the sandbox (devices=all) and an
        LD_PRELOAD shim that makes mpv try hwdec's value below. Without
        nix-flatpak, home-manager owns the app's Flatpak override file. Takes
        effect at the next start of Jellyfin.
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
  };

  # The shim copy of earlier versions is removed by steam-frame-nix-cleanup.
  config = lib.mkMerge [
    (lib.mkIf (cfg.enable && !useNixFlatpak) {
      # force: `flatpak override --user` replaces the link with a file.
      xdg.dataFile."flatpak/overrides/${app}" = { source = overrideFile; force = true; };
    })
    # Only if nix-flatpak is imported: the option doesn't exist otherwise.
    (lib.optionalAttrs (options ? services.flatpak.overrides) {
      services.flatpak.overrides = lib.mkIf (cfg.enable && useNixFlatpak) { ${app} = override; };
    })
  ];
}
