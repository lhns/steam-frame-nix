# Settings shared by both sessions, and user-service handling on switch.
#
# The Steam/VR session owns the systemd user manager and the outer D-Bus
# (<runtimeDir>/bus); the nested Plasma desktop has its own XDG_RUNTIME_DIR
# and private bus. `switch` usually runs from the nested desktop, where
# home-manager's reloadSystemd is skipped ("User systemd daemon not running"),
# so `steamFrameUserServices` does it against the outer session: always
# daemon-reload, then start/stop/restart the units in `session.services`.
# Then `steamFrameRestartCheck` (`install.sh restart-check`) names what the
# running session can't pick up (read only at a process start): the keyboard
# layout, the SteamVR dashboard patches' DevTools port.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.session;
  units = lib.escapeShellArgs;
  restartCheck = pkgs.callPackage ./cleanup/package.nix {
    name = "steam-frame-nix-restart-check";
    command = "restart-check";
  };
  rename = from: to: lib.mkRenamedOptionModule ([ "steamFrame" ] ++ from) [ "steamFrame" "session" to ];
in {
  imports = [
    (rename [ "runtimeDir" ] "runtimeDir")
    (rename [ "userBus" ] "bus")
  ] ++ map (n: lib.mkRenamedOptionModule
    [ "steamFrame" "userServices" n ] [ "steamFrame" "session" "services" n ])
    [ "start" "restart" "stop" ];

  # Read-only, so no mkRenamedOptionModule (its alias definition would be a
  # second one); reading the old name warns.
  options.steamFrame.outerBusEnv = lib.mkOption {
    type = lib.types.str;
    readOnly = true;
    visible = false;
    default = lib.warn
      "The option `steamFrame.outerBusEnv' has been renamed to `steamFrame.session.busEnv'."
      cfg.busEnv;
    defaultText = lib.literalExpression "config.steamFrame.session.busEnv";
    description = "Alias of {option}`steamFrame.session.busEnv`.";
  };

  options.steamFrame.session = {
    runtimeDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/user/1000";
      description = "XDG_RUNTIME_DIR of the outer (Steam/VR) session.";
    };
    bus = lib.mkOption {
      type = lib.types.str;
      default = "unix:path=${cfg.runtimeDir}/bus";
      defaultText = lib.literalExpression
        ''"unix:path=''${config.steamFrame.session.runtimeDir}/bus"'';
      description = ''
        Outer session D-Bus address; the only bus that reaches the user
        systemd manager and the running kwalletd6.
      '';
    };
    busEnv = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "env DBUS_SESSION_BUS_ADDRESS=${cfg.bus}";
      defaultText = lib.literalExpression
        ''"env DBUS_SESSION_BUS_ADDRESS=''${config.steamFrame.session.bus}"'';
      description = ''
        Exec= prefix for launchers that must use the outer bus, e.g. so apps
        in the nested desktop use the running kwalletd6 instead of a second
        one.
      '';
    };
    services = {
      start = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "docker.service" ];
        description = ''
          User units started on switch if not already running (outer user
          manager).
        '';
      };
      restart = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "steam-keyboard-patch.service" ];
        description = ''
          User units restarted on every switch (outer user manager).
        '';
      };
      stop = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          User units stopped on switch if running (e.g. of a just-disabled
          feature).
        '';
      };
    };
  };

  # In a subshell: the outer session's environment must not leak into
  # activation steps that run later.
  config.home.activation.steamFrameUserServices = lib.hm.dag.entryAfter [ "reloadSystemd" ] (''
    (
    export XDG_RUNTIME_DIR=${lib.escapeShellArg cfg.runtimeDir} DBUS_SESSION_BUS_ADDRESS=${lib.escapeShellArg cfg.bus}
    run /usr/bin/systemctl --user daemon-reload
  '' + lib.optionalString (cfg.services.start != [ ]) ''
    run /usr/bin/systemctl --user start ${units cfg.services.start}
  '' + lib.optionalString (cfg.services.stop != [ ]) ''
    # Skip inactive ones: stopping a unit that isn't loaded fails noisily.
    for unit in ${units cfg.services.stop}; do
      [[ $(/usr/bin/systemctl --user show -p ActiveState --value "$unit") == inactive ]] \
        || run /usr/bin/systemctl --user stop "$unit" || true
    done
  '' + lib.optionalString (cfg.services.restart != [ ]) ''
    run /usr/bin/systemctl --user restart ${units cfg.services.restart}
  '' + ''
    )
  '');

  # Read-only; a warning, never a failed switch.
  config.home.activation.steamFrameRestartCheck = lib.hm.dag.entryAfter [ "steamFrameUserServices" ] ''
    STEAM_FRAME_NIX_RUNTIME_DIR=${lib.escapeShellArg cfg.runtimeDir} XDG_CONFIG_HOME=${lib.escapeShellArg config.xdg.configHome} \
      ${lib.getExe restartCheck} || true
  '';
}
