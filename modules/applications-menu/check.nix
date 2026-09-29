# Evaluates the applications-menu module against a stub of Home Manager's
# options: on by default the link to Plasma's menu is generated, disabled it
# is absent.
{ pkgs }:
let
  inherit (pkgs) lib;
  eval = cfg: (lib.evalModules {
    modules = [
      ../applications-menu.nix
      {
        options.xdg.configFile = lib.mkOption {
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
  }).config.xdg.configFile;
  on = eval { };
  off = eval { steamFrame.session.applicationsMenu.enable = false; };
in
assert on."menus/applications.menu".source
  == "out-of-store:/etc/xdg/menus/plasma-applications.menu";
assert !(off ? "menus/applications.menu");
pkgs.runCommand "applications-menu-check" { } "touch $out"
