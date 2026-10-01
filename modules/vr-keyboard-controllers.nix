# The controller bridge for VR keyboard features (internal option
# steamFrame.keyboard.vr.controllers.enable, set by the features using it,
# keyboard.vr.touchTyping and keyboard.vr.swipe.twoHanded): both controllers
# relative to Steam's VR keyboard, from SteamVR's dashboard to Steam's UI.
# - vr-keyboard-controllers/bridge-patch.js (SteamVR systemui, 8087; patch
#   "vr-keyboard-controllers"): the keyboard's pose, per hand the tip (where
#   the laser starts), the laser's hit and the trigger (geometry.js), ~90 Hz
#   near the keyboard or asked for (demand), slower with distance
#   (`continuous`, set by touch typing), else only on demand; CDP binding
#   __sfuiCtlOut.
# - vr-keyboard-controllers/relay.mjs (user service
#   vr-keyboard-controllers-relay): to Steam's SharedJSContext; demand back
#   (CDP binding __sfuiCtlIn there).
# - vr-keyboard-controllers/hub.js: window.__sfuiControllers there (page px,
#   subscribe, demand); consumer patches take it as an extraArg.
# Tests: vr-keyboard-controllers/check.nix (flake check
# `vr-keyboard-controllers`).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.keyboard.vr.controllers;
  uiLib = import ./steam-ui-patches/lib { inherit pkgs; };
  checks = import ./vr-keyboard-controllers/check.nix { inherit pkgs; };
in {
  imports = [ ./session.nix ./steam-ui-patches.nix ];

  options.steamFrame.keyboard.vr.controllers = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      internal = true;
      description = "The controller bridge (set by the VR keyboard features that use it).";
    };
    continuous = lib.mkOption {
      type = lib.types.bool;
      default = false;
      internal = true;
      description = "Sample the controllers all the time the keyboard is shown (touch typing), not only on demand (the two-handed swipe).";
    };
    files = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      readOnly = true;
      internal = true;
      default = { geometry = ./vr-keyboard-controllers/geometry.js; hub = ./vr-keyboard-controllers/hub.js; };
      description = "geometry.js and hub.js, for consumer patches' extraArgs.";
    };
  };

  config = lib.mkMerge [
    {
      steamFrame.uiPatches.patches = lib.optional cfg.enable {
        name = "vr-keyboard-controllers";
        endpoint = "http://127.0.0.1:8087";
        target.title = "systemui";
        patch = pkgs.runCommand "vr-keyboard-controllers.js" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          : ${checks}
          cp ${uiLib.mkPatch {
            name = "vr-keyboard-controllers";
            src = ./vr-keyboard-controllers/bridge-patch.js;
            opts = { inherit (cfg) continuous; };
            extraArgs = [ ./vr-keyboard-controllers/geometry.js ];
          }} $out
          node --check $out
        '';
        unpatch = ./vr-keyboard-controllers/unpatch.js;
      };
      steamFrame.session.services.${if cfg.enable then "restart" else "stop"} = [ "vr-keyboard-controllers-relay.service" ];
    }
    (lib.mkIf cfg.enable {
      systemd.user.services.vr-keyboard-controllers-relay = {
        Unit.Description = "Relay of the VR keyboard's controller frames (SteamVR dashboard -> Steam UI)";
        Service = { ExecStart = "${pkgs.nodejs}/bin/node ${./vr-keyboard-controllers/relay.mjs}"; Restart = "always"; RestartSec = 5; };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
