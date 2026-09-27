# Enables the SteamVR web helper debugger: Chromium DevTools of vrwebhelper,
# which renders the SteamVR dashboard, on 127.0.0.1:8087, so steam-ui-patches
# can patch the dashboard the way it patches Steam's UI on 127.0.0.1:8080.
# Turned on automatically (mkDefault) when a UI patch targets port 8087.
#
# SteamVR only opens the port when /settings/VRWebHelper/DebuggerEnabled is
# true (settingsschema.vrsettings: requires_restart; port from
# VRWebHelper/DebuggerPort, default 8087). User settings live in
# ~/.config/openvr/config/steamvr.vrsettings, which SteamVR rewrites at
# runtime and on exit (from memory), so it can't be a read-only store link,
# and editing it while SteamVR runs would be overwritten.
# steamvr-webhelper-debugger.service merges just that key with jq (atomic
# write, other keys untouched, file created if missing), before every start
# of steamvr.service (SteamVR's systemd user unit): a drop-in makes it
# Want + start After the oneshot. (Its own ExecStartPre= chain already starts
# vrserver, so an added ExecStartPre= would run too late.) Hence the setting
# takes effect with the next SteamVR start, once.
#
# The service is installed even when disabled: if this module set the key
# before (marker in $XDG_STATE_HOME/steam-frame-nix), it sets it back to
# false at the next SteamVR start and removes the marker; otherwise it
# leaves the file alone (a setting made by hand is kept).
#
# Security: the port listens on 127.0.0.1 only; Steam's Developer Mode makes
# SteamOS forward it to 0.0.0.0:8088 (README, "DevTools on the LAN"), so keep
# Developer Mode off. Our patches only use 127.0.0.1.
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
    defaultText = lib.literalMD "on automatically when a dashboard patch (a `steamFrame.uiPatches.patches` entry on port 8087) is enabled";
    description = ''
      Enable SteamVR's web helper debugger (DevTools of the SteamVR dashboard
      on 127.0.0.1:8087, setting VRWebHelper/DebuggerEnabled in
      ~/.config/openvr/config/steamvr.vrsettings), needed by patches of the
      SteamVR dashboard. Set before each SteamVR start, so it takes effect
      after SteamVR is restarted once. Turning it off sets the key back to
      false at the next SteamVR start. Normally there is no need to set it:
      it is turned on automatically when a dashboard patch is enabled. The
      port listens on 127.0.0.1; keep Steam's Developer Mode off, which would
      also forward it to the LAN (0.0.0.0:8088).
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

    # Wants= (not Requires=): if the merge fails (e.g. broken JSON), SteamVR
    # still starts, just without the debugger.
    xdg.configFile."systemd/user/steamvr.service.d/webhelper-debugger.conf".text = ''
      [Unit]
      Wants=steamvr-webhelper-debugger.service
      After=steamvr-webhelper-debugger.service
    '';
  };
}
