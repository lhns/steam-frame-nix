# Firefox Flatpak (org.mozilla.firefox) launcher.
# - vrFullscreenFix: in the Steam session gamescope focuses a fullscreen X11
#   window but never shows it (Firefox looks frozen). ignore-widgets keeps
#   fullscreen inside the window. Profile names are random and $HOME isn't
#   readable at eval time, so user.js is linked into each profile on switch.
# - desktopProfile: the sessions have separate buses/displays, so a second
#   Firefox can't reach the running one and hits the profile lock; the nested
#   desktop gets its own profile (no fullscreen fix: fullscreen works there).
# - prefs: about:config values for every profile, desktop one included.
# The entry shadows the Flatpak's (same ID), keeping MIME associations, and is
# seen by the "+" menu (which reads only ~/.local/share/applications).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.firefox;
  toUserJs = name: prefs: pkgs.writeText name (lib.concatStrings (lib.mapAttrsToList
    (k: v: "user_pref(${builtins.toJSON k}, ${builtins.toJSON v});\n") prefs));
  vrPrefs = cfg.prefs // lib.optionalAttrs cfg.vrFullscreenFix { "full-screen-api.ignore-widgets" = true; };
  userJs = toUserJs "firefox-user.js" vrPrefs;
  desktopUserJs = toUserJs "firefox-desktop-user.js" cfg.prefs;
  ffDir = "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox";
  profileDir = "${ffDir}/${cfg.desktopProfile}";
  # user.js for a profile dir ($prof): desktop profile -> prefs only.
  pickUserJs = if cfg.desktopProfile == null then "js=${userJs}" else ''
    js=${userJs}
    [ "$(basename "$prof")" = ${lib.escapeShellArg cfg.desktopProfile} ] && js=${desktopUserJs}
  '';

  firefox = pkgs.writeShellScript "firefox-launcher" (''
    profile=()
  '' + lib.optionalString (cfg.desktopProfile != null) ''
    if [ "$XDG_CURRENT_DESKTOP" = KDE ]; then
      # Firefox exits (status 1) if the --profile dir doesn't exist yet.
      mkdir -p "${profileDir}"
      profile=(--profile "${profileDir}")
    fi
  '' + ''
    exec /usr/bin/flatpak run --branch=stable --arch=aarch64 --command=firefox \
      --file-forwarding org.mozilla.firefox "''${profile[@]}" "$@"
  '');
in {
  options.steamFrame.firefox = {
    enable = lib.mkEnableOption ''
      the Firefox Flatpak (org.mozilla.firefox) launcher with Steam Frame
      fixes'';
    vrFullscreenFix = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Set full-screen-api.ignore-widgets in every profile except the
        desktop one, so fullscreen fills the window instead of freezing in the
        Steam session.
      '';
    };
    prefs = lib.mkOption {
      type = with lib.types; attrsOf (oneOf [ bool int str ]);
      default = { };
      example = { "media.av1.enabled" = false; };
      description = ''
        about:config preferences for every profile (desktop one included),
        set through a linked user.js on each switch. E.g. media.av1.enabled =
        false: the Frame's decoder has no AV1, so sites like YouTube fall back
        to VP9/H.264, which it decodes in hardware.
      '';
    };
    desktopProfile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "desktop";
      description = ''
        Profile used in the nested desktop, so both sessions can run Firefox at
        once; null = default profile in both.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Linked into every existing profile (profile names are random); an empty
    # user.js is harmless and keeps turning prefs off revertible.
    home.activation.firefoxUserJs =
      (lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        for prof in "${ffDir}"/*/; do
          [ -f "$prof/prefs.js" ] || continue            # only real profiles
          ${pickUserJs}
          target="$prof/user.js"
          if [ -e "$target" ] && [ ! -L "$target" ]; then
            echo "firefox: skipping $target (not managed by us, move it away to adopt)"
            continue
          fi
          run ln -sfn "$js" "$target"
        done
      '');

    xdg.dataFile."applications/org.mozilla.firefox.desktop".text = ''
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
}
