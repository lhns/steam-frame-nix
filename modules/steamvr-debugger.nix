# SteamVR web helper debugger: DevTools of the dashboard (vrwebhelper) on
# 127.0.0.1:8087, for dashboard patches. On automatically (mkDefault) when a
# patch targets port 8087.
#
# The port opens only with VRWebHelper/DebuggerEnabled in
# ~/.config/openvr/config/steamvr.vrsettings, which SteamVR rewrites from
# memory, so it can't be a store link or be edited while SteamVR runs. The key
# is set only while SteamVR runs:
# - before each start, the steamvr-webhelper-debugger oneshot (drop-in
#   Wants/After on steamvr.service; ExecStartPre= would be too late, vrserver
#   starts in the unit's own chain) runs `install.sh steamvr-debugger-arm`:
#   it keeps the key's value in $XDG_STATE_HOME/steam-frame-nix/
#   steamvr-debugger.armed (a key already true is the user's own and left
#   alone), sets the key, and writes a runtime drop-in
#   ($XDG_RUNTIME_DIR/systemd/user/steamvr.service.d) with a /usr/bin-only
#   restore script (daemon-reload only when it is new, i.e. once per boot);
# - when SteamVR stops, that ExecStopPost= puts the value back and removes
#   .armed. The runtime pieces don't depend on Nix, so this also works after
#   a rollback or uninstall; they are gone at reboot, and .armed (the only
#   trace after a power loss) is resolved by the next start or
#   steam-frame-nix-cleanup.
# Off: no unit and no drop-in; cleanup restores the key once SteamVR is
# stopped. Developer Mode forwards the port to 0.0.0.0:8088 (docs/ui-patches.md,
# "DevTools on the LAN"); our patches use 127.0.0.1 only.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.steamvrDebugger;

  usesDebugger = p: builtins.match "[a-z]+://[^/]*:8087(/.*)?" p.endpoint != null;

  arm = pkgs.callPackage ./cleanup/package.nix {
    name = "steamvr-webhelper-debugger";
    command = "steamvr-debugger-arm";
  };
in {
  imports = [ ./cleanup.nix ./steam-ui-patches.nix ];

  options.steamFrame.steamvrDebugger.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    defaultText = lib.literalMD ''
      on automatically when a SteamVR dashboard patch (a
      `steamFrame.uiPatches.patches` entry on port 8087) is enabled
    '';
    description = ''
      SteamVR's web helper debugger (dashboard DevTools on 127.0.0.1:8087,
      VRWebHelper/DebuggerEnabled in steamvr.vrsettings), needed by SteamVR
      dashboard patches, which turn it on automatically. Set only while
      SteamVR runs (from its next start; the first time needs one SteamVR
      restart) and put back to its previous value when SteamVR stops.
      Developer Mode also forwards the port to the LAN (0.0.0.0:8088).
    '';
  };

  config = lib.mkMerge [
    {
      steamFrame.steamvrDebugger.enable =
        lib.mkDefault (lib.any usesDebugger config.steamFrame.uiPatches.patches);
    }
    (lib.mkIf cfg.enable {
      steamFrame.cleanup.keep = [ "debugger" ];

      systemd.user.services.steamvr-webhelper-debugger = {
        Unit = {
          Description = "Set SteamVR VRWebHelper/DebuggerEnabled until SteamVR stops (steam-frame-nix)";
          Before = [ "steamvr.service" ];
        };
        Service = {
          Type = "oneshot";
          Environment = [ "STEAM_FRAME_NIX_RUNTIME_DIR=%t" ];
          ExecStart = lib.getExe arm;
        };
      };

      # Wants=, not Requires=: SteamVR still starts if this fails.
      xdg.configFile."systemd/user/steamvr.service.d/webhelper-debugger.conf".text = ''
        [Unit]
        Wants=steamvr-webhelper-debugger.service
        After=steamvr-webhelper-debugger.service
      '';
    })
  ];
}
