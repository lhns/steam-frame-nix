# Cleanup of what steam-frame-nix writes outside the Nix store (install.sh
# cleanup, see there for the list). Imported by every module.
# - steam-frame-nix-cleanup on PATH (e.g. `steam-frame-nix-cleanup --all`
#   before removing steam-frame-nix from a configuration).
# - On every switch, `cleanup --orphans` removes what the configuration no
#   longer uses (other modules list what they still use in `keep`); with
#   Home Manager's `uninstall = true;` it runs `cleanup --all` instead.
# - Before checkLinkTargets, links of older versions at paths Home Manager is
#   about to own (`migrateLinks`) are removed, so they don't count as
#   collisions.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.cleanup;
  cleanup = pkgs.callPackage ./cleanup/package.nix { };
  args = if config.uninstall then [ "--all" ]
    else [ "--orphans" "--quiet" ] ++ lib.concatMap (k: [ "--keep" k ]) (lib.unique cfg.keep);
  env = "STEAM_FRAME_NIX_RUNTIME_DIR=${lib.escapeShellArg config.steamFrame.session.runtimeDir}";
in {
  imports = [ ./session.nix ];

  options.steamFrame.cleanup = {
    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = cleanup;
      defaultText = lib.literalMD "steam-frame-nix-cleanup (`install.sh cleanup`)";
      description = "The steam-frame-nix-cleanup command (`install.sh cleanup`).";
    };
    keep = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
      description = ''
        Artifacts the configuration still uses (`install.sh cleanup --keep`),
        set by the modules.
      '';
    };
    migrateLinks = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          path = lib.mkOption { type = lib.types.str; description = "Path relative to the home directory."; };
          target = lib.mkOption { type = lib.types.str; description = "Glob the old link's target must match."; };
        };
      });
      default = [ ];
      internal = true;
      description = ''
        Links an older version made where Home Manager now puts its own:
        removed before checkLinkTargets if they still point to `target`.
      '';
    };
  };

  config = {
    home.packages = [ cleanup ];

    home.activation.steamFrameNixMigrate = lib.hm.dag.entryBefore [ "checkLinkTargets" ]
      (lib.concatMapStrings (l: ''
        if [[ -L "$HOME"/${lib.escapeShellArg l.path} && $(readlink "$HOME"/${lib.escapeShellArg l.path}) == ${l.target} ]]; then
          run rm $VERBOSE_ARG "$HOME"/${lib.escapeShellArg l.path}
          echo "steam-frame-nix: removed the old link $HOME/"${lib.escapeShellArg l.path}
        fi
      '') cfg.migrateLinks);

    home.activation.steamFrameNixCleanup = lib.hm.dag.entryAfter [ "writeBoundary" "linkGeneration" ] ''
      if [[ -v DRY_RUN ]]; then
        ${env} ${lib.getExe cleanup} --dry-run ${lib.escapeShellArgs args}
      else
        run env ${env} ${lib.getExe cleanup} ${lib.escapeShellArgs args}
      fi
    '';
  };
}
