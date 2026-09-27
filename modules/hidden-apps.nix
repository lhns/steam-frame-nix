# Hide system apps from menus, including the Steam session's "+" menu (with
# Developer Mode on, or launcherMenu.showAllApps, it lists every desktop entry
# GLib would show). A user
# entry with Hidden=true in ~/.local/share/applications masks the one in
# /usr/share/applications. Also hides them from the nested desktop's KDE menu.
{ config, lib, ... }: {
  options.steamFrame.hiddenApps = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    example = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
    description = "Desktop entry ids (without .desktop) to hide from the \"+\" menu and the KDE menu.";
  };

  config.xdg.dataFile = lib.genAttrs
    (map (id: "applications/${id}.desktop") config.steamFrame.hiddenApps)
    (_: {
      text = ''
        [Desktop Entry]
        Hidden=true
      '';
    });
}
