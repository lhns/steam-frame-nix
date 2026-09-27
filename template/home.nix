{ config, pkgs, username, homeDirectory, ... }: {
  home.username = username;            # set in flake.nix
  home.homeDirectory = homeDirectory;  # set in flake.nix

  # Home Manager release this configuration was first written for. Don't
  # change it on upgrades; see the home.stateVersion option docs.
  home.stateVersion = "26.05";

  targets.genericLinux.enable = true;  # non-NixOS integration
  programs.home-manager.enable = true; # the `home-manager` command

  # Packages for your user, e.g.:
  # home.packages = with pkgs; [ htop ripgrep ];

  # Steam Frame fixes, see https://github.com/lhns/steam-frame-nix
  # (portalFix and clipboardSync are on by default).
  # steamFrame = {
  #   keyboardLayout = "de";             # XKB layout for the Steam session
  #   steamKeyboardPatch.enable = true;  # Esc/Ctrl/Alt/arrows on the VR keyboard
  #   # VR "+" menu: sorted by name, Desktop pinned below the list:
  #   launcherMenu = { sort = true; pinDesktop = "bottom"; };
  #   firefox.enable = true;             # launcher for the Firefox Flatpak
  #   # Hidden from the "+" menu (with Steam Developer Mode on):
  #   hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
  # };
}
