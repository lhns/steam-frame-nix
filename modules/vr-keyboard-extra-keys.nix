# steamFrame.keyboard.vr.extraKeys (user service steam-keyboard-patch; patch
# name "steam-keyboard-patch" in logs and signatures.json).
# Steam's VR keyboard can only send text (ControllerKeyboardSetKeyState throws
# "Unknown method" in VR), and its layouts are hardcoded.
# - patch.js (injected over CEF DevTools, 127.0.0.1:8080) adds a bottom row
#   Esc Ctrl Alt [space] AltGr ← ↑ ↓ → (AltGr+arrows = Pos1/PgUp/PgDn/End) and
#   hands chords, Shift+arrows and characters Steam would turn into "1"
#   (non-ASCII, AltGr/dead keys) to the helper. AltGr + the key left of
#   Backspace = Delete.
# - xdotool-helper.mjs keeps it injected (its own injector, not the
#   steam-ui-patches service), sends those keys with xdotool on :0 (an
#   allowlist: no ASCII text, no Enter) and unpatches on stop.
# Tested with Steam client 1790377368 (UI build 11041156).
{ config, pkgs, lib, ... }:
let
  patch = (import ./steam-ui-patches/lib { inherit pkgs; }).mkPatch {
    name = "steam-keyboard-patch";
    src = ./vr-keyboard-extra-keys/patch.js;
  };
  cfg = config.steamFrame.keyboard.vr.extraKeys;
in {
  imports = [
    ./session.nix ./cleanup.nix
    (lib.mkRenamedOptionModule
      [ "steamFrame" "steamKeyboardPatch" "enable" ]
      [ "steamFrame" "keyboard" "vr" "extraKeys" "enable" ])
  ];

  options.steamFrame.keyboard.vr.extraKeys.enable = lib.mkEnableOption ''
    Esc/Ctrl/Alt, arrow keys, Ctrl/Alt chords (held while toggled) and
    AltGr/non-ASCII characters on Steam's VR keyboard (Steam UI patch plus an
    xdotool helper service); off reverts it on the next switch'';

  config = lib.mkMerge [
  (lib.mkIf cfg.enable {
    systemd.user.services.steam-keyboard-patch = {
      Unit.Description = "Modifier keys for Steam's VR keyboard (CEF patch + xdotool)";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${./vr-keyboard-extra-keys/xdotool-helper.mjs}"
          "${patch}"
          "${./vr-keyboard-extra-keys/unpatch.js}"
          "${pkgs.xdotool}/bin/xdotool"
        ];
        Restart = "always";
        RestartSec = 5;
        TimeoutStopSec = 5;   # the helper unpatches Steam's UI on SIGTERM
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on switch to re-inject a changed patch.
    steamFrame.session.services.restart = [ "steam-keyboard-patch.service" ];
  })
  # Disabled: stopping the helper reverts the patch right away.
  (lib.mkIf (!cfg.enable) {
    steamFrame.session.services.stop = [ "steam-keyboard-patch.service" ];
  })
  ];
}
