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
      steam-keyboard-patch = ./modules/steam-keyboard-patch.nix;
      vr-keyboard = ./modules/vr-keyboard.nix;
      hidden-apps = ./modules/hidden-apps.nix;
      steam-ui-patches = ./modules/steam-ui-patches.nix;
      launcher-menu = ./modules/launcher-menu.nix;
      steamvr-debugger = ./modules/steamvr-debugger.nix;
      dashboard-windows = ./modules/dashboard-windows.nix;
      steam-close-button = ./modules/steam-close-button.nix;
      window-curvature = ./modules/window-curvature.nix;
      frame-controls = ./modules/frame-controls.nix;
      # Built with the consumer's pkgs; `key` dedups direct + `default` imports.
      clipboard-sync = {
        key = "steam-frame-nix/clipboard-sync";
        _file = ./modules/clipboard-sync.nix;
        imports = [ (import ./modules/clipboard-sync.nix { inherit clipboard-sync-src; }) ];
      };
      firefox = ./modules/firefox.nix;
      jellyfin = ./modules/jellyfin.nix;
    };
    systems = [ "aarch64-linux" "x86_64-linux" ];
    forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    homeManagerModules = modules // {
      default = { imports = builtins.attrValues modules; };
    };

    # Removes what steam-frame-nix wrote outside the Nix store (install.sh
    # cleanup): nix run github:lhns/steam-frame-nix#cleanup -- --all
    packages = forSystems (pkgs: {
      cleanup = pkgs.callPackage ./modules/cleanup/package.nix { };
    });
    apps = nixpkgs.lib.mapAttrs (_: p: {
      cleanup = {
        type = "app";
        program = "${p.cleanup}/bin/steam-frame-nix-cleanup";
        meta.description = "Remove what steam-frame-nix wrote outside the Nix store";
      };
    }) self.packages;

    # Tests of the VR keyboard (text model, corrector, swipe decoder on the
    # default German + English dictionary), the Jellyfin mpv shim and
    # install.sh cleanup: nix flake check
    checks = forSystems (pkgs: {
      cleanup = import ./modules/cleanup/check.nix { inherit pkgs; };
      jellyfin = import ./modules/jellyfin/check.nix { inherit pkgs; };
      vr-keyboard = (import ./modules/vr-keyboard/build.nix {
        inherit pkgs;
        dictionary = {
          languages = map (l: l // { keepFrequentAbove = 4.0; }) [
            { language = "de"; hunspell = "de_DE"; words = 60000; frequencyOffset = 0.0; }
            { language = "en"; hunspell = "en_US"; words = 40000; frequencyOffset = -0.3; }
          ];
          contractions = true; extraWords = [ ]; extraWordsFrequency = 5.0; extraWordFiles = [ ]; excludeWords = [ ];
        };
      }).checks;
    });

    # nix flake init -t github:lhns/steam-frame-nix
    templates.default = {
      path = ./template;
      description = "Standalone Home Manager configuration for SteamOS using steam-frame-nix";
    };
  };
}
