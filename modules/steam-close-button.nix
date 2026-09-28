# Close (X) button on the dashboard's Steam window. SteamVR dashboard patch
# (steam-close-button/patch.js; "systemui" on 127.0.0.1:8087), registered only
# when enabled; enables steamvr-debugger.nix (one SteamVR restart the first time).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.dashboard.steamCloseButton;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
in {
  imports = [ ./cleanup.nix ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.dashboard.steamCloseButton.enable = lib.mkEnableOption ''
    a Close (X) button on the dashboard's Steam window. It hides Steam
    (previous window or just the bar) until shown explicitly, e.g. via the
    Steam tab, also across SteamVR restarts and reboots (in
    ~/.local/state/steam-frame-nix/ui-patches/steam-close-button.json).
    SteamVR dashboard patch; off removes it (next switch)'';

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
      state = true;                 # "Steam hidden", kept across restarts
    } ];
  };
}
