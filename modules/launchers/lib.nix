# Pieces of steamFrame.launchers (launchers.nix) that the check
# (check.nix) uses too: the per-launcher option type, Exec quoting, the
# rewrite environment, the build-time entry of a package and the runtime
# generator.
{ lib, pkgs }:
let
  walletNames = [ "org.kde.kwalletd6" "org.freedesktop.secrets" ];

  # One argument in desktop entry Exec syntax (key-file escaping of the whole
  # value is rewrite.awk's): quoted when it has characters outside a safe
  # set, with " ` $ \ escaped; % doubled (field codes).
  quoteExec = s:
    let
      q = if builtins.match "[A-Za-z0-9_/.:,=+@-]+" s != null then s
        else "\"" + lib.replaceStrings [ "\\" "\"" "`" "$" ] [ "\\\\" "\\\"" "\\`" "\\$" ] s + "\"";
    in lib.replaceStrings [ "%" ] [ "%%" ] q;
  execLine = args: lib.concatMapStringsSep " " quoteExec args;

  envArgs = env: lib.mapAttrsToList (k: v: "${k}=${v}") env;
  envPrefix = env: lib.optionals (env != { }) ([ "env" ] ++ envArgs env);

  # "flatpak" | "package" | "file"
  kindOf = l: if l.source.package != null then "package"
    else if l.source.file != null then "file" else "flatpak";
