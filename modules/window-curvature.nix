# Adjustable curvature per dashboard window. SteamVR dashboard patch
# (window-curvature/patch.js; "systemui" on 127.0.0.1:8087), registered only
# when enabled; enables steamvr-debugger.nix (one SteamVR restart the first time).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.windowCurvature;
  inherit (lib) mkOption types;
  inherit (import ./lib { inherit pkgs; }) mkPatch;

  path = [ "steamFrame" "dashboard" "windowCurvature" ];
  rename = from: to: lib.mkRenamedOptionModule (path ++ [ from ]) (path ++ [ to ]);

  number = type: default: description: mkOption {
    inherit type default description;
  };
in {
  imports = [
    ./cleanup.nix ./steam-ui-patches.nix ./steamvr-debugger.nix
    (lib.mkRemovedOptionModule (path ++ [ "barDragRoom" ])
      "Not needed: SteamVR keeps sending the bar's coordinates past its edge during a drag.")
    (lib.mkRemovedOptionModule (path ++ [ "snap" ])
      "Snapping is a detent in drag pixels now: use steamFrame.dashboard.windowCurvature.detentPixels.")
    (rename "default" "initial")
    (rename "snapPixels" "detentPixels")
    (rename "snapPoints" "detentPoints")
    (rename "dragThreshold" "dragThresholdPixels")
  ];

  options.steamFrame.dashboard.windowCurvature = {
    enable = lib.mkEnableOption ''
      adjustable curvature per SteamVR dashboard window via its "Toggle
      Curvature" menu row (shows the value) or bar button: click toggles
      curved/flat, drag up/down sets it live. Values are relative to the stock
      curve (1 = stock, 2 = half the radius, 0 = flat), kept per window until
      SteamVR restarts. SteamVR dashboard patch; off restores stock (next
      switch)'';
    initial = number types.numbers.nonnegative 1.0 ''
      Curvature a world/hand window (stock: flat) gets when first curved.
      Dashboard and theater windows start at 1, keeping the docked Steam
      window concentric with the bar.
    '';
    max = number types.numbers.positive 3.0 ''
      Largest curvature the control goes to (relative to the stock curve).
    '';
    step = number types.numbers.positive 0.05 ''
      Step the value is rounded to while dragging.
    '';
    detentPixels = mkOption {
      type = types.ints.unsigned;
      default = 24;
      description = ''
        Width of the detent at each of `detentPoints`, in pixels of drag:
        the value holds at the point for this much travel, then continues
        from it (no values are skipped). 0 = no detent.
      '';
    };
    detentPoints = mkOption {
      type = types.listOf types.numbers.nonnegative;
      default = [ 0 1.0 ];
      description = ''
        Values with a detent while dragging (0 = flat, 1 = stock curve).
      '';
    };
    dragThresholdPixels = mkOption {
      type = types.ints.unsigned;
      default = 8;
      description = ''
        Vertical laser travel (menu px) that turns a press into a drag.
      '';
    };
    dragPixelsPerUnit = number types.numbers.positive 120 ''
      Menu pixels per 1.0 of curvature (6 px per 0.05 step). The laser stops
      at the menu's edge (~190 px above the row): with the default, 0 to 1
      fits into one drag, the full range to `max` = 3 takes two.
    '';
    barDragPixelsPerUnit = number types.numbers.positive 60 ''
      Bar pixels per 1.0 of curvature on the bottom-bar button.
    '';
    haptics = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Controller haptics while dragging (steps, detents, 0/`max` edges);
        the dashboard's own hover clicks are muted during a drag.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.step <= cfg.max;
        message = "steamFrame.dashboard.windowCurvature: need step <= max, got max ${builtins.toJSON cfg.max}, step ${builtins.toJSON cfg.step}.";
      }
      {
        assertion = cfg.initial <= cfg.max;
        message = "steamFrame.dashboard.windowCurvature.initial must be within 0 .. max (${builtins.toJSON cfg.max}), got ${builtins.toJSON cfg.initial}.";
      }
      {
        assertion = lib.all (p: p <= cfg.max) cfg.detentPoints;
        message = "steamFrame.dashboard.windowCurvature: detentPoints must be within 0 .. max (${builtins.toJSON cfg.max}).";
      }
    ];

    steamFrame.uiPatches.patches = [ {
      name = "window-curvature";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "window-curvature";
        src = ./window-curvature/patch.js;
        opts = {
          inherit (cfg) initial max step detentPixels detentPoints
            dragThresholdPixels dragPixelsPerUnit barDragPixelsPerUnit haptics;
        };
      };
      unpatch = ./window-curvature/unpatch.js;
    } ];
  };
}
