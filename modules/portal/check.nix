# Evaluates the portal module against a stub of Home Manager's options: on by
# default the Steam session's portal config picks KDE's FileChooser, with
# `fileChooser = false` it has neither the kde.portal link nor that line.
{ pkgs }:
let
  inherit (pkgs) lib;
  dir = "xdg-desktop-portal/gamescope-portals";
  eval = cfg: (lib.evalModules {
    modules = [
      ../portal.nix
      {
        options.xdg.dataFile = lib.mkOption {
          type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
          default = { };
        };
        options.lib = lib.mkOption { type = lib.types.attrsOf lib.types.anything; };
        config = {
          _module.check = false;   # Home Manager options the stub doesn't declare
          _module.args.pkgs = pkgs;
          lib.file.mkOutOfStoreSymlink = p: "out-of-store:${p}";
        };
      }
      cfg
    ];
  }).config.xdg.dataFile;
  on = eval { };
  off = eval { steamFrame.session.portalFix.fileChooser = false; };
  kde = "org.freedesktop.impl.portal.FileChooser=kde";
in
assert on."${dir}/kde.portal".source
  == "out-of-store:/usr/share/xdg-desktop-portal/portals/kde.portal";
assert lib.hasInfix kde on."${dir}/gamescope-portals.conf".text;
assert !(off ? "${dir}/kde.portal");
assert !(lib.hasInfix kde off."${dir}/gamescope-portals.conf".text);
assert off ? "${dir}/holo.portal";
pkgs.runCommand "portal-check" { } "touch $out"
