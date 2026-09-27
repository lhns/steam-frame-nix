# The VR dashboard's "+" menu (non-Steam programs, #VRDashboard_LaunchNonSteamApp)
# lists programs in the order SteamClient.Apps.ScanForInstalledNonSteamApps()
# returns them: GLib hash-table order, effectively random, with "Desktop" (the
# nested Plasma session) somewhere in a scrolling list. Runtime patches of
# Steam's UI (steam-ui-patches.nix, evaluated in SharedJSContext), each
# registered only when its option is set:
# - order/: wraps ScanForInstalledNonSteamApps to sort the list by name;
# - pinned-desktop/: hides Desktop in the scrolling list and pins a copy above
#   or below it, with a separator; clicking the copy clicks the hidden
#   original;
# - launch/: wraps SteamClient.Apps.LaunchNonSteamApp (only called by this
#   menu) to close the menu right after a program is started, and/or to
#   ignore repeated launches of the same program within a few seconds (stock,
#   the menu stays open until the program's window appears, inviting double
#   launches);
# - grid/: restyles the programs section as a grid of tiles (icon, name
#   below), optionally limited to maxRows visible rows;
# - show-all/: empties the list of programs Steam hides without Developer
#   Mode (the webpack module holding it is found by signature).
# Options reach the patches through mkPatch's `opts`. All are reverted when
# turned off (next switch). Besides that one module, they depend on Steam UI
# internals such as React props, popup names and the scroll fade's classes
# and CSS; scripts/check-signatures.mjs checks all of them after a Steam
# update (lib/signatures.json). Tested with Steam client 1790377368.
#
# iconFallbacks is not a patch: Steam's scan of host programs resolves a
# desktop entry's Icon= name only in the hicolor icon theme (and pixmaps),
# so programs whose icon exists only in the desktop's Breeze theme (SteamOS'
# Konsole and KDE System Settings) have no icon in the menu. On every switch,
# launcher-menu/icon-fallbacks.sh looks through the desktop entries Steam
# sees and links the missing icons that nixpkgs' Breeze has into
# ~/.local/share/icons/hicolor (see the script). Until 2026-09 iconFallbacks
# was a list of names; setting a list now fails with a message pointing to
# enable/extra.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.launcherMenu;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
  sharedJSContext = { title = "SharedJSContext"; };

  iconFallbacks = pkgs.writeShellApplication {
    name = "steam-frame-icon-fallbacks";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.gawk ];
    text = builtins.readFile ./launcher-menu/icon-fallbacks.sh;
  };
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
        instead of a list. Runtime patch of Steam's UI (steamFrame.uiPatches)'';
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
    showAllApps = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        List all programs in the "+" menu without Steam's Developer Mode.
        Without it, Steam hides a fixed list (konsole, systemsettings,
        dolphin, plasma-discover, vlc, firewall-config, cmake-gui, qrenderdoc,
        lxterminal, sh). Only that list is emptied; the Developer Mode setting
        itself (used by other settings pages) is untouched. Hide individual
        programs with steamFrame.hiddenApps. Runtime patch of Steam's UI
        (steamFrame.uiPatches).
      '';
    };
    iconFallbacks = lib.mkOption {
      default = { };
      description = ''
        Hicolor fallbacks for program icons only the desktop's Breeze theme
        has, so the "+" menu shows them: Steam resolves program icons only in
        the hicolor theme.
      '';
      # The option used to be a list of icon names: keep a list from being
      # silently misread and fail with a message instead (see the assertion).
      type = lib.types.coercedTo (lib.types.listOf lib.types.str)
        (names: { legacyList = names; })
        (lib.types.submodule {
          options = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                On every switch, look through the desktop entries Steam sees
                (XDG data dirs, shadowed and Hidden/NoDisplay entries skipped)
                and, for each Icon= name no hicolor theme dir (or pixmaps)
                has but nixpkgs' Breeze app icons do (SteamOS: Konsole's
                utilities-terminal, KDE System Settings' preferences-system),
                link the Breeze SVG as
                ~/.local/share/icons/hicolor/scalable/apps/<name>.svg. Links
                no longer needed are removed; only links made by this option
                (listed in ~/.local/state/steam-frame-nix/icon-fallbacks) are
                ever touched. false removes them all.
              '';
            };
            extra = lib.mkOption {
              type = lib.types.listOf (lib.types.strMatching "[A-Za-z0-9._+-]+");
              default = [ ];
              example = [ "system-file-manager" ];
              description = ''
                Icon names to provide even if no desktop entry the scan sees
                uses them (still only if hicolor lacks them). A name Breeze
                has no app icon for is reported on switch and skipped.
              '';
            };
            legacyList = lib.mkOption {
              type = lib.types.nullOr (lib.types.listOf lib.types.str);
              default = null;
              internal = true;
              visible = false;
            };
          };
        });
    };
  };

  config.assertions = [ {
    assertion = cfg.iconFallbacks.legacyList == null;
    message = ''
      steamFrame.launcherMenu.iconFallbacks is no longer a list of icon names
      (set to ${builtins.toJSON cfg.iconFallbacks.legacyList}). Use
        iconFallbacks.enable = true;   # default: utilities-terminal, preferences-system
        iconFallbacks.extra = [ ... ]; # further names
      or iconFallbacks.enable = false; for none (what [ ] used to mean).
    '';
  } ];

  # After installPackages, so the new profile's desktop entries and icons count.
  # Disabled, the script removes its links (no BREEZE_APPS).
  config.home.activation.steamFrameIconFallbacks =
    lib.hm.dag.entryAfter [ "writeBoundary" "installPackages" ] (
      if cfg.iconFallbacks.enable then ''
        run env BREEZE_APPS=${pkgs.kdePackages.breeze-icons}/share/icons/breeze/apps \
          ${lib.getExe iconFallbacks} ${lib.escapeShellArgs cfg.iconFallbacks.extra}
      '' else ''
        run ${lib.getExe iconFallbacks}
      '');

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
    }
    ++ lib.optional cfg.showAllApps {
      name = "launcher-menu-show-all";
      target = sharedJSContext;
      patch = mkPatch {
        name = "launcher-menu-show-all";
        src = ./launcher-menu/show-all/patch.js;
      };
      unpatch = ./launcher-menu/show-all/unpatch.js;
    };
}
