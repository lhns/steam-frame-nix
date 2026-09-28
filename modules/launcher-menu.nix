# The VR dashboard's "+" menu (non-Steam programs). Steam lists them in GLib
# hash-table order (random-looking). Steam UI patches in SharedJSContext, each
# registered only when its option is set, reverted when unset (next switch):
# - order/: sorts ScanForInstalledNonSteamApps() by name;
# - pinned-desktop/: hides Desktop in the list, pins a proxy above/below it;
# - launch/: wraps LaunchNonSteamApp (menu-only) to close the menu and/or
#   debounce repeated launches;
# - grid/: programs as a grid of tiles, optionally maxRows visible;
# - show-all/: empties the list Steam hides without Developer Mode.
# Tested with Steam client 1790377368.
#
# iconFallbacks (not a patch): Steam resolves Icon= names only in hicolor (and
# pixmaps), so Breeze-only icons (Konsole, KDE System Settings) are missing.
# Home Manager links a fixed list of them from nixpkgs' Breeze into
# ~/.local/share/icons/hicolor/scalable/apps (a missing name fails the
# build); on switch, icon-fallbacks.sh --suggest only prints hints (names to
# add, names no longer needed), and hicolor's mtime is bumped when the list
# changed so a running Steam rescans. Until 2026-09 a script made the links
# on switch (removed by steam-frame-nix-cleanup, or before checkLinkTargets
# where Home Manager takes over). iconFallbacks was a list of names until
# 2026-09; a list fails with a pointer to enable/extra (until ~2026-12).
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.launcherMenu;
  inherit (import ./lib { inherit pkgs; }) mkPatch;
  sharedJSContext = { title = "SharedJSContext"; };

  iconSuggest = pkgs.writeShellApplication {
    name = "steam-frame-icon-fallbacks";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.gawk ];
    text = builtins.readFile ./launcher-menu/icon-fallbacks.sh;
  };

  breezeApps = "${pkgs.kdePackages.breeze-icons}/share/icons/breeze/apps";
  defaultIcons = [ "utilities-terminal" "preferences-system" ];
  icons = lib.optionals cfg.iconFallbacks.enable (lib.unique (defaultIcons ++ cfg.iconFallbacks.extra));
  # The largest Breeze app icon (all SVG); fails the build if there is none.
  breezeIcon = name: pkgs.runCommand "icon-fallback-${name}.svg" { } ''
    for size in 64 48 32 24 22 16; do
      if [ -e ${breezeApps}/$size/${name}.svg ]; then ln -s ${breezeApps}/$size/${name}.svg $out; exit 0; fi
    done
    echo "steamFrame.launcherMenu.iconFallbacks: Breeze has no app icon \"${name}\" (${breezeApps}/<size>/${name}.svg)" >&2
    exit 1
  '';
  iconDir = "${lib.removePrefix "${config.home.homeDirectory}/" config.xdg.dataHome}/icons/hicolor";
