# Launchers (launchers.<desktop ID>, docs/launchers.md): the app's own desktop
# entry, rewritten (launchers/rewrite.awk), under the same desktop ID in
# ~/.local/share/applications. Package entries are rewritten at build time;
# Flatpak and host file entries only exist at runtime, so
# steam-frame-nix-launchers (launchers/generate.sh) writes them to
# <session.runtimeDir>/steam-frame-nix/applications (tmpfs), where the Home
# Manager links point. Replaces the keyring module (steamFrame.keyring.*),
# whose options fail with the new form.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.launchers;
  session = config.steamFrame.session;
  L = import ./launchers/lib.nix { inherit lib pkgs; };

  all = lib.mapAttrs (id: l: l // { inherit id; }) cfg;
  runtimeLaunchers = lib.filterAttrs (_: l: L.kindOf l != "package") all;
  packageLaunchers = lib.filterAttrs (_: l: L.kindOf l == "package") all;

  outDir = "${session.runtimeDir}/steam-frame-nix/applications";
  exportDirs = [
    "${config.xdg.dataHome}/flatpak/exports/share/applications"
    "/var/lib/flatpak/exports/share/applications"
  ];
  generator = L.generator {
    launchers = runtimeLaunchers;
    runtimeDir = session.runtimeDir;
    applicationsDir = "${config.xdg.dataHome}/applications";
    inherit exportDirs;
  };
  exe = lib.getExe generator;

  defaults = lib.concatLists (lib.mapAttrsToList (id: l:
    map (m: { inherit m id; }) (lib.unique l.defaultFor)) all);
  byMime = lib.groupBy (d: d.m) defaults;
  mimeAttrs = lib.mapAttrs (_: ds: "${(lib.head ds).id}.desktop") byMime;

  removed = what: lib.mkRemovedOptionModule [ "steamFrame" "keyring" what ] ''
    Keyring launchers are now steamFrame.launchers.<desktop ID>, made from the
    app's own desktop entry (name, icon, actions come from it), e.g.
      steamFrame.launchers."im.riot.Riot" = {
        keyring = { enable = true; electron = true; };
        defaultFor = [ "x-scheme-handler/element" "x-scheme-handler/io.element.desktop" ];
      };
      steamFrame.launchers."com.anthropic.Claude" = {
        source.package = pkgs.claude-desktop;
        keyring = { enable = true; electron = true; };
        defaultFor = [ "x-scheme-handler/claude" ];
      };
    (schemeHandlers = [ "x" ] -> defaultFor = [ "x-scheme-handler/x" ];
    flatpakArgs, args, mimeTypes, settings keep their meaning; name, icon,
    categories, actions, executable, fieldCode, ... are gone.)
    See docs/launchers.md.'';
in {
  imports = [ ./cleanup.nix (removed "flatpaks") (removed "programs") ];

  options.steamFrame.launchers = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule (L.launcherModule { bus = session.bus; }));
    default = { };
    example = lib.literalExpression ''
      {
        "im.riot.Riot" = {
          keyring = { enable = true; electron = true; };
          defaultFor = [ "x-scheme-handler/element" "x-scheme-handler/io.element.desktop" ];
        };
        "org.kde.krdc".keyring.enable = true;
        "com.anthropic.Claude" = {
          source.package = pkgs.claude-desktop;
          keyring = { enable = true; electron = true; };
          defaultFor = [ "x-scheme-handler/claude" ];
        };
      }
    '';
    description = ''
      Desktop entries by desktop ID (without `.desktop`), made from the app's
      own entry (a Flatpak by default) with extra environment, options,
      wrappers and MIME defaults, replacing the original in the KDE menu and
      the "+" menu. See docs/launchers.md.
    '';
  };

  config = lib.mkMerge [ (lib.mkIf (cfg != { }) {
    assertions = lib.concatLists (lib.mapAttrsToList (id: l: [
      {
        assertion = builtins.match "[A-Za-z0-9._-]+" id != null;
        message = "steamFrame.launchers.\"${id}\": not a desktop ID (letters, digits, . _ -; without .desktop).";
      }
      {
        assertion = lib.count (x: x != null) [ l.source.flatpak l.source.package l.source.file ] <= 1;
        message = "steamFrame.launchers.\"${id}\": set only one of source.flatpak, source.package, source.file.";
      }
      {
        assertion = L.kindOf l == "flatpak" || l.flatpakArgs == [ ];
        message = "steamFrame.launchers.\"${id}\": flatpakArgs is only for Flatpaks (use args, env or wrappers).";
      }
      {
        assertion = !l.keyring.electron || l.keyring.enable;
        message = "steamFrame.launchers.\"${id}\": keyring.electron needs keyring.enable.";
      }
      {
        assertion = lib.all (k: builtins.match "[A-Za-z0-9-]+" k != null) (lib.attrNames l.settings)
          && lib.all (v: v == null || !lib.hasInfix "\n" v) (lib.attrValues l.settings);
        message = "steamFrame.launchers.\"${id}\".settings: keys are plain key names (no [locale]), values one line.";
      }
    ]) all)
    ++ lib.mapAttrsToList (m: ds: {
      assertion = lib.length ds == 1;
      message = "steamFrame.launchers: ${m} is in defaultFor of ${lib.concatMapStringsSep " and " (d: "\"${d.id}\"") ds}.";
    }) byMime;

    xdg.dataFile = lib.mapAttrs' (id: _: lib.nameValuePair "applications/${id}.desktop" {
      source = config.lib.file.mkOutOfStoreSymlink "${outDir}/${id}.desktop";
    }) runtimeLaunchers // lib.mapAttrs' (id: l: lib.nameValuePair "applications/${id}.desktop" {
      source = L.packageEntry l;
    }) packageLaunchers;

    xdg.mimeApps = lib.mkIf (defaults != [ ]) {
      enable = true;
      defaultApplications = mimeAttrs;
      associations.added = mimeAttrs;
    };

    home.packages = lib.mkIf (runtimeLaunchers != { }) [ generator ];

    systemd.user.services.steam-frame-nix-launchers = lib.mkIf (runtimeLaunchers != { }) {
      Unit.Description = "steam-frame-nix: desktop entries of steamFrame.launchers";
      Service = {
        Type = "oneshot";
        ExecStart = exe;
      };
      Install.WantedBy = [ "default.target" ];
    };
    # Flatpak touches .changed after installs, updates and removals.
    systemd.user.paths.steam-frame-nix-launchers = lib.mkIf (runtimeLaunchers != { }) {
      Unit.Description = "steam-frame-nix: rewrite launchers when their sources change";
      Path = {
        PathChanged = [
          "${config.xdg.dataHome}/flatpak/.changed"
          "/var/lib/flatpak/.changed"
        ] ++ exportDirs ++ lib.unique (lib.filter (f: f != null)
          (lib.mapAttrsToList (_: l: l.source.file) runtimeLaunchers));
        Unit = "steam-frame-nix-launchers.service";
      };
      Install.WantedBy = [ "default.target" ];
    };
    steamFrame.session.services.start =
      lib.mkIf (runtimeLaunchers != { }) [ "steam-frame-nix-launchers.path" ];
  }) {
    # Also without launchers, to remove entries of ones no longer configured.
    home.activation.steamFrameLaunchers = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      if [[ ! -d ${lib.escapeShellArg session.runtimeDir} ]]; then
        ${lib.optionalString (runtimeLaunchers != { }) ''echo "steam-frame-nix: ${session.runtimeDir} doesn't exist (outer session not running?); launchers are written at its next login" >&2''}
        :
      elif [[ -v DRY_RUN ]]; then
        echo "would run: STEAM_FRAME_NIX_RUNTIME_DIR=${session.runtimeDir} ${exe}"
      else
        STEAM_FRAME_NIX_RUNTIME_DIR=${lib.escapeShellArg session.runtimeDir} ${exe}
      fi
    '';
  } ];
}
