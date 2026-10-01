# Touch typing on Steam's VR keyboard (steamFrame.keyboard.vr.touchTyping): a
# key is pressed when a controller's tip (where SteamVR's laser starts)
# passes through it. Independent of keyboard.vr.enable / extraKeys.
# - The tips relative to the keyboard come from the controller bridge
#   (vr-keyboard-controllers.nix, turned on here, sampling continuously).
# - vr-keyboard-touch/keyboard-patch.js (Steam UI, 8080; patch
#   "vr-keyboard-touch"): tracker.js per hand (contact, hysteresis); presses
#   the key with the keyboard's own touch handlers, like a laser press.
# Tests: vr-keyboard-touch/check.nix (built before the patch; also flake
# check `vr-keyboard-touch`).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.keyboard.vr.touchTyping;
  uiLib = import ./steam-ui-patches/lib { inherit pkgs; };
  checks = import ./vr-keyboard-touch/check.nix { inherit pkgs; };
  ctl = config.steamFrame.keyboard.vr.controllers.files;
in {
  imports = [ ./steam-ui-patches.nix ./vr-keyboard-controllers.nix ];

  options.steamFrame.keyboard.vr.touchTyping = {
    enable = lib.mkEnableOption ''
      touch typing on Steam's VR keyboard: a key is pressed when a
      controller's tip (where the laser starts) touches it, with both hands;
      the lasers work as before'';
    depth = lib.mkOption {
      type = lib.types.numbers.between (-2) 5;
      default = 0;
      description = "How far behind the keyboard's surface a touch registers (cm; negative: in front).";
    };
    haptics = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "A haptic tick when a touch presses a key.";
    };
  };

  config = lib.mkIf cfg.enable {
    steamFrame.keyboard.vr.controllers.enable = true;
    steamFrame.keyboard.vr.controllers.continuous = true;
    steamFrame.uiPatches.patches = [ {
      name = "vr-keyboard-touch";
      target.title = "SharedJSContext";
      patch = pkgs.runCommand "vr-keyboard-touch.js" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
        : ${checks}
        cp ${uiLib.mkPatch {
          name = "vr-keyboard-touch";
          src = ./vr-keyboard-touch/keyboard-patch.js;
          opts = { inherit (cfg) haptics; depth = cfg.depth / 100.0; };
          extraArgs = [ ./vr-keyboard-touch/tracker.js ctl.hub ];
        }} $out
        node --check $out
      '';
      unpatch = ./vr-keyboard-touch/keyboard-unpatch.js;
    } ];
  };
}
