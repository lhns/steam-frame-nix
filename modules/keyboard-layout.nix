# Keyboard layout for the Steam session. gamescope (and its Xwayland displays
# :0/:1) uses xkbcommon defaults, i.e. US, unless XKB_DEFAULT_* is set. KDE's
# layout setting only applies to the nested desktop. systemd --user on the
# Frame does not pick up ~/.config/environment.d, so set it directly on the
# unit that launches gamescope. Takes effect the next time the Steam session
# starts.
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
        XKB layout for the Steam session (XKB_DEFAULT_LAYOUT). null leaves
        gamescope's default (US) and writes no drop-in.
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
