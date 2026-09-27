# Window control bar (steamFrame.dashboard.frameControls): move the control
# icons under SteamVR dashboard windows between the bottom bar and the More
# Options (three-dot) menu with a long press on the icon or menu row (a popup
# with "Show in bar"). Placement is per control type, for all windows, kept
# across SteamVR restarts; inBar / inMenu set defaults. Optionally gives
# theater windows the "Float" control back. Runtime patch of SteamVR's
# dashboard page (vrwebhelper "systemui", DevTools 127.0.0.1:8087; see
# frame-controls/patch.js for how it works), registered with
# steam-ui-patches.nix only when enabled; it turns on the SteamVR web helper
# debugger (steamvr-debugger.nix), which needs one SteamVR restart the first
# time. Depends on SteamVR UI internals, found by signature
# (lib/signatures.json, "frame-controls"; scripts/check-signatures.mjs checks
# them offline).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.frameControls;
  inherit (lib) mkOption types;
  inherit (import ./lib { inherit pkgs; }) mkPatch;

  # Control names -> SteamVR action icon enums (the patch keys controls by icon).
  names = [ "keyboard" "float" "dashboard" "theater" "dockLeft" "dockRight" "close" "curvature" ];
  controlType = types.either (types.enum names) (types.strMatching "icon:[0-9]+");
  controlList = description: mkOption {
    type = types.listOf controlType;
    default = [ ];
    example = [ "curvature" ];
    inherit description;
  };
in {
  imports = [ ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.frameControls = {
    enable = lib.mkEnableOption ''
      moving the control icons under SteamVR dashboard windows between the
      window's bottom bar and its More Options (three-dot) menu: a long press
      on a bar icon or a menu row opens a popup with "Show in bar"; the choice
      applies to that control in all windows and is kept across SteamVR
      restarts. Short presses work as usual. Runtime patch of the SteamVR
      dashboard (steamFrame.uiPatches), applied immediately; turning it off
      restores the stock controls (next switch)'';
    longPressMs = mkOption {
      type = types.ints.between 300 10000;
      default = 1500;
      description = ''
        Hold time (ms) of the long press that opens the popup. A ring around
        the icon shows the progress from half the time (at most after 1 s),
        so ordinary clicks show nothing.
      '';
    };
    inBar = controlList ''
      Controls that start in the bar (by default: SteamVR's placement).
      Names: ${lib.concatStringsSep ", " names}, or "icon:<n>" (the action's
      icon number, see window.__sfuiFrameControls.dump() in the dashboard's
      DevTools). A choice made in the popup wins until the control's entry
      here changes.
    '';
    inMenu = controlList ''
      Controls that start in the three-dot menu (same names as inBar).
    '';
    floatInTheater = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Give windows in the theater the "Float" control (SteamVR only shows it
        for windows docked in the dashboard): floats the window in the world,
        like the stock button. Follows Float's placement.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [ {
      assertion = lib.intersectLists cfg.inBar cfg.inMenu == [ ];
      message = "steamFrame.dashboard.frameControls: ${builtins.toJSON (lib.intersectLists cfg.inBar cfg.inMenu)} in both inBar and inMenu.";
    } ];

    steamFrame.uiPatches.patches = [ {
      name = "frame-controls";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "frame-controls";
        src = ./frame-controls/patch.js;
        opts = removeAttrs cfg [ "enable" ];
      };
      unpatch = ./frame-controls/unpatch.js;
    } ];
  };
}
