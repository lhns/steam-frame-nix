# Launchers for apps that keep secrets in the KDE wallet, so both sessions
# share them.
# - One kwalletd6, on the outer bus: the nested desktop has its own D-Bus,
#   where an app would start a second kwalletd6 whose secrets the Steam
#   session never sees. The launchers run with session.busEnv.
# - Electron picks its keyring from XDG_CURRENT_DESKTOP; in the Steam session
#   (gamescope) it falls back to "basic" (a local file) and the login made in
#   the desktop is gone. `electron` passes --password-store=kwallet6.
# - Flatpaks: the wallet's D-Bus names (kwalletd6 and the Secret Service,
#   served by ksecretd) as `flatpak run --talk-name` options, not Flatpak
#   override files: they apply only to launches from the entry and are gone
#   with it.
# - schemeHandlers: login callbacks (claude://, io.element.desktop://) go
#   through the portal, which opens an app chooser (invisible in VR) unless
#   the app is the default and a recommended handler (Added Associations).
# Each entry is written to ~/.local/share/applications with the app's own
# desktop ID: it shadows the Flatpak's/package's entry and is seen by the "+"
# menu (which reads only that directory).
{ config, lib, ... }:
let
  cfg = config.steamFrame.keyring;
  busEnv = config.steamFrame.session.busEnv;

  walletNames = [ "org.kde.kwalletd6" "org.freedesktop.secrets" ];

  actionModule = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.str;
        description = "Name of the action (Name=).";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ ''"claude://claude.ai/new"'' ];
        description = ''
          Arguments after the app's (in desktop entry Exec syntax: quote
          yourself).
        '';
      };
    };
  };

  # Shared by flatpaks and programs; `flatpak` switches the defaults and the
  # command.
  appModule = flatpak: { name, config, ... }: {
    options = {
      name = lib.mkOption {
        type = lib.types.str;
        example = "Element";
        description = "Name shown in menus (Name=).";
      };
      genericName = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "GenericName=.";
      };
      comment = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Comment=.";
      };
      icon = lib.mkOption ({
        type = lib.types.nullOr lib.types.str;
        default = if flatpak then name else null;
        description = "Icon name (Icon=).";
      } // lib.optionalAttrs flatpak { defaultText = lib.literalMD "the app ID"; });
      categories = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "Network" "InstantMessaging" ];
        description = "Categories=.";
      };
      startupWMClass = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "StartupWMClass=.";
      };
      mimeTypes = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "x-scheme-handler/rdp" ];
        description = ''
          Further MIME types listed in the entry (MimeType=), without making
          the app their default.
        '';
      };
      schemeHandlers = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "element" "io.element.desktop" ];
        description = ''
          URL schemes (without `x-scheme-handler/`) the app handles and is
          made the default and a recommended handler for, e.g. login
          callbacks: otherwise the portal asks with an app chooser, which
          isn't shown in VR. Listed in MimeType= too.
        '';
      };
      electron = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Pass `--password-store=kwallet6`: Electron picks its keyring from
          XDG_CURRENT_DESKTOP and in the Steam session (gamescope) would use
          an unencrypted local store instead of the wallet.
        '';
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          Further arguments to the app (desktop entry Exec syntax), before
          the field code.
        '';
      };
      fieldCode = lib.mkOption {
        type = lib.types.enum [ "%U" "%u" "%F" "%f" "" ];
        default = "%U";
        description = ''
          How the entry passes URLs/files: `%U` several URLs, `%u` one,
          `%F`/`%f` local files, `""` none.
        '';
      };
      actions = lib.mkOption {
        type = lib.types.attrsOf actionModule;
        default = { };
        example = lib.literalExpression
          ''{ NewChat = { name = "New Chat"; args = [ '''"claude://claude.ai/new"''' ]; }; }'';
        description = ''
          Desktop actions (right-click menu entries); each runs the command
          with its args.
        '';
      };
      settings = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = { StartupNotify = "true"; Keywords = "Matrix;chat;"; };
        description = "Further keys of the [Desktop Entry] group.";
      };
      command = lib.mkOption {
        type = lib.types.str;
        readOnly = true;
        description = ''
          The command line the entry runs, without args and field code (for
          a terminal).
        '';
      };
    } // lib.optionalAttrs flatpak {
      flatpakArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "--branch=stable" "--command=/app/bin/element" ];
        description = "Further `flatpak run` options.";
      };
    } // lib.optionalAttrs (!flatpak) {
      executable = lib.mkOption {
        type = lib.types.str;
        example = lib.literalExpression ''"''${pkgs.claude-desktop}/bin/claude-desktop"'';
        description = "The program to run (a path, e.g. into a package).";
      };
    };

    config.command = lib.concatStringsSep " " ([ busEnv ]
      ++ (if flatpak
          then [ "flatpak run" ] ++ map (n: "--talk-name=${n}") walletNames
            ++ config.flatpakArgs ++ [ name ]
          else [ config.executable ])
      ++ lib.optional config.electron "--password-store=kwallet6");
  };

  entry = id: app: let
    exec = args: lib.concatStringsSep " " ([ app.command ] ++ args);
    mime = map (s: "x-scheme-handler/${s}") app.schemeHandlers ++ app.mimeTypes;
    list = xs: lib.concatMapStrings (x: "${x};") xs;
    line = k: v: lib.optionalString (v != null && v != "") "${k}=${v}\n";
  in ''
    [Desktop Entry]
    Type=Application
  '' + line "Name" app.name
    + line "GenericName" app.genericName
    + line "Comment" app.comment
    + line "Icon" app.icon
    + line "Exec" (exec (app.args ++ lib.optional (app.fieldCode != "") app.fieldCode))
    + line "StartupWMClass" app.startupWMClass
    + line "Categories" (list app.categories)
    + line "MimeType" (list mime)
    + line "Actions" (list (lib.attrNames app.actions))
    + line "X-Flatpak" (if app ? flatpakArgs then id else null)
    + lib.concatStrings (lib.mapAttrsToList line app.settings)
    + lib.concatStrings (lib.mapAttrsToList (a: act: ''

    [Desktop Action ${a}]
    Name=${act.name}
    Exec=${exec act.args}
  '') app.actions);

  apps = cfg.flatpaks // cfg.programs;
  handlers = lib.concatLists (lib.mapAttrsToList (id: app:
    map (s: lib.nameValuePair "x-scheme-handler/${s}" "${id}.desktop") app.schemeHandlers) apps);
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.keyring = {
    flatpaks = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule (appModule true));
      default = { };
      example = lib.literalExpression ''
        {
          "im.riot.Riot" = {
            name = "Element";
            electron = true;
            schemeHandlers = [ "element" "io.element.desktop" ];
          };
          "org.kde.krdc" = { name = "KRDC"; fieldCode = "%u"; };
        }
      '';
      description = ''
        Flatpaks (by app ID) that keep secrets in the KDE wallet: a desktop
        entry shadowing the Flatpak's runs it on the outer bus, allowed to
        talk to the wallet (`flatpak run --talk-name=...`).
      '';
    };
    programs = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule (appModule false));
      default = { };
      example = lib.literalExpression ''
        {
          "com.anthropic.Claude" = {
            name = "Claude";
            executable = "''${pkgs.claude-desktop}/bin/claude-desktop";
            icon = "claude-desktop";
            electron = true;
            schemeHandlers = [ "claude" ];
          };
        }
      '';
      description = ''
        Other programs (e.g. from Nix packages), by desktop ID without
        `.desktop` (use the package's own, so the entry replaces it): a
        desktop entry that runs them on the outer bus.
      '';
    };
  };

  config = lib.mkIf (apps != { }) {
    assertions = map (id: {
      assertion = false;
      message = "steamFrame.keyring: \"${id}\" is in both flatpaks and programs.";
    }) (lib.intersectLists (lib.attrNames cfg.flatpaks) (lib.attrNames cfg.programs));

    xdg.dataFile = lib.mapAttrs' (id: app:
      lib.nameValuePair "applications/${id}.desktop" { text = entry id app; }) apps;

    xdg.mimeApps = lib.mkIf (handlers != [ ]) {
      enable = true;
      defaultApplications = lib.listToAttrs handlers;
      associations.added = lib.listToAttrs handlers;
    };
  };
}
