# Keyboard layout for the Steam session: gamescope uses xkbcommon defaults (US)
# unless XKB_DEFAULT_* is set; KDE's setting only covers the nested desktop.
# environment.d isn't read on the Frame, so it goes on gamescope-session.service
# (next session start).
{ config, lib, ... }:
let
  cfg = config.steamFrame.keyboard;
in {
  imports = [
    ./cleanup.nix
    (lib.mkRenamedOptionModule [ "steamFrame" "keyboardLayout" ] [ "steamFrame" "keyboard" "layout" ])
    (lib.mkRenamedOptionModule [ "steamFrame" "keyboardVariant" ] [ "steamFrame" "keyboard" "variant" ])
  ];

  options.steamFrame.keyboard = {
    layout = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "de";
      description = ''
        XKB layout for the Steam session (XKB_DEFAULT_LAYOUT); null = US.
      '';
    };
    variant = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "nodeadkeys";
      description = "XKB variant for the Steam session (XKB_DEFAULT_VARIANT).";
    };
  };

  config = lib.mkIf (cfg.layout != null || cfg.variant != null) {
    xdg.configFile."systemd/user/gamescope-session.service.d/keyboard.conf".text =
      "[Service]\n"
      + lib.optionalString (cfg.layout != null)
        "Environment=XKB_DEFAULT_LAYOUT=${cfg.layout}\n"
      + lib.optionalString (cfg.variant != null)
        "Environment=XKB_DEFAULT_VARIANT=${cfg.variant}\n";
  };
}
