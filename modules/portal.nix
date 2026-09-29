# Workaround (SteamOS 0.3.0, build 20260922): the Steam session's portal dir
# /usr/share/xdg-desktop-portal/gamescope-portals has backends but no
# gamescope-portals.conf, so no backend is selected and there is no OpenURI
# (links don't open). We point it at our own dir: Valve's .portal files + a
# config. Remove once SteamOS ships the .conf.
# Neither Valve backend has a FileChooser, so sandboxed apps fall back to an
# in-sandbox dialog that can't see home; fileChooser adds KDE's for it.
{ config, lib, ... }:
let
  cfg = config.steamFrame.session.portalFix;
  sys = "/usr/share/xdg-desktop-portal/gamescope-portals";
  dir = "xdg-desktop-portal/gamescope-portals";
in {
  imports = [
    ./cleanup.nix
    (lib.mkRenamedOptionModule
      [ "steamFrame" "portalFix" "enable" ]
      [ "steamFrame" "session" "portalFix" "enable" ])
  ];

  options.steamFrame.session.portalFix = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Give the Steam session's xdg-desktop-portal a config so apps there can
        open links (OpenURI).
      '';
    };
    fileChooser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Use KDE's file dialog (xdg-desktop-portal-kde) as the Steam session's
        FileChooser portal, so sandboxed apps (Flatpak) can open and save
        files outside their sandbox. Needs `enable`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    xdg.dataFile."${dir}/holo.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/holo.portal";
    xdg.dataFile."${dir}/gamescope.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/gamescope.portal";
    xdg.dataFile."${dir}/kde.portal" = lib.mkIf cfg.fileChooser {
      source = config.lib.file.mkOutOfStoreSymlink
        "/usr/share/xdg-desktop-portal/portals/kde.portal";
    };
    xdg.dataFile."${dir}/gamescope-portals.conf".text = ''
      [preferred]
      default=holo;gamescope
    '' + lib.optionalString cfg.fileChooser ''
      org.freedesktop.impl.portal.FileChooser=kde
    '';

    # Outer (systemd) portal only; the nested desktop's keeps kde-portals.conf.
    xdg.configFile."systemd/user/xdg-desktop-portal.service.d/gamescope-portals.conf".text = ''
      [Service]
      Environment=XDG_DESKTOP_PORTAL_DIR=%h/.local/share/${dir}
    '';
  };
}
