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
      applications-menu = ./modules/applications-menu.nix;
      keyboard-layout = ./modules/keyboard-layout.nix;
      vr-keyboard-extra-keys = ./modules/vr-keyboard-extra-keys.nix;
      vr-keyboard = ./modules/vr-keyboard.nix;
      hidden-apps = ./modules/hidden-apps.nix;
      steam-ui-patches = ./modules/steam-ui-patches.nix;
      launcher-menu = ./modules/launcher-menu.nix;
      steamvr-debugger = ./modules/steamvr-debugger.nix;
      cleanup = ./modules/cleanup.nix;
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
      launchers = ./modules/launchers.nix;
      docker = ./modules/docker.nix;
    };
    # Former attribute names, kept so existing imports keep working (not in
    # `default`, which imports each module once under its current name).
    aliases = {
      steam-keyboard-patch = modules.vr-keyboard-extra-keys;   # its name until 2026-09
      keyring = modules.launchers;   # until 2026-09 (its options now fail with the new form)
    };
    systems = [ "aarch64-linux" "x86_64-linux" ];
    forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    homeManagerModules = modules // aliases // {
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
    # default German + English dictionary), the Jellyfin mpv shim, the
    # Firefox wrapper, the launchers, install.sh cleanup, the
    # applications.menu link and the portal config: nix flake check
    checks = forSystems (pkgs: {
      applications-menu = import ./modules/applications-menu/check.nix { inherit pkgs; };
      cleanup = import ./modules/cleanup/check.nix { inherit pkgs; };
      firefox = import ./modules/firefox/check.nix { inherit pkgs; };
      jellyfin = import ./modules/jellyfin/check.nix { inherit pkgs; };
      launchers = import ./modules/launchers/check.nix { inherit pkgs; };
      portal = import ./modules/portal/check.nix { inherit pkgs; };
      vr-keyboard = import ./modules/vr-keyboard/check.nix { inherit pkgs; };
    });

    # nix flake init -t github:lhns/steam-frame-nix
    templates.default = {
      path = ./template;
      description = "Standalone Home Manager configuration for SteamOS using steam-frame-nix";
    };
  };
}
