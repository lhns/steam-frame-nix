# Workaround (SteamOS 0.3.0, build 20260922): the Steam session's portal dir
# /usr/share/xdg-desktop-portal/gamescope-portals has backends but no
# gamescope-portals.conf, so no backend is selected and there is no OpenURI
# (links don't open). We point it at our own dir: Valve's .portal files + a
# config. Remove once SteamOS ships the .conf.
{ config, lib, ... }:
let
  sys = "/usr/share/xdg-desktop-portal/gamescope-portals";
  dir = "xdg-desktop-portal/gamescope-portals";
in {
  imports = [
    (lib.mkRenamedOptionModule
      [ "steamFrame" "portalFix" "enable" ]
      [ "steamFrame" "session" "portalFix" "enable" ])
  ];

  options.steamFrame.session.portalFix.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = ''
      Give the Steam session's xdg-desktop-portal a config so apps there can
      open links (OpenURI).
    '';
  };

  config = lib.mkIf config.steamFrame.session.portalFix.enable {
    xdg.dataFile."${dir}/holo.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/holo.portal";
    xdg.dataFile."${dir}/gamescope.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/gamescope.portal";
    xdg.dataFile."${dir}/gamescope-portals.conf".text = ''
      [preferred]
      default=holo;gamescope
    '';

    # Outer (systemd) portal only; the nested desktop's keeps kde-portals.conf.
    xdg.configFile."systemd/user/xdg-desktop-portal.service.d/gamescope-portals.conf".text = ''
      [Service]
      Environment=XDG_DESKTOP_PORTAL_DIR=%h/.local/share/${dir}
    '';
  };
}
