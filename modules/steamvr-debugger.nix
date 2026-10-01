# SteamVR web helper debugger (docs/steamvr-debugger.md): DevTools of the
# dashboard on 127.0.0.1:8087, on (mkDefault) when a patch targets port 8087.
# The steamvr-webhelper-debugger oneshot runs `install.sh steamvr-debugger-arm`
# before each SteamVR start, through a Wants/After drop-in on steamvr.service
# (ExecStartPre= would be too late: vrserver starts in the unit's own chain).
# The arm step reloads systemd only when its runtime drop-in is new (once per
# boot). Off: no unit and no drop-in; cleanup restores the key.
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
