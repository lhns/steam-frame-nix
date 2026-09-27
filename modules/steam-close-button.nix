# Close (X) button on the dashboard's Steam window. Dashboard patch
# (steam-close-button/patch.js; "systemui" on 127.0.0.1:8087), registered only
# when enabled; enables steamvr-debugger.nix (one SteamVR restart the first time).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.steamCloseButton;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
in {
  imports = [ ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.steamCloseButton.enable = lib.mkEnableOption ''
    a Close (X) button on the dashboard's Steam window: docks it back if it
    was in the world, then switches to the last active other window, or
    leaves only the dashboard bar (until a window is activated, e.g. via the
    Steam tab). Dashboard patch; off removes it (next switch)'';

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
