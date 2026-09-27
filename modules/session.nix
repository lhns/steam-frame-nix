# Settings shared by both sessions, and user-service handling on switch.
#
# The Steam/VR session owns the systemd user manager and the outer D-Bus
# (<runtimeDir>/bus); the nested Plasma desktop has its own XDG_RUNTIME_DIR
# and private bus. `switch` usually runs from the nested desktop, where
# home-manager's reloadSystemd is skipped ("User systemd daemon not running"),
# so `steamFrameUserServices` does it against the outer session: always
# daemon-reload, then start/stop/restart the units in `userServices`.
{ config, lib, ... }:
let
  cfg = config.steamFrame;
  units = lib.escapeShellArgs;
in {
  options.steamFrame = {
    runtimeDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/user/1000";
      description = "XDG_RUNTIME_DIR of the outer (Steam/VR) session.";
    };
    userBus = lib.mkOption {
      type = lib.types.str;
      default = "unix:path=${cfg.runtimeDir}/bus";
      defaultText = lib.literalExpression ''"unix:path=''${config.steamFrame.runtimeDir}/bus"'';
      description = ''
        Outer session D-Bus address; the only bus that reaches the user
        systemd manager and the running kwalletd6.
      '';
    };
    outerBusEnv = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "env DBUS_SESSION_BUS_ADDRESS=${cfg.userBus}";
      defaultText = lib.literalExpression ''"env DBUS_SESSION_BUS_ADDRESS=''${config.steamFrame.userBus}"'';
      description = ''
        Exec= prefix for launchers that must use the outer bus, e.g. so apps
        in the nested desktop use the running kwalletd6 instead of a second one.
      '';
    };
    userServices = {
      start = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "docker.service" ];
        description = "User units started on switch if not already running (outer user manager).";
      };
      restart = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "steam-keyboard-patch.service" ];
        description = "User units restarted on every switch (outer user manager).";
      };
      stop = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "User units stopped on switch if running (e.g. of a just-disabled feature).";
      };
    };
  };

  config.home.activation.steamFrameUserServices = lib.hm.dag.entryAfter [ "reloadSystemd" ] (''
    export XDG_RUNTIME_DIR=${lib.escapeShellArg cfg.runtimeDir} DBUS_SESSION_BUS_ADDRESS=${lib.escapeShellArg cfg.userBus}
    run /usr/bin/systemctl --user daemon-reload
  '' + lib.optionalString (cfg.userServices.start != [ ]) ''
    run /usr/bin/systemctl --user start ${units cfg.userServices.start}
  '' + lib.optionalString (cfg.userServices.stop != [ ]) ''
    run /usr/bin/systemctl --user stop ${units cfg.userServices.stop} || true
  '' + lib.optionalString (cfg.userServices.restart != [ ]) ''
    run /usr/bin/systemctl --user restart ${units cfg.userServices.restart}
  '');
}
