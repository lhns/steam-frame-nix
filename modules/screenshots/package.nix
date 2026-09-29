# steam-frame-nix-screenshots: link.sh with the outer runtime dir and the
# Steam directory (both overridable by environment, for the check).
{ lib, pkgs, runtimeDir, steam }:
pkgs.writeShellApplication {
  name = "steam-frame-nix-screenshots";
  runtimeInputs = [ pkgs.coreutils pkgs.gawk ];
  text = ''
    runtime=''${STEAM_FRAME_NIX_RUNTIME_DIR:-${lib.escapeShellArg runtimeDir}}
    steam=''${STEAM_FRAME_NIX_STEAM_DIR:-${lib.escapeShellArg steam}}
  '' + builtins.readFile ./link.sh;
}
