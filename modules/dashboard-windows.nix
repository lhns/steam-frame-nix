# Resize and grab-distance limits of SteamVR dashboard windows (Steam, app
# windows, overlays, the theater screen, the dashboard itself), through a
# runtime patch of SteamVR's dashboard page (vrwebhelper "systemui", DevTools
# 127.0.0.1:8087; see dashboard-windows/patch.js for how it works). It is
# registered with steam-ui-patches.nix only when an option is set, and turns
# on the SteamVR web helper debugger (steamvr-debugger.nix), which needs one
# SteamVR restart the first time. Changes apply immediately (the dashboard
# resends its scene graph); unsetting all options reverts to stock.
# Depends on SteamVR UI internals, found by signature (lib/signatures.json,
# "dashboard-windows"; scripts/check-signatures.mjs checks them offline).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard;
  inherit (lib) mkOption types;
  inherit (import ./lib { inherit pkgs; }) mkPatch;

  # Stock grab distance ranges (meters), matched by the patch.
  stockDistance = {
    world = { min = 0.25; max = 5; };
    theater = { min = 1; max = 6; };
    dashboard = { min = 0.3; max = 4; };
  };

  rangeOption = kind: what: {
    min = mkOption {
      type = types.nullOr types.number;
      default = null;
      description = ''
        Closest distance in meters ${what} can be pulled in to while grabbed.
        null = stock (${toString stockDistance.${kind}.min} m).
      '';
    };
    max = mkOption {
      type = types.nullOr types.number;
      default = null;
      example = stockDistance.${kind}.max * 2;
      description = ''
        Farthest distance in meters ${what} can be pushed back to while
        grabbed. null = stock (${toString stockDistance.${kind}.max} m).
      '';
    };
  };

  effective = kind: {
    min = if cfg.windowDistance.${kind}.min != null then cfg.windowDistance.${kind}.min else stockDistance.${kind}.min;
    max = if cfg.windowDistance.${kind}.max != null then cfg.windowDistance.${kind}.max else stockDistance.${kind}.max;
  };

  distanceSet = lib.any (r: r.min != null || r.max != null) (lib.attrValues cfg.windowDistance);
  enabled = cfg.windowMaxScale != null || distanceSet;
in {
  imports = [ ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard = {
    windowMaxScale = mkOption {
      type = types.nullOr types.number;
      default = null;
      example = 4.0;
      description = ''
        Largest size, relative to their default size, that SteamVR dashboard
        windows (Steam, app windows, overlays, the theater screen) can be
        enlarged to with the resize handle. null = stock (2; the smallest is
        0.25). The theater screen's default size is 2.8x that of a normal
        window, so its limit is 2.8x this value. Runtime patch of the SteamVR
        dashboard (steamFrame.uiPatches), applied immediately.
      '';
    };
    windowDistance = {
      world = rangeOption "world" "windows placed in the world (not attached to the dashboard)";
      theater = rangeOption "theater" "the theater-mode screen";
      dashboard = rangeOption "dashboard" "the dashboard itself";
    };
  };

  config = lib.mkIf enabled {
    assertions =
      [ {
        assertion = cfg.windowMaxScale == null || cfg.windowMaxScale > 0;
        message = "steamFrame.dashboard.windowMaxScale must be positive.";
      } ]
      ++ map (kind: let r = effective kind; in {
        assertion = r.min > 0 && r.max >= r.min;
        message = "steamFrame.dashboard.windowDistance.${kind}: need 0 < min <= max (stock values fill in unset ones), got ${toString r.min}-${toString r.max}.";
      }) (lib.attrNames stockDistance);

    steamFrame.uiPatches.patches = [ {
      name = "dashboard-windows";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "dashboard-windows";
        src = ./dashboard-windows/patch.js;
        opts = {
          maxScale = cfg.windowMaxScale;
          distance = cfg.windowDistance;
        };
      };
      unpatch = ./dashboard-windows/unpatch.js;
    } ];
  };
}
