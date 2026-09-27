# Keyboard layout for the Steam session: gamescope uses xkbcommon defaults (US)
# unless XKB_DEFAULT_* is set; KDE's setting only covers the nested desktop.
# environment.d isn't read on the Frame, so it goes on gamescope-session.service
# (next session start).
{ config, lib, ... }:
let
  cfg = config.steamFrame;
in {
  options.steamFrame = {
    keyboardLayout = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "de";
      description = ''
        XKB layout for the Steam session (XKB_DEFAULT_LAYOUT); null = US.
      '';
    };
    keyboardVariant = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "nodeadkeys";
      description = "XKB variant for the Steam session (XKB_DEFAULT_VARIANT).";
    };
  };

  config = lib.mkIf (cfg.keyboardLayout != null || cfg.keyboardVariant != null) {
    xdg.configFile."systemd/user/gamescope-session.service.d/keyboard.conf".text =
      "[Service]\n"
      + lib.optionalString (cfg.keyboardLayout != null)
        "Environment=XKB_DEFAULT_LAYOUT=${cfg.keyboardLayout}\n"
      + lib.optionalString (cfg.keyboardVariant != null)
        "Environment=XKB_DEFAULT_VARIANT=${cfg.keyboardVariant}\n";
  };
}
