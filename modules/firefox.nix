# Firefox Flatpak (org.mozilla.firefox) launcher.
# - prefs and vrFullscreenFix are default prefs (pref(): never written to
#   prefs.js, so removing one leaves nothing behind) in defaults/pref/ of the
#   org.mozilla.firefox.systemconfig extension (/app/etc/firefox), provided
#   as the user installation's "unmaintained extension"
#   ($XDG_DATA_HOME/flatpak/extension/<id>/<arch>/<branch>): a Home Manager
#   link to a store dir, which Flatpak mounts itself (the sandbox needn't see
#   /nix).
# - vrFullscreenFix: in the Steam session gamescope focuses a fullscreen X11
#   window but never shows it (Firefox looks frozen). ignore-widgets keeps
#   fullscreen inside the window.
# - desktopProfile: the sessions have separate buses/displays, so a second
#   Firefox can't reach the running one and hits the profile lock; the nested
#   desktop gets its own profile, where fullscreen works: the launcher undoes
#   the fix there while its Firefox runs (firefox/launcher.nix).
# The entry shadows the Flatpak's (same ID), keeping MIME associations, and is
# seen by the "+" menu (which reads only ~/.local/share/applications).
# defaultBrowser: without a default the portal picks the first installed
# https handler (e.g. Chromium) in both sessions.
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.firefox;
  ffDir = "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox";
  profileDir = "${ffDir}/${cfg.desktopProfile}";

  defaultPrefs = lib.optionalAttrs cfg.disableAv1 { "media.av1.enabled" = false; }
    // lib.optionalAttrs cfg.vrFullscreenFix { "full-screen-api.ignore-widgets" = true; }
    // cfg.prefs;
  desktopFix = cfg.enable && cfg.vrFullscreenFix && cfg.desktopProfile != null;
  # Only ever this one pref (steam-frame-nix-cleanup relies on it).
  desktopKeys = [ "full-screen-api.ignore-widgets" ];
  desktopUserJsName = "steam-frame-nix-desktop-user.js";

  sysconfig = pkgs.runCommand "steam-frame-nix-firefox-systemconfig" { } (''
    mkdir -p $out/defaults/pref
    cp ${pkgs.writeText "steam-frame-nix.js" (lib.concatStrings (lib.mapAttrsToList
      (k: v: "pref(${builtins.toJSON k}, ${builtins.toJSON v});\n") defaultPrefs))} \
      $out/defaults/pref/steam-frame-nix.js
  '' + lib.optionalString desktopFix ''
    cp ${pkgs.writeText desktopUserJsName (lib.concatMapStrings
      (k: "user_pref(${builtins.toJSON k}, false);\n") desktopKeys)} $out/${desktopUserJsName}
  '');

  firefox = pkgs.callPackage ./firefox/launcher.nix {
    profileDir = if cfg.desktopProfile == null then null else profileDir;
    inherit desktopFix desktopKeys;
    desktopJs = "/app/etc/firefox/${desktopUserJsName}";
  };
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.firefox = {
    enable = lib.mkEnableOption ''
      the Firefox Flatpak (org.mozilla.firefox) launcher with Steam Frame
      fixes'';
    vrFullscreenFix = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Default full-screen-api.ignore-widgets to true (except in the desktop
        profile), so fullscreen fills the window instead of freezing in the
        Steam session.
      '';
    };
    disableAv1 = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Default media.av1.enabled to false: the Frame's decoder driver has no
        AV1 (H.264, HEVC, VP9 only), so sites like YouTube send VP9/H.264,
        decoded in hardware, instead of software-decoded AV1.
      '';
    };
    prefs = lib.mkOption {
      type = with lib.types; attrsOf (oneOf [ bool int str ]);
      default = { };
      example = { "media.autoplay.default" = 5; };
      description = ''
        Further about:config preferences for every profile (desktop one
        included), as default values: about:config can still change them for
        a profile, and removing one here leaves nothing behind. Override the
        fixes above too. Take effect at the next start of Firefox.
      '';
    };
    desktopProfile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "desktop";
      description = ''
        Profile (directory name under the Flatpak's
        ~/.var/app/org.mozilla.firefox/config/mozilla/firefox) used in the
        nested desktop, so both sessions can run Firefox at once; created on
        first use, a normal profile with its own browser data. null = the
        default profile in both sessions.
      '';
    };
    defaultBrowser = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Make the launcher the default for http, https and text/html (in
        Home Manager's ~/.config/mimeapps.list). Without a default the
        portal opens links with the first installed https handler, in both
        sessions.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    xdg.mimeApps = lib.mkIf cfg.defaultBrowser {
      enable = true;
      defaultApplications = lib.genAttrs
        [ "x-scheme-handler/http" "x-scheme-handler/https" "text/html" ]
        (_: "org.mozilla.firefox.desktop");
    };

    # stable: the branch the launcher runs (the extension point has no
    # version, so it takes the app's branch).
    xdg.dataFile = lib.optionalAttrs (defaultPrefs != { }) {   # desktopFix implies a pref
      "flatpak/extension/org.mozilla.firefox.systemconfig/aarch64/stable".source = sysconfig;
    } // {
    "applications/org.mozilla.firefox.desktop".text = ''
      [Desktop Entry]
      Type=Application
      Name=Firefox
      GenericName=Web Browser
      Icon=org.mozilla.firefox
      Exec=${firefox} @@u %u @@
      StartupWMClass=firefox
      StartupNotify=true
      Terminal=false
      Categories=Network;WebBrowser;
      MimeType=application/json;application/pdf;application/rdf+xml;application/rss+xml;application/x-xpinstall;application/xhtml+xml;application/xml;audio/flac;audio/ogg;audio/webm;image/avif;image/gif;image/jpeg;image/png;image/svg+xml;image/webp;text/html;text/xml;video/ogg;video/webm;x-scheme-handler/chrome;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/mailto;
      Actions=new-window;new-private-window;

      [Desktop Action new-window]
      Name=New Window
      Exec=${firefox} --new-window @@u %u @@

      [Desktop Action new-private-window]
      Name=New Private Window
      Exec=${firefox} --private-window @@u %u @@
    '';
    };
  };
}
