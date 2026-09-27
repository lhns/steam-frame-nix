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
  #   # VR "+" menu: sorted by name, Desktop pinned below the list, closed
  #   # on click, no second launch of the same program within 10 s, programs
  #   # as a grid of 4 columns, at most 4 rows visible:
  #   launcherMenu = {
  #     sort = true;
  #     pinDesktop = "bottom";
  #     closeOnLaunch = true;
  #     launchDebounce = 10;
  #     grid = { enable = true; columns = 4; maxRows = 4; };
  #   };
  #   # SteamVR dashboard windows: resizable up to 4x (stock 2x), pushed
  #   # back up to 10 m in the world / 12 m in theater mode (stock 5 / 6 m):
  #   dashboard = {
  #     windowMaxScale = 4.0;
  #     windowDistance.world.max = 10.0;
  #     windowDistance.theater.max = 12.0;
  #   };
  #   firefox.enable = true;             # launcher for the Firefox Flatpak
  #   # Hidden from the "+" menu (with Steam Developer Mode on):
  #   hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
  # };
}
