{ config, pkgs, username, homeDirectory, ... }: {
  home.username = username;            # set in flake.nix
  home.homeDirectory = homeDirectory;  # set in flake.nix

  # Home Manager release this configuration was first written for. Don't
  # change it on upgrades; see the home.stateVersion option docs.
  home.stateVersion = "26.05";

  targets.genericLinux.enable = true;  # non-NixOS integration
  programs.home-manager.enable = true; # the `home-manager` command

  # git credentials for HTTPS (`install.sh install --clone` uses them):
  # github.com through the GitHub CLI (gh auth login), other hosts from
  # ~/.git-credentials. git is SteamOS's; Home Manager writes its config.
  programs.git = {
    enable = true;
    package = null;
    settings.credential.helper = "store";
  };
  programs.gh.enable = true;

  # Packages for your user, e.g.:
  # home.packages = with pkgs; [ htop ripgrep ];

  # Steam Frame fixes, see https://github.com/lhns/steam-frame-nix
  # (session.portalFix and session.applicationsMenu are on by default).
  # steamFrame = {
  #   keyboard.layout = "de";               # XKB layout, Steam session
  #   keyboard.vr.extraKeys.enable = true;  # Esc/Ctrl/Alt/arrows in VR
  #   keyboard.vr.enable = true;            # swipe, suggestions, Backspace drag
  #   # nested desktop <-> Steam session clipboard (builds from source,
  #   # takes a while):
  #   clipboardSync.enable = true;
  #   # VR "+" menu: sorted by name, Desktop pinned below the list, closed
  #   # on click, no second launch of the same program within 10 s, programs
  #   # as a grid of 4 columns, at most 4 rows visible:
  #   launcherMenu = {
  #     sort = true;
  #     pinDesktop = "bottom";
  #     closeOnLaunch = true;
  #     launchDebounceSeconds = 10;
  #     grid = { enable = true; columns = 4; maxRows = 4; };
  #     # All programs without Steam's Developer Mode (Konsole, KDE System
  #     # Settings, Dolphin, ... are hidden otherwise):
  #     showAllApps = true;
  #     # Icon fallbacks (Konsole, KDE System Settings) are on by default;
  #     # further Breeze icon names (each switch suggests some):
  #     # iconFallbacks.extra = [ "system-file-manager" ];
  #     # Hidden from the menu (listed with Developer Mode or showAllApps):
  #     hiddenApps = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
  #   };
  #   # SteamVR dashboard windows: resizable up to 4x (stock 2x), pushed
  #   # back up to 10 m in the world / 12 m in theater mode (stock 5 / 6 m):
  #   dashboard = {
  #     windows.maxScale = 4.0;
  #     windows.distance.world.max = 10.0;
  #     windows.distance.theater.max = 12.0;
  #     # X button on the Steam window: back to the previous window, or
  #     # just the dashboard bar:
  #     steamCloseButton.enable = true;
  #     # Curvature per window: click the "Toggle Curvature" row of a
  #     # window's More Options menu (or its bar button) to toggle, drag
  #     # up/down to adjust (with controller haptics):
  #     windowCurvature.enable = true;
  #     # Long press a control under a window (or a three-dot menu row) to
  #     # move it between the bar and the three-dot menu:
  #     frameControls.enable = true;
  #   };
  #   # A 3D cat or dog in SteamVR's scene; "Pet" in the "+" menu (the
  #   # first switch bakes its models, about 0.5 GB):
  #   pet.enable = true;
  #   firefox.enable = true;             # launcher for the Firefox Flatpak
  #   # the Frame has no AV1 decoder: sites send VP9/H.264 (hardware):
  #   firefox.disableAv1 = true;
  #   firefox.defaultBrowser = true;     # default for http/https links
  #   # Hardware video decoding in the Jellyfin Desktop Flatpak (install
  #   # org.jellyfin.JellyfinDesktop yourself); gives it devices=all:
  #   jellyfin.hardwareDecoding.enable = true;
  #   # Apps that keep logins in the KDE wallet: one wallet for both
  #   # sessions (install the Signal Flatpak org.signal.Signal yourself):
  #   launchers."org.signal.Signal" = {
  #     keyring = { enable = true; electron = true; };
  #     # link callbacks:
  #     defaultFor = [ "x-scheme-handler/sgnl" "x-scheme-handler/signalcaptcha" ];
  #   };
  #   docker.enable = true;              # rootless Docker, user service
  # };
}
