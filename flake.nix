{
  description = "Home Manager modules for the Valve Steam Frame (SteamOS, aarch64-linux)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    clipboard-sync-src = {
      url = "github:dnut/clipboard-sync";
      flake = false;   # just the source; its flake outputs are x86-only
    };
  };

  outputs = { self, nixpkgs, clipboard-sync-src }:
  let
    modules = {
      session = ./modules/session.nix;
      portal = ./modules/portal.nix;
      keyboard-layout = ./modules/keyboard-layout.nix;
      vr-keyboard = ./modules/vr-keyboard.nix;
      hidden-apps = ./modules/hidden-apps.nix;
      # Built with the consumer's pkgs; only the source comes from our input.
      # The key lets the module system deduplicate it when it is imported both
      # directly and through `default`.
      clipboard-sync = {
        key = "steam-frame-nix/clipboard-sync";
        _file = ./modules/clipboard-sync.nix;
        imports = [ (import ./modules/clipboard-sync.nix { inherit clipboard-sync-src; }) ];
      };
      firefox = ./modules/firefox.nix;
    };
  in {
    homeManagerModules = modules // {
      default = { imports = builtins.attrValues modules; };
    };
  };
}
