{
  description = "Home Manager configuration for SteamOS (Steam Frame / Steam Deck)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Steam Frame fixes (steamFrame.* options).
    steam-frame-nix = {
      url = "github:lhns/steam-frame-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, home-manager, steam-frame-nix, ... }:
  let
    # Filled in by install.sh; the defaults match the Steam Frame.
    username = "steamos";
    homeDirectory = "/home/steamos";
    # Steam Frame: "aarch64-linux". Steam Deck: "x86_64-linux".
    system = "aarch64-linux";
  in {
    homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.${system};
      extraSpecialArgs = { inherit username homeDirectory; };
      modules = [
        steam-frame-nix.homeManagerModules.default
        ./home.nix
      ];
    };
  };
}
