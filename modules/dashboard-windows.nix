# Resize and grab-distance limits of SteamVR dashboard windows. SteamVR
# dashboard patch (dashboard-windows/patch.js; "systemui" on 127.0.0.1:8087),
# registered only when an option is set; enables steamvr-debugger.nix (one
# SteamVR restart the first time). Unsetting all options reverts to stock.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.windows;
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
      type = types.nullOr types.numbers.positive;
      default = null;
      description = ''
        Closest distance (m) ${what} can be pulled in to while grabbed; null =
        stock (${toString stockDistance.${kind}.min} m).
      '';
    };
    max = mkOption {
      type = types.nullOr types.numbers.positive;
      default = null;
      example = stockDistance.${kind}.max * 2;
      description = ''
        Farthest distance (m) ${what} can be pushed back to while grabbed;
        null = stock (${toString stockDistance.${kind}.max} m).
      '';
    };
  };

  effective = kind: {
    min = if cfg.distance.${kind}.min != null then cfg.distance.${kind}.min else stockDistance.${kind}.min;
    max = if cfg.distance.${kind}.max != null then cfg.distance.${kind}.max else stockDistance.${kind}.max;
  };

  distanceSet = lib.any (r: r.min != null || r.max != null) (lib.attrValues cfg.distance);
  enabled = cfg.maxScale != null || distanceSet;

  old = [ "steamFrame" "dashboard" ];
  new = [ "steamFrame" "dashboard" "windows" ];
in {
  imports = [
    ./steam-ui-patches.nix ./steamvr-debugger.nix
    (lib.mkRenamedOptionModule (old ++ [ "windowMaxScale" ]) (new ++ [ "maxScale" ]))
  ] ++ lib.concatMap (kind: map (bound:
    lib.mkRenamedOptionModule
      (old ++ [ "windowDistance" kind bound ]) (new ++ [ "distance" kind bound ]))
    [ "min" "max" ]) (lib.attrNames stockDistance);

  options.steamFrame.dashboard.windows = {
    maxScale = mkOption {
      type = types.nullOr types.numbers.positive;
      default = null;
      example = 4.0;
      description = ''
        Largest resize factor of SteamVR dashboard windows, relative to their
        default size; null = stock (2). The theater screen starts 2.8x larger,
        so its limit is 2.8x this. SteamVR dashboard patch, applied
        immediately.
      '';
    };
    distance = {
      world = rangeOption "world"
        "windows placed in the world (not attached to the dashboard)";
      theater = rangeOption "theater" "the theater-mode screen";
      dashboard = rangeOption "dashboard" "the dashboard itself";
    };
  };

  config = lib.mkIf enabled {
    assertions = map (kind: let r = effective kind; in {
      assertion = r.max >= r.min;
      message = "steamFrame.dashboard.windows.distance.${kind}: need min <= max (stock values fill in unset ones), got ${toString r.min}-${toString r.max}.";
    }) (lib.attrNames stockDistance);

    steamFrame.uiPatches.patches = [ {
      name = "dashboard-windows";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "dashboard-windows";
        src = ./dashboard-windows/patch.js;
        opts = { inherit (cfg) maxScale distance; };
      };
      unpatch = ./dashboard-windows/unpatch.js;
    } ];
  };
}
