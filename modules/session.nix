# Shared settings for the two sessions on the Steam Frame, and the
# user-services mechanism.
#
# The Frame runs the Steam/VR session (gamescope, systemd user manager, outer
# D-Bus at <runtimeDir>/bus) and a nested Plasma desktop with its own
# XDG_RUNTIME_DIR and private D-Bus. Modules that talk to the outer session use
# `runtimeDir` / `userBus` explicitly.
#
# User services: `home-manager switch` usually runs from the nested desktop,
# whose XDG_RUNTIME_DIR and D-Bus can't reach the user manager, so
# home-manager's own reloadSystemd step is skipped ("User systemd daemon not
# running"). The `steamFrameUserServices` activation entry does it instead,
# pointed at the outer session: it always runs `systemctl --user
# daemon-reload` (so changed unit files are picked up even when both lists are
# empty), then starts the units in `userServices.start`, stops those in
# `userServices.stop` and restarts those in `userServices.restart`.
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
        Address of the outer session D-Bus. The user systemd manager and the
        single running kwalletd6 are only reachable over this bus.
      '';
    };
    outerBusEnv = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "env DBUS_SESSION_BUS_ADDRESS=${cfg.userBus}";
      defaultText = lib.literalExpression ''"env DBUS_SESSION_BUS_ADDRESS=''${config.steamFrame.userBus}"'';
      description = ''
        Command prefix for launchers (desktop entry Exec= lines) that must use
        the outer bus, e.g. so apps started from the nested desktop use the
        one kwalletd6 instead of starting a second wallet on the private bus.
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
        description = ''
          User units stopped on switch if still running, e.g. the service of a
          feature that was just disabled (its unit file is already gone).
        '';
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
