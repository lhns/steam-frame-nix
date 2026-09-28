# SteamVR web helper debugger: DevTools of the dashboard (vrwebhelper) on
# 127.0.0.1:8087, for dashboard patches. On automatically (mkDefault) when a
# patch targets port 8087.
#
# The port opens only with VRWebHelper/DebuggerEnabled (requires a SteamVR
# restart). steamvr.vrsettings is rewritten by SteamVR from memory, so it
# can't be a store link or be edited while SteamVR runs: a oneshot merges just
# that key with jq before each steamvr.service start (drop-in Wants/After;
# ExecStartPre= would be too late, vrserver starts in the unit's own chain).
# Disabled, it resets the key only if it set it (marker in
# $XDG_STATE_HOME/steam-frame-nix); a manual setting is kept.
# Developer Mode forwards the port to 0.0.0.0:8088 (README, "DevTools on the
# LAN"); our patches use 127.0.0.1 only.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.steamvrDebugger;

  usesDebugger = p: builtins.match "[a-z]+://[^/]*:8087(/.*)?" p.endpoint != null;

  merge = pkgs.writeShellApplication {
    name = "steamvr-webhelper-debugger";
    runtimeInputs = [ pkgs.jq pkgs.coreutils ];
    text = ''
      f="$HOME/.config/openvr/config/steamvr.vrsettings"
      marker="''${XDG_STATE_HOME:-$HOME/.local/state}/steam-frame-nix/steamvr-debugger"
      ${if cfg.enable then ''
        want=true
      '' else ''
        if [ ! -e "$marker" ]; then
          echo "not managed (VRWebHelper.DebuggerEnabled left as is)"
          exit 0
        fi
        want=false
      ''}
      mkdir -p "$(dirname "$f")"
      [ -s "$f" ] || printf '{}\n' > "$f"
      if [ "$(jq '.VRWebHelper.DebuggerEnabled' "$f")" = "$want" ]; then
        echo "VRWebHelper.DebuggerEnabled already $want"
      else
        tmp="$(mktemp "$f.XXXXXX")"
        trap 'rm -f "$tmp"' EXIT
        jq --indent 3 --argjson v "$want" '.VRWebHelper.DebuggerEnabled = $v' "$f" > "$tmp"
        chmod --reference="$f" "$tmp"
        mv "$tmp" "$f"
        echo "VRWebHelper.DebuggerEnabled set to $want (effective from this SteamVR start)"
      fi
      if [ "$want" = true ]; then
        mkdir -p "$(dirname "$marker")"
        touch "$marker"
      else
        rm -f "$marker"
      fi
    '';
  };
in {
  imports = [ ./steam-ui-patches.nix ];

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
      dashboard patches, which turn it on automatically. Takes effect after one SteamVR
      restart; off resets the key at the next start. Developer Mode also
      forwards the port to the LAN (0.0.0.0:8088).
    '';
  };

  config = {
    steamFrame.steamvrDebugger.enable =
      lib.mkDefault (lib.any usesDebugger config.steamFrame.uiPatches.patches);

    systemd.user.services.steamvr-webhelper-debugger = {
      Unit = {
        Description = "Set SteamVR VRWebHelper/DebuggerEnabled (steam-frame-nix)";
        Before = [ "steamvr.service" ];
      };
      Service = {
        Type = "oneshot";
        ExecStart = "${merge}/bin/steamvr-webhelper-debugger";
      };
    };

    # Wants=, not Requires=: SteamVR still starts if the merge fails.
    xdg.configFile."systemd/user/steamvr.service.d/webhelper-debugger.conf".text = ''
      [Unit]
      Wants=steamvr-webhelper-debugger.service
      After=steamvr-webhelper-debugger.service
    '';
  };
}
