# steamFrame.dashboard.passthroughToggle (user service
# passthrough-toggle-relay; patch name "passthrough-toggle" in logs and
# signatures.json).
# A three-way cycle (off -> colour -> mono -> off) on the VR dashboard's
# stock room-view button, adapted from toorux/steam-frame-passthrough-toggle
# (reusing KominoVR/frame-passthrough-shortcuts' private-interface approach
# for the camera; see the README's Credits).
# - patch.js is injected like any other steam-ui-patches patch, over Steam's
#   CEF DevTools (127.0.0.1:8080, SharedJSContext); it only finds the button
#   and runs the click cycle, never touching hardware itself.
# - steam-frame-nix-passthrough (passthrough-toggle/src/main.rs) is the only
#   process that talks to SteamVR's private camera interface.
# - relay.mjs (user service passthrough-toggle-relay) is the only process
#   that runs the helper: a CDP binding on SharedJSContext that patch.js
#   calls, one request at a time (request.mjs's allowlist).
# Tests: passthrough-toggle/check.nix (flake check passthrough-toggle).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.dashboard.passthroughToggle;
  helper = pkgs.callPackage ./passthrough-toggle/package.nix { };
  patch = (import ./steam-ui-patches/lib { inherit pkgs; }).mkPatch {
    name = "passthrough-toggle";
    src = ./passthrough-toggle/patch.js;
    opts = { invocation = 2; icon = 2; iconActive = 1; };
  };
  # The relay imports request.mjs from its own directory.
  relaySrc = lib.fileset.toSource {
    root = ./passthrough-toggle;
    fileset = lib.fileset.unions [
      ./passthrough-toggle/relay.mjs
      ./passthrough-toggle/request.mjs
    ];
  };
in {
  imports = [ ./session.nix ./cleanup.nix ./steam-ui-patches.nix ];

  options.steamFrame.dashboard.passthroughToggle.enable = lib.mkEnableOption ''
    a three-way cycle (off, colour, mono) on the VR dashboard's stock
    room-view button: colour needs an Arcturus RGB accessory, and quietly
    stays mono without one. Adds steam-frame-nix-passthrough (talks to
    SteamVR's private camera interface directly; nothing from Valve
    vendored) and the passthrough-toggle-relay user service; off reverts the
    dashboard patch and stops the relay on the next switch'';

  config = lib.mkMerge [
  (lib.mkIf cfg.enable {
    steamFrame.uiPatches.patches = [ {
      name = "passthrough-toggle";
      target.title = "SharedJSContext";
      inherit patch;
      unpatch = ./passthrough-toggle/unpatch.js;
    } ];

    systemd.user.services.passthrough-toggle-relay = {
      Unit.Description = "CDP relay for the Steam Frame passthrough toggle";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${relaySrc}/relay.mjs"
          "${helper}/bin/steam-frame-nix-passthrough"
        ];
        Restart = "always";
        RestartSec = 5;
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on switch to pick up a changed relay/helper; the shared
    # steam-ui-patches service (already restarted by its own module when its
    # patch list changes) re-injects or reverts patch.js.
    steamFrame.session.services.restart = [ "passthrough-toggle-relay.service" ];
    # SteamVR writes vrclient_steam-frame-nix-passthrough.txt itself; keep it
    # while in use (install.sh cleanup, docs/cleanup.md).
    steamFrame.cleanup.keep = [ "passthrough" ];
  })
  (lib.mkIf (!cfg.enable) {
    steamFrame.session.services.stop = [ "passthrough-toggle-relay.service" ];
  })
  ];
}
