# Firefox (Flathub Flatpak org.mozilla.firefox) on the Frame.
#
# vrFullscreenFix: real fullscreen is broken in the Steam session: gamescope
# gives the fullscreen X11 window input focus but never shows it, so Firefox
# looks frozen. With ignore-widgets, fullscreen (e.g. YouTube) only fills the
# Firefox window itself, which in VR can be made as large as you like.
# Profile names are random, and flakes can't read $HOME at eval time, so the
# user.js is linked into every existing profile on each switch.
#
# desktopProfile: the Steam session and the nested desktop have separate D-Bus
# buses and displays, so a second Firefox can't find the running one and
# stops at the locked profile. In the nested desktop (XDG_CURRENT_DESKTOP=KDE)
# the launcher uses its own profile instead (the launcher creates the dir,
# Firefox fills it). It gets no user.js: real fullscreen works there.
#
# The launcher's desktop entry shadows the Flatpak's own entry (same ID), so
# MIME/default-browser associations for org.mozilla.firefox.desktop still
# apply, and the Steam "+" menu (which only reads ~/.local/share/applications)
# sees it.
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
      the Firefox Flatpak (org.mozilla.firefox) launcher with Steam Frame fixes'';
    vrFullscreenFix = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Link a user.js setting full-screen-api.ignore-widgets into every
        existing Firefox profile (except the desktop profile), so fullscreen
        fills only the Firefox window instead of freezing in the Steam session.
      '';
    };
    desktopProfile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "desktop";
      description = ''
        Name of the separate profile the launcher uses in the nested desktop
        (XDG_CURRENT_DESKTOP=KDE), so both sessions can run Firefox at once.
        null uses the default profile in both sessions.
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
