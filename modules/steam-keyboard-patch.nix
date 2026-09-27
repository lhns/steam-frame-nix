# Steam's VR keyboard can only send text (ControllerKeyboardSetKeyState throws
# "Unknown method" in VR), and its layouts are hardcoded.
# - patch.js (injected over CEF DevTools, 127.0.0.1:8080) adds a bottom row
#   Esc Ctrl Alt [space] AltGr ← ↑ ↓ → (AltGr+arrows = Pos1/PgUp/PgDn/End) and
#   hands chords, Shift+arrows and characters Steam would turn into "1"
#   (non-ASCII, AltGr/dead keys) to the helper.
# - helper.mjs keeps it injected, sends those keys with xdotool on :0 (an
#   allowlist: no ASCII text, no Enter) and unpatches on stop.
# Tested with Steam client 1790377368 (UI build 11041156).
{ config, pkgs, lib, ... }:
let
  patch = (import ./lib { inherit pkgs; }).mkPatch {
    name = "steam-keyboard-patch";
    src = ./steam-keyboard-patch/patch.js;
  };
in {
  imports = [ ./session.nix ];

  options.steamFrame.steamKeyboardPatch.enable = lib.mkEnableOption ''
    Esc/Ctrl/Alt, arrow keys, Ctrl/Alt chords (held while toggled) and
    AltGr/non-ASCII characters on Steam's VR keyboard (runtime patch plus an
    xdotool helper service); off reverts it on the next switch'';

  config = lib.mkMerge [
  (lib.mkIf config.steamFrame.steamKeyboardPatch.enable {
    systemd.user.services.steam-keyboard-patch = {
      Unit.Description = "Modifier keys for Steam's VR keyboard (CEF patch + xdotool)";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${./steam-keyboard-patch/helper.mjs}"
          "${patch}"
          "${./steam-keyboard-patch/unpatch.js}"
          "${pkgs.xdotool}/bin/xdotool"
        ];
        Restart = "always";
        RestartSec = 5;
        TimeoutStopSec = 5;   # the helper unpatches Steam's UI on SIGTERM
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on switch to re-inject a changed patch.
    steamFrame.userServices.restart = [ "steam-keyboard-patch.service" ];
  })
  # Disabled: stopping the helper reverts the patch right away.
  (lib.mkIf (!config.steamFrame.steamKeyboardPatch.enable) {
    steamFrame.userServices.stop = [ "steam-keyboard-patch.service" ];
  })
  ];
}
