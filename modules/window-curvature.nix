# Adjustable curvature per dashboard window. Dashboard patch
# (window-curvature/patch.js; "systemui" on 127.0.0.1:8087), registered only
# when enabled; enables steamvr-debugger.nix (one SteamVR restart the first time).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.windowCurvature;
  inherit (lib) mkOption types;
  inherit (import ./lib { inherit pkgs; }) mkPatch;

  value = default: description: mkOption {
    type = types.number;
    inherit default description;
  };
in {
  imports = [ ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.windowCurvature = {
    enable = lib.mkEnableOption ''
      adjustable curvature per SteamVR dashboard window via its "Toggle
      Curvature" menu row (shows the value) or bar button: click toggles
      curved/flat, drag up/down sets it live. Values are relative to the stock
      curve (1 = stock, 2 = half the radius, 0 = flat), kept per window until
      SteamVR restarts. Dashboard patch; off restores stock (next switch)'';
    default = value 1.0 ''
      Curvature a world/hand window (stock: flat) gets when first curved.
      Dashboard and theater windows start at 1, keeping the docked Steam
      window concentric with the bar.
    '';
    max = value 3.0 "Largest curvature the control goes to (relative to the stock curve).";
    step = value 0.05 "Step the value is rounded to while dragging.";
    snap = value 0.15 ''
      Snap distance around snap points while dragging; 0 = no snapping.
    '';
    snapPoints = mkOption {
      type = types.listOf types.number;
      default = [ 0 1.0 ];
      description = "Values the drag snaps to (0 = flat, 1 = stock curve).";
    };
    dragThreshold = mkOption {
      type = types.ints.unsigned;
      default = 8;
      description = ''
        Vertical laser travel (menu px) that turns a press into a drag.
      '';
    };
    dragPixelsPerUnit = value 60 ''
      Menu pixels per 1.0 of curvature. The laser stops at the menu's edge
      (~190 px above the row), so 0 to `max` should fit.
    '';
    barDragPixelsPerUnit = value 30 ''
      Bar pixels per 1.0 of curvature on the bottom-bar button.
    '';
    barDragRoom = mkOption {
      type = types.ints.unsigned;
      default = 160;
      description = ''
        Transparent room (px) added above and below the bar while its button
        is dragged, so the laser stays on the panel; 0 = none.
      '';
    };
    haptics = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Controller haptics while dragging (snap points, 0/`max` edges, steps).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.max > 0 && cfg.step > 0 && cfg.step <= cfg.max;
        message = "steamFrame.dashboard.windowCurvature: need max > 0 and 0 < step <= max, got max ${builtins.toJSON cfg.max}, step ${builtins.toJSON cfg.step}.";
      }
      {
        assertion = cfg.default >= 0 && cfg.default <= cfg.max;
        message = "steamFrame.dashboard.windowCurvature.default must be within 0 .. max (${builtins.toJSON cfg.max}), got ${builtins.toJSON cfg.default}.";
      }
      {
        assertion = cfg.snap >= 0 && lib.all (p: p >= 0 && p <= cfg.max) cfg.snapPoints;
        message = "steamFrame.dashboard.windowCurvature: snap must be >= 0 and snapPoints within 0 .. max (${builtins.toJSON cfg.max}).";
      }
      {
        assertion = cfg.dragPixelsPerUnit > 0 && cfg.barDragPixelsPerUnit > 0;
        message = "steamFrame.dashboard.windowCurvature: dragPixelsPerUnit and barDragPixelsPerUnit must be positive.";
      }
    ];

    steamFrame.uiPatches.patches = [ {
      name = "window-curvature";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "window-curvature";
        src = ./window-curvature/patch.js;
        opts = removeAttrs cfg [ "enable" ];
      };
      unpatch = ./window-curvature/unpatch.js;
    } ];
  };
}
