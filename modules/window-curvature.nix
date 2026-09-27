# Adjustable curvature per SteamVR dashboard window
# (steamFrame.dashboard.windowCurvature): the "Toggle Curvature" control of a
# window (row of its More Options menu, or its bottom-bar button when moved
# there) becomes a wheel (click: toggle, drag up/down: curvature, with
# controller haptics). Runtime patch of SteamVR's dashboard page (vrwebhelper
# "systemui", DevTools 127.0.0.1:8087; see window-curvature/patch.js for how
# it works), registered with steam-ui-patches.nix only when enabled; it turns
# on the SteamVR web helper debugger (steamvr-debugger.nix), which needs one
# SteamVR restart the first time. Depends on SteamVR UI internals, found by
# signature (lib/signatures.json, "window-curvature";
# scripts/check-signatures.mjs checks them offline).
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
      adjustable curvature per SteamVR dashboard window: the "Toggle
      Curvature" row of a window's More Options (three-dot) menu shows the
      window's curvature and becomes a control, and so does its button in
      the window's bottom bar when it sits there (no value shown; steps and
      snap points are felt as haptics). Click: curved → flat, flat → stock
      curve. Press and drag up/down with the laser: set the curvature
      live. Values are relative to SteamVR's stock curve (1 = stock, 2 = twice
      as curved, i.e. half the radius, 0 = flat) and kept per window until
      SteamVR restarts. Runtime patch of the SteamVR dashboard
      (steamFrame.uiPatches), applied immediately; turning it off restores the
      stock menu and radius (next switch)'';
    default = value 1.0 ''
      Curvature of windows placed in the world or on a hand that have no value
      of their own yet, once curved (stock SteamVR shows them flat; the
      toggle turns them on). Windows docked in the dashboard or in the theater
      start at 1 (stock), so the docked Steam window stays concentric with the
      dashboard bar.
    '';
    max = value 3.0 "Largest curvature the control goes to (relative to the stock curve).";
    step = value 0.05 "Step the value is rounded to while dragging.";
    snap = value 0.15 ''
      While dragging, values within ± this distance of a snap point snap to
      it exactly; dragging on moves past. 0 = no snapping.
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
        Vertical laser travel (menu pixels) before a press on the row becomes
        a drag instead of a click.
      '';
    };
    dragPixelsPerUnit = value 60 ''
      Drag distance (menu pixels) per 1.0 of curvature. The laser's position
      stops at the menu's edge (about 190 px above the row), so 0 to `max`
      should fit into that.
    '';
    barDragPixelsPerUnit = value 30 ''
      Drag distance (bar pixels) per 1.0 of curvature on the bottom-bar
      button (when the control sits in the bar).
    '';
    barDragRoom = mkOption {
      type = types.ints.unsigned;
      default = 160;
      description = ''
        Transparent room (pixels) added above and below a window's bottom bar
        while its curvature button is dragged, so the laser stays on the bar
        panel (its position stops at the pressed panel's edge). 0 = none.
      '';
    };
    haptics = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Controller haptics while dragging: a snap at snap points, a stronger
        edge at 0 and `max`, a light tick for other steps.
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
