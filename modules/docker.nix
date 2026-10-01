# Rootless Docker as a systemd user service (docs/docker.md). The socket is
# in the outer runtime dir, so the CLI gets it as a default DOCKER_HOST (the
# nested desktop has its own XDG_RUNTIME_DIR); the unit is only started on
# switch, as a restart would stop running containers.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.docker;
  host = "unix://${config.steamFrame.session.runtimeDir}/docker.sock";

  cli = pkgs.symlinkJoin {
    name = "docker-rootless-cli";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/docker --set-default DOCKER_HOST ${host}
    '';
  };
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.docker = {
    enable = lib.mkEnableOption ''
      rootless Docker: dockerd as a user service and the docker CLI, usable
      from both sessions'';
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.docker;
      defaultText = lib.literalExpression "pkgs.docker";
      description = ''
        Docker package: dockerd-rootless for the service, the CLI (wrapped
        with DOCKER_HOST) on PATH.
      '';
    };
    host = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = host;
      defaultText = lib.literalExpression
        ''"unix://''${config.steamFrame.session.runtimeDir}/docker.sock"'';
      description = "DOCKER_HOST of the daemon (for other clients).";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cli ];

    systemd.user.services.docker = {
      Unit = {
        Description = "Docker Application Container Engine (Rootless)";
        StartLimitIntervalSec = 60;
        StartLimitBurst = 3;
      };
      Service = {
        Type = "notify";
        # /usr/bin for SteamOS's newuidmap/newgidmap (they need their caps).
        Environment = "PATH=/usr/bin";
        ExecStart = "${cfg.package}/bin/dockerd-rootless";
        ExecReload = "${pkgs.procps}/bin/kill -s HUP $MAINPID";
        TimeoutSec = 0;
        Restart = "always";
        RestartSec = 2;
        LimitNOFILE = "infinity";
        LimitNPROC = "infinity";
        LimitCORE = "infinity";
        Delegate = true;
        NotifyAccess = "all";
        KillMode = "mixed";
      };
      Install.WantedBy = [ "default.target" ];
    };

    steamFrame.session.services.start = [ "docker.service" ];
  };
}
