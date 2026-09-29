# ~/Pictures/<name>: a link to Steam's folder of SteamVR screenshots
# (docs/screenshots.md). With steamUserId a plain Home Manager link; without,
# it points to <session.runtimeDir>/steam-frame-nix/screenshots (tmpfs),
# which steam-frame-nix-screenshots (screenshots/link.sh) points to the
# current account's folder: on switch, at login and when loginusers.vdf or
# userdata changes (path unit).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.screenshots;
  session = config.steamFrame.session;
  steam = "${config.home.homeDirectory}/.local/share/Steam";
  detect = cfg.enable && cfg.steamUserId == null;
  script = import ./screenshots/package.nix { inherit lib pkgs steam; inherit (session) runtimeDir; };
  exe = lib.getExe script;
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.screenshots = {
    enable = lib.mkEnableOption "a link to the SteamVR screenshots in ~/Pictures";
    name = lib.mkOption {
      type = lib.types.str;
      default = "SteamVR Screenshots";
      description = "Name of the link in ~/Pictures.";
    };
    steamUserId = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "[1-9][0-9]*");
      default = null;
      example = "80511808";
      description = ''
        Steam account ID: the folder name in ~/.local/share/Steam/userdata.
        `null`: the account last logged in, found at runtime.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.file."Pictures/${cfg.name}".source = config.lib.file.mkOutOfStoreSymlink
        (if detect then "${session.runtimeDir}/steam-frame-nix/screenshots"
         else "${steam}/userdata/${cfg.steamUserId}/760/remote/250820/screenshots");
    }
    (lib.mkIf detect {
      steamFrame.cleanup.keep = [ "screenshots" ];
      home.packages = [ script ];

      systemd.user.services.steam-frame-nix-screenshots = {
        Unit.Description = "steam-frame-nix: link to the SteamVR screenshots of the current Steam account";
        Service = {
          Type = "oneshot";
          ExecStart = exe;
        };
        Install.WantedBy = [ "default.target" ];
      };
      systemd.user.paths.steam-frame-nix-screenshots = {
        Unit.Description = "steam-frame-nix: update the screenshots link when the Steam account changes";
        Path = {
          PathChanged = [ "${steam}/config/loginusers.vdf" "${steam}/userdata" ];
          Unit = "steam-frame-nix-screenshots.service";
        };
        Install.WantedBy = [ "default.target" ];
      };
      steamFrame.session.services.start = [ "steam-frame-nix-screenshots.path" ];

      home.activation.steamFrameScreenshots = lib.hm.dag.entryAfter [ "linkGeneration" "steamFrameNixCleanup" ] ''
        if [[ -v DRY_RUN ]]; then
          echo "would run: ${exe}"
        else
          ${exe}
        fi
      '';
    })
  ]);
}
