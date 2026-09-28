# Hide desktop entries from the "+" menu and the KDE menu: a user entry with
# Hidden=true masks the system one.
{ config, lib, ... }: {
  imports = [
    ./cleanup.nix
    (lib.mkRenamedOptionModule
      [ "steamFrame" "hiddenApps" ] [ "steamFrame" "launcherMenu" "hiddenApps" ])
  ];

  options.steamFrame.launcherMenu.hiddenApps = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    example = [ "lxterminal" "cmake-gui" "firewall-config" "renderdoc" ];
    description = ''
      Desktop entry ids (without .desktop) to hide from the "+" menu and the
      KDE menu.
    '';
  };

  config.xdg.dataFile = lib.genAttrs
    (map (id: "applications/${id}.desktop") config.steamFrame.launcherMenu.hiddenApps)
    (_: {
      text = ''
        [Desktop Entry]
        Hidden=true
      '';
    });
}
