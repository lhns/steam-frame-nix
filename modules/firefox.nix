# Firefox Flatpak (org.mozilla.firefox) launcher.
# - vrFullscreenFix: in the Steam session gamescope focuses a fullscreen X11
#   window but never shows it (Firefox looks frozen). ignore-widgets keeps
#   fullscreen inside the window. Profile names are random and $HOME isn't
#   readable at eval time, so user.js is linked into each profile on switch.
# - desktopProfile: the sessions have separate buses/displays, so a second
#   Firefox can't reach the running one and hits the profile lock; the nested
#   desktop gets its own profile (no user.js: fullscreen works there).
# The entry shadows the Flatpak's (same ID), keeping MIME associations, and is
# seen by the "+" menu (which reads only ~/.local/share/applications).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.firefox;
  userJs = pkgs.writeText "firefox-user.js" ''
    user_pref("full-screen-api.ignore-widgets", true);
  '';
  ffDir = "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox";
  profileDir = "${ffDir}/${cfg.desktopProfile}";
  skipDesktopProfile = lib.optionalString (cfg.desktopProfile != null)
    ''[ "$(basename "$prof")" = ${lib.escapeShellArg cfg.desktopProfile} ] && continue'';

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
        Link a user.js (full-screen-api.ignore-widgets) into every existing
        profile except the desktop one, so fullscreen fills the window instead
        of freezing in the Steam session.
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
    home.activation.firefoxUserJs = lib.mkIf cfg.vrFullscreenFix
      (lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        for prof in "${ffDir}"/*/; do
          ${skipDesktopProfile}
          [ -f "$prof/prefs.js" ] || continue            # only real profiles
          target="$prof/user.js"
          if [ -e "$target" ] && [ ! -L "$target" ]; then
            echo "firefox: skipping $target (not managed by us, move it away to adopt)"
            continue
          fi
          run ln -sfn ${userJs} "$target"
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
