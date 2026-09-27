# The VR dashboard's "+" menu (non-Steam programs, #VRDashboard_LaunchNonSteamApp)
# lists programs in the order SteamClient.Apps.ScanForInstalledNonSteamApps()
# returns them: GLib hash-table order, effectively random, with "Desktop" (the
# nested Plasma session) somewhere in a scrolling list. Two runtime patches of
# Steam's UI (steam-ui-patches.nix, evaluated in SharedJSContext) fix that:
# - order/: wraps ScanForInstalledNonSteamApps to sort the list by name;
# - pinned-desktop/: hides Desktop in the scrolling list and pins a copy above
#   or below it, with a separator; clicking the copy clicks the hidden
#   original. The position is passed by calling the patch's function.
# Both are reverted when turned off (next switch).
# Depends on Steam UI internals; tested with Steam client 1790377368.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.launcherMenu;
  sharedJSContext = { title = "SharedJSContext"; };
in {
  imports = [ ./steam-ui-patches.nix ];

  options.steamFrame.launcherMenu = {
    sort = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Sort the VR dashboard's "+" menu (non-Steam programs) alphabetically
        instead of Steam's random-looking order. Runtime patch of Steam's UI
        (steamFrame.uiPatches).
      '';
    };
    pinDesktop = lib.mkOption {
      type = lib.types.nullOr (lib.types.enum [ "top" "bottom" ]);
      default = null;
      example = "bottom";
      description = ''
        Pin "Desktop" (the nested Plasma session) above ("top", below the
        menu heading) or below ("bottom") the scrolling program list of the
        "+" menu, separated by a thin line, so it is always visible; it is
        hidden in the list itself. null leaves it a normal list entry. Runtime
        patch of Steam's UI (steamFrame.uiPatches).
      '';
    };
  };

  config.steamFrame.uiPatches.patches =
    lib.optional cfg.sort {
      name = "launcher-menu-order";
      target = sharedJSContext;
      patch = ./launcher-menu/order/patch.js;
      unpatch = ./launcher-menu/order/unpatch.js;
    }
    ++ lib.optional (cfg.pinDesktop != null) {
      name = "launcher-menu-pinned-desktop";
      target = sharedJSContext;
      patch = pkgs.writeText "launcher-menu-pinned-desktop.js" ''
        (${builtins.readFile ./launcher-menu/pinned-desktop/patch.js})(${builtins.toJSON { position = cfg.pinDesktop; }})
      '';
      unpatch = ./launcher-menu/pinned-desktop/unpatch.js;
    };
}
