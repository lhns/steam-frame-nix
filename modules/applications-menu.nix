# Workaround (SteamOS 0.3.0, build 20260922): KDE apps build their app
# database (ksycoca) from "applications.menu", but SteamOS only ships
# /etc/xdg/menus/plasma-applications.menu. The nested desktop sets
# XDG_MENU_PREFIX=plasma-, the Steam session doesn't, so KDE apps started
# there (Dolphin from the "+" menu) know no apps. We link the user's
# applications.menu to Plasma's. A missing host file leaves a dangling link,
# which KDE treats like no file. Remove once the Steam session sets the prefix.
{ config, lib, ... }:
let
  sys = "/etc/xdg/menus/plasma-applications.menu";
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.session.applicationsMenu.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = ''
      Link `~/.config/menus/applications.menu` to Plasma's menu, so KDE apps
      in the Steam session find the installed apps.
    '';
  };

  config = lib.mkIf config.steamFrame.session.applicationsMenu.enable {
    xdg.configFile."menus/applications.menu".source =
      config.lib.file.mkOutOfStoreSymlink sys;
  };
}
