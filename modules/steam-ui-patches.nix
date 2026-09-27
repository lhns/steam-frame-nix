# Runtime patches of Steam's and SteamVR's web UIs over local CEF DevTools
# (Steam 127.0.0.1:8080; SteamVR's vrwebhelper 127.0.0.1:8087, see
# steamvr-debugger.nix). The steam-ui-patches service (injector.mjs) injects
# each registered patch into its target pages, re-injects on reload and every
# 15 s, and runs the unpatches on stop; Steam's files are untouched.
# It exists while `patches` is non-empty, restarts on every switch (the old
# instance reverts removed patches) and is stopped once the list is empty.
# Patch calling convention (mkPatch): lib/default.nix.
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.uiPatches;
  inherit (lib) mkOption types;

  patchType = types.submodule {
    options = {
      name = mkOption {
        type = types.strMatching "[A-Za-z0-9_.-]+";
        example = "launcher-menu-order";
        description = "Unique name, used in the service's log.";
      };
      endpoint = mkOption {
        type = types.str;
        default = "http://127.0.0.1:8080";
        example = "http://127.0.0.1:8087";
        description = ''
          DevTools base URL (its /json/list is polled): Steam 8080, SteamVR 8087.
        '';
      };
      target = {
        title = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "SharedJSContext";
          description = "Exact page title of the targets to patch.";
        };
        titleRegex = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "JavaScript regex the page title must match.";
        };
        urlRegex = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "JavaScript regex the page URL must match.";
        };
      };
      patch = mkOption {
        type = types.path;
        description = ''
          JavaScript evaluated (awaited) in every matching page after reloads
          and every 15 s, so it must be idempotent. Its result is logged when
          it changes ("unchanged" never is). Build with `lib.mkPatch` to get
          the finder library.
        '';
      };
      unpatch = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = ''
          JavaScript that reverts the patch when the service stops; must be
          safe on an unpatched page.
        '';
      };
    };
  };

  entry = p: {
    inherit (p) name endpoint patch unpatch;
    target = lib.filterAttrs (_: v: v != null) p.target;
  };

  configFile = pkgs.writeText "steam-ui-patches.json" (builtins.toJSON {
    pollMs = 5000;
    reinjectMs = 15000;
    debounceMs = 3000;
    unpatchTimeoutMs = 2000;
    patches = map entry cfg.patches;
  });
in {
  imports = [ ./session.nix ];

  options.steamFrame.uiPatches.lib = mkOption {
    type = types.attrsOf types.raw;
    readOnly = true;
    default = import ./lib { inherit pkgs; };
    defaultText = lib.literalMD "the helpers of `modules/lib`";
    description = ''
      Patch helpers from modules/lib/default.nix: `mkPatch { name, src,
      signatures ? …, opts ? { } }` (calls `src` as
      `(find, sigs, opts, hooks) => …`; see there), plus `finders`, `hooks`
      (paths) and `signatures` (parsed signatures.json).
    '';
  };

  options.steamFrame.uiPatches.patches = mkOption {
    type = types.listOf patchType;
    default = [ ];
    example = lib.literalExpression ''
      [ {
        name = "my-patch";
        target.title = "SharedJSContext";
        patch = ./my-patch/patch.js;
        unpatch = ./my-patch/unpatch.js;
      } ]
    '';
    description = ''
      Runtime patches of Steam's web UIs, kept injected by the
      steam-ui-patches service and reverted when it stops. Every page
      matching all given target criteria is patched.
    '';
  };

  config = lib.mkMerge [
  (lib.mkIf (cfg.patches != [ ]) {
    assertions = [ {
      assertion = lib.allUnique (map (p: p.name) cfg.patches);
      message = "steamFrame.uiPatches.patches: names must be unique.";
    } ];

    systemd.user.services.steam-ui-patches = {
      Unit.Description = "Runtime patches of Steam's UI (CEF DevTools)";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${./steam-ui-patches/injector.mjs}"
          "${configFile}"
        ];
        Restart = "always";
        RestartSec = 5;
        TimeoutStopSec = 5;   # the injector unpatches Steam's UI on SIGTERM
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on switch: re-inject changed patches; the old instance reverts
    # removed ones.
    steamFrame.userServices.restart = [ "steam-ui-patches.service" ];
  })
  # No patches: stopping the injector reverts them right away.
  (lib.mkIf (cfg.patches == [ ]) {
    steamFrame.userServices.stop = [ "steam-ui-patches.service" ];
  })
  ];
}
