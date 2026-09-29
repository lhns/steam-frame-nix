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
#   desktop gets its own profile, where fullscreen works: the wrapper undoes
#   the fix there while its Firefox runs (firefox/wrapper.nix).
# The launcher (launchers.nix) is the Flatpak's own entry with the wrapper in
# front, same ID, so MIME associations keep working and the "+" menu sees it.
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

  wrapper = pkgs.callPackage ./firefox/wrapper.nix {
    inherit profileDir desktopFix desktopKeys;
    desktopJs = "/app/etc/firefox/${desktopUserJsName}";
  };
in {
  imports = [ ./launchers.nix ];

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
        Make the launcher the default for http, https and text/html (its
        `defaultFor`, in Home Manager's ~/.config/mimeapps.list). Without a
        default the portal opens links with the first installed https
        handler, in both sessions.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    steamFrame.launchers."org.mozilla.firefox" = {
      wrappers = lib.optional (cfg.desktopProfile != null) "${wrapper}";
      defaultFor = lib.optionals cfg.defaultBrowser
        [ "x-scheme-handler/http" "x-scheme-handler/https" "text/html" ];
    };

    # stable: the branch the Flatpak's entry runs (the extension point has no
    # version, so it takes the app's branch).
    xdg.dataFile = lib.mkIf (defaultPrefs != { }) {   # desktopFix implies a pref
      "flatpak/extension/org.mozilla.firefox.systemconfig/aarch64/stable".source = sysconfig;
    };
  };
}
