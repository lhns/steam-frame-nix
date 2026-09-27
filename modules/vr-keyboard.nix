# Esc/Ctrl/Alt and four arrow keys on Steam's VR keyboard.
# The keyboard is part of Steam's UI (hardcoded layouts in steamui JS), and in
# VR it can only send text; SteamClient.Input.ControllerKeyboardSetKeyState
# throws "Unknown method". So:
# - vrkbd-patch.js is injected at runtime into Steam's UI through its CEF
#   DevTools port (127.0.0.1:8080; SteamOS starts Steam with
#   -cef-enable-debugging). Steam's files are untouched, so updates don't undo
#   it. It rebuilds the bottom row and, while Ctrl/Alt is active (or for Esc),
#   hands the key combo to the helper instead of typing text. It also holds
#   the real Ctrl/Alt down while the toggle is on (Ctrl+scroll), and routes
#   characters Steam's key emulation turns into "1" (non-ASCII, AltGr/dead
#   keys on the de keymap: |@{[]}\~^`äöü€…) to the helper.
# - vrkbd-helper.mjs keeps that injection alive (Steam restarts, keyboard popup
#   recreated) and presses the combos with `xdotool key` on :0, where gamescope
#   keeps X focus on the window selected in VR. It only accepts ctrl/alt
#   chords and the extra keys, so the Steam UI can't use it to type text or
#   press Enter.
# Depends on Steam UI internals; tested with Steam client 1790377368.
{ config, pkgs, lib, ... }: {
  imports = [ ./session.nix ];

  options.steamFrame.vrKeyboard.enable = lib.mkEnableOption ''
    Esc/Ctrl/Alt/AltGr and arrow keys on Steam's VR keyboard (runtime patch of
    Steam's UI through its CEF DevTools port, plus an xdotool helper service)
  '';

  config = lib.mkIf config.steamFrame.vrKeyboard.enable {
    systemd.user.services.vr-keyboard = {
      Unit.Description = "Modifier keys for Steam's VR keyboard (CEF patch + xdotool)";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${./vr-keyboard/vrkbd-helper.mjs}"
          "${./vr-keyboard/vrkbd-patch.js}"
          "${pkgs.xdotool}/bin/xdotool"
        ];
        Environment = "VRKBD_DISPLAY=:0";
        Restart = "always";
        RestartSec = 5;
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on every switch so a changed patch is re-injected (it replaces
    # the older version).
    steamFrame.userServices.restart = [ "vr-keyboard.service" ];
  };
}