in rec {
  inherit quoteExec execLine walletNames kindOf;

  # The option type of one launcher; `bus` is session.bus.
  launcherModule = { bus }: { name, config, ... }: let
    flatpak = kindOf config == "flatpak";
  in {
    options = {
      source = {
        flatpak = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          defaultText = lib.literalMD "the desktop ID, when neither `package` nor `file` is set";
          example = "org.mozilla.firefox";
          description = ''
            Flatpak app ID whose exported entry
            (`~/.local/share/flatpak/exports/share/applications/<ID>.desktop`,
            then `/var/lib/flatpak/...`) is rewritten at runtime.
          '';
        };
        package = lib.mkOption {
          type = lib.types.nullOr lib.types.package;
          default = null;
          example = lib.literalExpression "pkgs.signal-desktop";
          description = ''
            Nix package whose `share/applications/<desktop ID>.desktop` is
            rewritten at build time (the build fails if it has none).
          '';
        };
        file = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/usr/share/applications/org.kde.konsole.desktop";
          description = "Desktop entry on the host, rewritten at runtime.";
        };
      };
      hostEnv = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = { DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus"; };
        description = ''
          Environment of the process the entry starts (`env K=V` before the
          command): for a Flatpak, of the `flatpak` client, so e.g. its
          sandbox's D-Bus proxy and portals use that bus.
        '';
      };
      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = { MOZ_ENABLE_WAYLAND = "0"; };
        description = ''
          Environment of the app: `flatpak run --env=K=V` for a Flatpak, like
          `hostEnv` otherwise.
        '';
      };
      flatpakArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "--device=all" ];
        description = "Further `flatpak run` options, before the app ID (Flatpaks only).";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "--ozone-platform=x11" ];
        description = ''
          Arguments right after the app ID / program, before the entry's own
          (plain strings, quoted for you).
        '';
      };
      wrappers = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = lib.literalExpression ''[ "''${pkgs.writeShellScript "wrap" "exec \"$@\""}" ]'';
        description = ''
          Commands the entry's command line is passed to, outermost first:
          `Exec=<wrappers> <original command>` (each gets the full command
          line as its arguments).
        '';
      };
      mimeTypes = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "x-scheme-handler/rdp" ];
        description = "Added to the entry's `MimeType=`, without making the app their default.";
      };
      defaultFor = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "x-scheme-handler/sgnl" "x-scheme-handler/signalcaptcha" ];
        description = ''
          MIME types / `x-scheme-handler/<scheme>` the app becomes the default
          and a recommended handler for (`xdg.mimeApps`, Added Associations:
          the portal then opens them without an app chooser, which VR doesn't
          show); added to `MimeType=` too.
        '';
      };
      settings = lib.mkOption {
        type = lib.types.attrsOf (lib.types.nullOr lib.types.str);
        default = { };
        example = { Name = "Signal (wallet)"; Keywords = null; };
        description = ''
          `[Desktop Entry]` keys to set or override (value in key-file syntax,
          as given); `null` removes a key. Either way the key's localized
          variants (`Name[de]=`) are dropped.
        '';
      };
      keyring = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Keep the app's secrets in the one KDE wallet of both sessions: run
            it on the outer bus (`hostEnv.DBUS_SESSION_BUS_ADDRESS`); a
            Flatpak also gets `--talk-name=org.kde.kwalletd6
            --talk-name=org.freedesktop.secrets`.
          '';
        };
        electron = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Pass `--password-store=kwallet6` (Electron apps: in the Steam
            session they'd use an unencrypted local store). Needs
            `keyring.enable`.
          '';
        };
      };
      command = lib.mkOption {
        type = lib.types.str;
        readOnly = true;
        description = ''
          Approximately the command the entry runs, for a terminal (without
          the entry's own options such as `--branch` or `--command`).
        '';
      };
    };

    config = {
      hostEnv = lib.mkIf config.keyring.enable { DBUS_SESSION_BUS_ADDRESS = bus; };
      flatpakArgs = lib.mkIf (config.keyring.enable && flatpak)
        (lib.mkBefore (map (n: "--talk-name=${n}") walletNames));
      args = lib.mkIf config.keyring.electron (lib.mkBefore [ "--password-store=kwallet6" ]);
      command = command (config // { id = name; });
    };
  };

  flatpakIdOf = l: if l.source.flatpak != null then l.source.flatpak else l.id;

  # Approximate shell command of a launcher (attrs as the option, plus `id`).
  command = l: let
    kind = kindOf l;
    pkg = l.source.package;
  in lib.escapeShellArgs (
    envPrefix (l.hostEnv // lib.optionalAttrs (kind != "flatpak") l.env)
    ++ l.wrappers
    ++ (if kind == "flatpak" then
          [ "flatpak" "run" ] ++ l.flatpakArgs ++ map (e: "--env=${e}") (envArgs l.env) ++ [ (flatpakIdOf l) ]
        else if kind == "package" then
          [ "${pkg}/bin/${pkg.meta.mainProgram or (lib.getName pkg)}" ]
        else [ "<program of ${l.source.file}>" ])
    ++ l.args);

  # The environment of rewrite.awk for a launcher (without SFN_SOURCE).
  rewriteEnv = l: let flatpak = kindOf l == "flatpak"; in {
    SFN_MODE = if flatpak then "flatpak" else "program";
    SFN_FLATPAK_ID = if flatpak then flatpakIdOf l else "";
    SFN_PREFIX = execLine (envPrefix (l.hostEnv // lib.optionalAttrs (!flatpak) l.env) ++ l.wrappers);
    SFN_FLATPAK_ARGS = lib.optionalString flatpak
      (execLine (l.flatpakArgs ++ map (e: "--env=${e}") (envArgs l.env)));
    SFN_ARGS = execLine l.args;
    SFN_MIME = lib.concatMapStrings (m: "${m};") (lib.unique (l.mimeTypes ++ l.defaultFor));
    SFN_SETTINGS = lib.concatStrings (lib.mapAttrsToList
      (k: v: if v == null then "${k}\n" else "${k}=${v}\n") l.settings);
  };

  # Build time: the package's entry, rewritten.
  packageEntry = l: let
    src = "${l.source.package}/share/applications/${l.id}.desktop";
  in pkgs.runCommand "${l.id}.desktop" ({
    nativeBuildInputs = [ pkgs.gawk ];
    preferLocalBuild = true;
    allowSubstitutes = false;
    SFN_SOURCE = src;
  } // rewriteEnv l) ''
    if [ ! -f ${lib.escapeShellArg src} ]; then
      echo "steamFrame.launchers.\"${l.id}\": ${l.source.package} has no share/applications/${l.id}.desktop" >&2
      exit 1
    fi
    LC_ALL=C gawk -f ${./rewrite.awk} "$SFN_SOURCE" "$SFN_SOURCE" > $out || {
      echo "steamFrame.launchers.\"${l.id}\": can't rewrite $SFN_SOURCE" >&2
      exit 1
    }
  '';

  # Runtime: the steam-frame-nix-launchers command for the Flatpak/file
  # `launchers` (attrs of launchers with `id`); the dirs can be overridden
  # with STEAM_FRAME_NIX_{RUNTIME_DIR,APPLICATIONS_DIR,FLATPAK_EXPORTS}.
  generator = { launchers, runtimeDir, exportDirs, applicationsDir }: let
    spec = pkgs.linkFarm "steam-frame-nix-launchers-spec" (lib.mapAttrsToList (id: l: {
      name = id;
      path = pkgs.writeText "steam-frame-nix-launcher-${id}" (lib.toShellVars (rewriteEnv l // {
        SFN_FILE = if kindOf l == "file" then l.source.file else "";
      }));
    }) launchers);
  in pkgs.writeShellApplication {
    name = "steam-frame-nix-launchers";
    runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.util-linux ];
    text = ''
      spec=${spec}
      awk_script=${./rewrite.awk}
      runtime=''${STEAM_FRAME_NIX_RUNTIME_DIR:-${lib.escapeShellArg runtimeDir}}
      apps=''${STEAM_FRAME_NIX_APPLICATIONS_DIR:-${lib.escapeShellArg applicationsDir}}
      exports=''${STEAM_FRAME_NIX_FLATPAK_EXPORTS:-${lib.escapeShellArg (lib.concatStringsSep ":" exportDirs)}}
    '' + builtins.readFile ./generate.sh;
  };
}
