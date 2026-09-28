# Move window controls between a dashboard window's bottom bar and its
# three-dot menu (long press). SteamVR dashboard patch
# (frame-controls/patch.js; "systemui" on 127.0.0.1:8087), registered only
# when enabled; enables steamvr-debugger.nix (one SteamVR restart the first
# time).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.frameControls;
  inherit (lib) mkOption types;
  inherit (import ./steam-ui-patches/lib { inherit pkgs; }) mkPatch;

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
  imports = [ ./cleanup.nix ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.frameControls = {
    enable = lib.mkEnableOption ''
      moving SteamVR dashboard window controls between the bottom bar and the
      three-dot menu: long press an icon or menu row for a "Show in bar"
      popup. Applies to that control in all windows, kept across SteamVR
      restarts and reboots (in
      ~/.local/state/steam-frame-nix/ui-patches/frame-controls.json).
      SteamVR dashboard patch; off restores stock (next switch)'';
    longPressMs = mkOption {
      type = types.ints.between 300 10000;
      default = 1500;
      description = ''
        Long-press time (ms) to open the popup. A progress ring appears after
        half of it (at most 1 s), so ordinary clicks show nothing.
      '';
    };
    inBar = controlList ''
      Controls that start in the bar (default: SteamVR's placement):
      ${lib.concatStringsSep ", " names}, or "icon:<n>" (see
      window.__sfuiFrameControls.dump() in the dashboard's DevTools). A popup
      choice wins until the control's entry here changes.
    '';
    inMenu = controlList ''
      Controls that start in the three-dot menu (same names as inBar).
    '';
    floatInTheater = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Give theater windows the "Float" control too (stock: dashboard-docked
        windows only). Follows Float's placement.
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
      state = true;                 # popup placements, kept across restarts
    } ];
  };
}
