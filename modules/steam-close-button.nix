# Close (X) button on the SteamVR dashboard's main Steam window
# (steamFrame.dashboard.steamCloseButton.enable): it switches to the
# previously active dashboard window, or leaves just the dashboard bar when
# Steam was the last one. Runtime patch of SteamVR's dashboard page
# (vrwebhelper "systemui", DevTools 127.0.0.1:8087; see
# steam-close-button/patch.js for how it works), registered with
# steam-ui-patches.nix only when enabled; it turns on the SteamVR web helper
# debugger (steamvr-debugger.nix), which needs one SteamVR restart the first
# time. Depends on SteamVR UI internals, found by signature
# (lib/signatures.json, "steam-close-button"; scripts/check-signatures.mjs
# checks them offline).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.steamCloseButton;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
in {
  imports = [ ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.steamCloseButton.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = ''
      Close (X) button on the SteamVR dashboard's main Steam window. It
      docks the window back into the dashboard if it was placed in the world,
      then switches to the most recently active other dashboard window, or,
      with none, leaves the dashboard open with just its bar ("bar only";
      kept when the dashboard is closed and reopened, until a window is
      activated, e.g. with the Steam tab). Runtime patch of the SteamVR
      dashboard (steamFrame.uiPatches), applied immediately; turning it off
      removes the button (next switch).
    '';
  };

  config = lib.mkIf cfg.enable {
    steamFrame.uiPatches.patches = [ {
      name = "steam-close-button";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = mkPatch {
        name = "steam-close-button";
        src = ./steam-close-button/patch.js;
      };
      unpatch = ./steam-close-button/unpatch.js;
    } ];
  };
}
