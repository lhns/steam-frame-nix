# Workaround for the Steam Frame image (SteamOS 0.3.0, build 20260922):
# the Steam session's xdg-desktop-portal gets XDG_DESKTOP_PORTAL_DIR pointing at
# /usr/share/xdg-desktop-portal/gamescope-portals, which contains the holo and
# gamescope backends but no gamescope-portals.conf (and no UseIn=). With that
# variable set, the portal only reads config from that dir, so it selects no
# backend and offers no OpenURI: no app in the Steam session can open links.
# Fix: our own portal dir = links to Valve's .portal files + a config.
# Remove once SteamOS ships a gamescope-portals.conf.
{ config, lib, ... }:
let
  sys = "/usr/share/xdg-desktop-portal/gamescope-portals";
  dir = "xdg-desktop-portal/gamescope-portals";
in {
  options.steamFrame.portalFix.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = ''
      Give the Steam session's xdg-desktop-portal a working config
      (gamescope-portals.conf) so apps there can open links (OpenURI).
    '';
  };

  config = lib.mkIf config.steamFrame.portalFix.enable {
    xdg.dataFile."${dir}/holo.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/holo.portal";
    xdg.dataFile."${dir}/gamescope.portal".source =
      config.lib.file.mkOutOfStoreSymlink "${sys}/gamescope.portal";
    xdg.dataFile."${dir}/gamescope-portals.conf".text = ''
      [preferred]
      default=holo;gamescope
    '';

    # Only affects the systemd-managed (outer) portal; the nested desktop's
    # portal is D-Bus-activated on its own bus and keeps using kde-portals.conf.
    xdg.configFile."systemd/user/xdg-desktop-portal.service.d/gamescope-portals.conf".text = ''
      [Service]
      Environment=XDG_DESKTOP_PORTAL_DIR=%h/.local/share/${dir}
    '';
  };
}