in {
  imports = [
    ./cleanup.nix
    ./steam-ui-patches.nix
    (lib.mkRenamedOptionModule
      [ "steamFrame" "launcherMenu" "launchDebounce" ]
      [ "steamFrame" "launcherMenu" "launchDebounceSeconds" ])
  ];

  options.steamFrame.launcherMenu = {
    sort = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Sort the "+" menu (non-Steam programs) by name. Steam UI patch.
      '';
    };
    pinDesktop = lib.mkOption {
      type = lib.types.nullOr (lib.types.enum [ "top" "bottom" ]);
      default = null;
      example = "bottom";
      description = ''
        Pin "Desktop" (the nested Plasma session) above ("top") or below
        ("bottom") the "+" menu's scrolling list, so it is always visible;
        null = normal list entry. Steam UI patch.
      '';
    };
    closeOnLaunch = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Close the "+" menu as soon as a program is launched (stock: it stays
        open until the window appears, inviting double launches). Steam UI
        patch.
      '';
    };
    launchDebounceSeconds = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      example = 10;
      description = ''
        Ignore another "+" menu launch of the same command line within this
        many seconds of the last one that went through (logged); 0 = off.
        Steam UI patch.
      '';
    };
    grid = {
      enable = lib.mkEnableOption ''
        the "+" menu's programs as a grid of tiles (icon, name below) instead
        of a list. Steam UI patch'';
      columns = lib.mkOption {
        type = lib.types.ints.between 1 8;
        default = 4;
        description = ''
          Tiles per row (the menu is 300 px wide: 3 → ~92 px tiles, 4 → ~68,
          5 → ~53).
        '';
      };
      maxRows = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        example = 4;
        description = ''
          Rows visible at once (the rest scrolls); null = up to the menu's
          stock max height (600 px).
        '';
      };
    };
    showAllApps = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        List all programs in the "+" menu without Developer Mode (Steam
        otherwise hides konsole, systemsettings, dolphin, plasma-discover, vlc,
        firewall-config, cmake-gui, qrenderdoc, lxterminal, sh). Developer Mode
        itself is untouched; hide single programs with
        steamFrame.launcherMenu.hiddenApps. Steam UI patch.
      '';
    };
    iconFallbacks = lib.mkOption {
      default = { };
      description = ''
        Hicolor links for program icons only Breeze has, so the "+" menu shows
        them (Steam looks only in hicolor).
      '';
      # Formerly a list of names: fail with a message instead (see assertion).
      type = lib.types.coercedTo (lib.types.listOf lib.types.str)
        (names: { legacyList = names; })
        (lib.types.submodule {
          options = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                Link nixpkgs' Breeze SVGs of utilities-terminal and
                preferences-system (SteamOS' Konsole and KDE System
                Settings) and of `extra` into
                ~/.local/share/icons/hicolor/scalable/apps (Home Manager
                links). Each switch prints hints: icons Steam can't find
                that Breeze has, and fallbacks hicolor has anyway.
              '';
            };
            extra = lib.mkOption {
              type = lib.types.listOf (lib.types.strMatching "[A-Za-z0-9._+-]+");
              default = [ ];
              example = [ "system-file-manager" ];
              description = ''
                Further Breeze app icon names to provide; a name Breeze
                doesn't have fails the build.
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

  config.xdg.dataFile = lib.listToAttrs (map (name: {
    name = "icons/hicolor/scalable/apps/${name}.svg";
    value.source = breezeIcon name;
  }) icons);

  # The script's links of 2026-09 where Home Manager links now.
  config.steamFrame.cleanup.migrateLinks = map (name: {
    path = "${iconDir}/scalable/apps/${name}.svg";
    target = "/nix/store/*-breeze-icons-*/share/icons/breeze/apps/*";
  }) icons;

  # GTK (Steam) rescans an icon theme only when a theme dir's mtime changes:
  # bump hicolor's when the links changed. After installPackages so the new
  # profile counts for the hints.
  config.home.activation.steamFrameIconFallbacks =
    lib.hm.dag.entryAfter [ "writeBoundary" "linkGeneration" "installPackages" ] (''
      apps=${lib.escapeShellArg "${iconDir}/scalable/apps"}
      if [[ -d $HOME/${lib.escapeShellArg iconDir} ]] &&
         [[ "$(ls "''${oldGenPath:-/nonexistent}/home-files/$apps" 2>/dev/null)" != "$(ls "$newGenPath/home-files/$apps" 2>/dev/null)" ]]; then
        run touch "$HOME"/${lib.escapeShellArg iconDir}
      fi
    '' + lib.optionalString cfg.iconFallbacks.enable ''
      BREEZE_APPS=${breezeApps} ${lib.getExe iconSuggest} --suggest ${lib.escapeShellArgs icons} || true
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
    ++ lib.optional (cfg.closeOnLaunch || cfg.launchDebounceSeconds > 0) {
      name = "launcher-menu-launch";
      target = sharedJSContext;
      patch = mkPatch {
        name = "launcher-menu-launch";
        src = ./launcher-menu/launch/patch.js;
        opts = { inherit (cfg) closeOnLaunch launchDebounceSeconds; };
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
