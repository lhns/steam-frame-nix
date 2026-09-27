# The VR dashboard's "+" menu (non-Steam programs, #VRDashboard_LaunchNonSteamApp)
# lists programs in the order SteamClient.Apps.ScanForInstalledNonSteamApps()
# returns them: GLib hash-table order, effectively random, with "Desktop" (the
# nested Plasma session) somewhere in a scrolling list. Two runtime patches of
# Steam's UI (steam-ui-patches.nix, evaluated in SharedJSContext) fix that:
# - order/: wraps ScanForInstalledNonSteamApps to sort the list by name;
# - pinned-desktop/: hides Desktop in the scrolling list and pins a copy above
#   or below it, with a separator; clicking the copy clicks the hidden
#   original. The position is passed by calling the patch's function.
# - launch/: wraps SteamClient.Apps.LaunchNonSteamApp (only called by this
#   menu) to close the menu right after a program is started, and/or to
#   ignore repeated launches of the same program within a few seconds (stock,
#   the menu stays open until the program's window appears, inviting double
#   launches). Options are passed by calling the patch's function.
# - grid/: restyles the programs section as a grid of tiles (icon, name
#   below), optionally limited to maxRows visible rows.
# All are reverted when turned off (next switch).
# Depends on Steam UI internals (React props, popup names, the scroll fade's
# classes and CSS), not on webpack module ids; scripts/check-signatures.mjs
# checks them after a Steam update (lib/signatures.json). Tested with Steam
# client 1790377368.
#
# iconFallbacks is not a patch: Steam's scan of host programs resolves a
# desktop entry's Icon= name only in the hicolor icon theme (and pixmaps),
# so programs whose icon exists only in the desktop's Breeze theme (SteamOS'
# Konsole and KDE System Settings) have no icon in the menu. Hicolor copies
# from nixpkgs' Breeze are installed into the profile (~/.nix-profile/share
# is on Steam's XDG_DATA_DIRS).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.launcherMenu;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
  sharedJSContext = { title = "SharedJSContext"; };

  # Largest Breeze app icon (all are SVG) as hicolor/scalable/apps/<name>.svg.
  breezeApps = "${pkgs.kdePackages.breeze-icons}/share/icons/breeze/apps";
  iconFallbacks = pkgs.runCommand "launcher-menu-icon-fallbacks" { } ''
    dir=$out/share/icons/hicolor/scalable/apps
    mkdir -p $dir
    for name in ${lib.escapeShellArgs cfg.iconFallbacks}; do
      src=
      for size in 64 48 32 24 22 16; do
        if [ -e "${breezeApps}/$size/$name.svg" ]; then src="${breezeApps}/$size/$name.svg"; break; fi
      done
      if [ -z "$src" ]; then
        echo "steamFrame.launcherMenu.iconFallbacks: no Breeze app icon \"$name\" (${breezeApps}/<size>/$name.svg)" >&2
        exit 1
      fi
      cp -L "$src" "$dir/$name.svg"
    done
  '';
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
    closeOnLaunch = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Close the "+" menu as soon as a program in it is activated (pointer,
        controller or the pinned Desktop entry). Stock, it stays open until the
        program's window appears, so it looks as if the click did nothing and
        programs get launched twice. Runtime patch of Steam's UI
        (steamFrame.uiPatches); off by default like the other launcherMenu
        options, so nothing is injected unless asked for.
      '';
    };
    launchDebounce = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      example = 10;
      description = ''
        Seconds during which another launch of the same program (same command
        line) from the "+" menu is ignored, counted from the last launch that
        went through; ignored launches are logged (steam-ui-patches journal).
        0 disables it. Runtime patch of Steam's UI (steamFrame.uiPatches).
      '';
    };
    grid = {
      enable = lib.mkEnableOption ''
        the "+" menu's programs as a grid of tiles (large icon, name below)
        instead of a list. Runtime patch of Steam's UI (steamFrame.uiPatches)
      '';
      columns = lib.mkOption {
        type = lib.types.ints.between 1 8;
        default = 4;
        description = ''
          Tiles per row. The menu popup is a fixed 300 px wide: 3 columns give
          tiles of about 92 px, 4 about 68 px, 5 about 53 px.
        '';
      };
      maxRows = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        example = 4;
        description = ''
          Rows of tiles visible at once: the menu shrinks to that many rows and
          the rest scrolls. null: the grid fills up to the menu's stock maximum
          height (600 px).
        '';
      };
    };
    iconFallbacks = lib.mkOption {
      type = lib.types.listOf (lib.types.strMatching "[A-Za-z0-9._+-]+");
      default = [ "utilities-terminal" "preferences-system" ];
      example = [ "utilities-terminal" "preferences-system" "system-file-manager" ];
      description = ''
        Icon names (Icon= of desktop entries) installed as hicolor icons,
        copied from nixpkgs' Breeze app icons, so the "+" menu shows them:
        Steam resolves program icons only in the hicolor theme, not in the
        desktop's Breeze theme. The default covers the entries SteamOS ships
        whose icons exist only in Breeze: Konsole (utilities-terminal) and
        KDE System Settings (preferences-system). A name Breeze has no app
        icon for fails the build, naming it. [] installs nothing. Steam
        picks up new icons only after a restart.
      '';
    };
  };

  config.home.packages = lib.optional (cfg.iconFallbacks != [ ]) iconFallbacks;

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
      patch = mkPatch {
        name = "launcher-menu-pinned-desktop";
        src = ./launcher-menu/pinned-desktop/patch.js;
        opts.position = cfg.pinDesktop;
      };
      unpatch = ./launcher-menu/pinned-desktop/unpatch.js;
    }
    ++ lib.optional (cfg.closeOnLaunch || cfg.launchDebounce > 0) {
      name = "launcher-menu-launch";
      target = sharedJSContext;
      patch = mkPatch {
        name = "launcher-menu-launch";
        src = ./launcher-menu/launch/patch.js;
        opts = {
          inherit (cfg) closeOnLaunch;
          debounceSeconds = cfg.launchDebounce;
        };
      };
      unpatch = ./launcher-menu/launch/unpatch.js;
    }
    ++ lib.optional cfg.grid.enable {
      name = "launcher-menu-grid";
      target = sharedJSContext;
      patch = mkPatch {
        name = "launcher-menu-grid";
        src = ./launcher-menu/grid/patch.js;
        opts = { inherit (cfg.grid) columns maxRows; };
      };
      unpatch = ./launcher-menu/grid/unpatch.js;
    };
}
