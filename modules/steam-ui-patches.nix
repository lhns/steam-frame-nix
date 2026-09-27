# Runtime patches of Steam's (and SteamVR's) web UIs through their local CEF
# DevTools ports: Steam's client UI on 127.0.0.1:8080 (SteamOS starts Steam
# with -cef-enable-debugging), SteamVR's vrwebhelper on 127.0.0.1:8087 when
# its debugger is enabled. Steam's files are untouched: the
# `steam-ui-patches` service (injector.mjs, Node) evaluates each registered
# patch in its target pages, re-injects it when a page is reloaded or
# recreated (and every 15 s), and evaluates its unpatch expression when the
# service stops, so the UI is back to stock without a Steam restart.
#
# Other modules (and your own config) register patches in
# `steamFrame.uiPatches.patches`; the service exists only while that list is
# non-empty. It is restarted on every switch (changed patches are re-injected,
# removed ones reverted by the old instance) and stopped once the list is
# empty. The keyboard patch (steam-keyboard-patch.nix) has its own helper.
#
# Patches that need Steam's webpack modules should find them by signature
# rather than by module id or minified export name, which change with Steam
# updates: `steamFrame.uiPatches.lib.mkPatch` wraps a patch written as
# `(find, sigs, opts, hooks) => …` with the finder library (lib/finders.js),
# its signatures and the shared method hooks (lib/hooks.js);
# scripts/check-signatures.mjs checks signatures offline.
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
          DevTools base URL of the CEF instance (its /json/list is polled).
          Steam's client UI is on port 8080, SteamVR's vrwebhelper on 8087.
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
          JavaScript file evaluated in every matching page (DevTools
          Runtime.evaluate, awaited). Must be idempotent: it is re-evaluated
          after page reloads and every 15 s. Its result value is logged when it
          changes; return e.g. "patched", and "unchanged" (never logged) when
          already applied. To use the finder library, build it with
          `config.steamFrame.uiPatches.lib.mkPatch`.
        '';
      };
      unpatch = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = ''
          JavaScript file evaluated in every patched page when the service
          stops (switch, list emptied, logout), reverting the patch. Must be
          safe when the page isn't patched.
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
      Helpers for writing patches (see modules/lib/default.nix):
      `mkPatch { name, src, signatures ? …, opts ? { } }` returns a patch
      file that calls `src`, a JavaScript function expression
      `(find, sigs, opts, hooks) => …`, with the finder library `find`
      (modules/lib/finders.js: getWebpackRequire, resolveAll, findModule,
      findExport, findFiberUp, findInReactTree, …), the module signatures
      `sigs` (format: modules/lib/signatures.json; default: its entry
      `name`, if any), `opts` and the shared method hooks `hooks`
      (modules/lib/hooks.js: before, remove, has). `finders` and `hooks`
      are the libraries' paths, `signatures` the parsed signatures.json.
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
      `steam-ui-patches` user service over the local CEF DevTools ports and
      reverted when it stops. Every target (page) of the endpoint matching all
      given target criteria is patched.
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

    # Restart on every switch so changed patches are re-injected (each
    # replaces its older version) and removed ones are reverted by the old
    # instance.
    steamFrame.userServices.restart = [ "steam-ui-patches.service" ];
  })
  # No patches: stop a still-running injector, which reverts its patches, so
  # Steam's UI is stock right away.
  (lib.mkIf (cfg.patches == [ ]) {
    steamFrame.userServices.stop = [ "steam-ui-patches.service" ];
  })
  ];
}
