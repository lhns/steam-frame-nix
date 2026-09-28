# Firefox Flatpak (org.mozilla.firefox) launcher.
# - prefs and vrFullscreenFix are default prefs (pref(), the default branch:
#   never written to prefs.js, so removing one leaves nothing behind). Firefox
#   reads defaults/pref/*.js from its system config dir, /app/etc/firefox in
#   the Flatpak, the mount point of the org.mozilla.firefox.systemconfig
#   extension. The user installation's "unmaintained extension" dir
#   ($XDG_DATA_HOME/flatpak/extension/<id>/<arch>/<branch>) provides it: a
#   home-manager link to a store dir, which Flatpak mounts itself (the
#   sandbox needn't see /nix).
# - vrFullscreenFix: in the Steam session gamescope focuses a fullscreen X11
#   window but never shows it (Firefox looks frozen). ignore-widgets keeps
#   fullscreen inside the window.
# - desktopProfile: the sessions have separate buses/displays, so a second
#   Firefox can't reach the running one and hits the profile lock; the nested
#   desktop gets its own profile. Fullscreen works there, so the fix is undone
#   by a user.js in that profile: a link to the extension's
#   steam-frame-nix-desktop-user.js (a sandbox path; dangling on the host).
# - profileSync (on switch and before each launch) keeps those links and
#   removes what older versions wrote: user.js copies starting with `marker`
#   and links to *-firefox-*user.js store files, whose user_pref values
#   Firefox had stored in prefs.js. They are taken out of prefs.js too, which
#   needs the profile closed; profiles in use are left for the next run.
# The entry shadows the Flatpak's (same ID), keeping MIME associations, and is
# seen by the "+" menu (which reads only ~/.local/share/applications).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.firefox;
  ffDir = "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox";
  profileDir = "${ffDir}/${cfg.desktopProfile}";

  defaultPrefs = lib.optionalAttrs cfg.disableAv1 { "media.av1.enabled" = false; }
    // lib.optionalAttrs cfg.vrFullscreenFix { "full-screen-api.ignore-widgets" = true; }
    // cfg.prefs;
  desktopFix = cfg.enable && cfg.vrFullscreenFix && cfg.desktopProfile != null;
  # Only ever this one pref (profileSync relies on it).
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

  # Written by versions that copied user.js into every profile.
  marker = "// Managed by steam-frame-nix (steamFrame.firefox); rewritten on switch.";

  profileSync = pkgs.writeShellScript "firefox-profile-sync" ''
    PATH=${lib.makeBinPath (with pkgs; [ coreutils diffutils findutils gnugrep gnused ])}
    ffDir="${ffDir}"
    desktopJs=/app/etc/firefox/${desktopUserJsName}
    [ -d "$ffDir" ] || exit 0

    # Firefox holds .parentlock open while it uses a profile (the sandbox
    # sees the profile at the same path).
    inUse() { find /proc/[0-9]*/fd -lname "$1/.parentlock" -print -quit 2>/dev/null | grep -q .; }
    keysOf() { sed -n 's/^[[:space:]]*user_pref(\("[^"]*"\),.*/\1/p' "$1" 2>/dev/null; }

    for prof in "$ffDir"/*/; do
      prof=''${prof%/}; name=''${prof##*/}
      [ -f "$prof/prefs.js" ] || [ "$name" = ${lib.escapeShellArg (toString cfg.desktopProfile)} ] || continue
      want= wantKeys=
      ${lib.optionalString desktopFix ''
        [ "$name" = ${lib.escapeShellArg cfg.desktopProfile} ] &&
          want=$desktopJs wantKeys=${lib.escapeShellArg (lib.concatMapStrings (k: builtins.toJSON k + "\n") desktopKeys)}
      ''}
      userJs=$prof/user.js
      if [ -L "$userJs" ]; then
        case $(readlink "$userJs") in
          "$want") continue ;;
          "$desktopJs") oldKeys=${lib.escapeShellArg (lib.concatMapStrings (k: builtins.toJSON k + "\n") desktopKeys)} ;;
          /nix/store/*-firefox-user.js|/nix/store/*-firefox-desktop-user.js) oldKeys=$(keysOf "$userJs") ;;
          *) oldKeys=foreign ;;
        esac
      elif [ -f "$userJs" ]; then
        if [ "$(head -n1 "$userJs")" = ${lib.escapeShellArg marker} ]; then oldKeys=$(keysOf "$userJs"); else oldKeys=foreign; fi
      elif [ -e "$userJs" ]; then oldKeys=foreign
      else oldKeys=
      fi
      if [ "$oldKeys" = foreign ]; then
        [ -z "$want" ] || echo "firefox: skipping $userJs (not managed by steam-frame-nix, move it away to adopt)"
        continue
      fi

      if [ -e "$userJs" ] || [ -L "$userJs" ]; then
        # Values our user.js set, no longer set by one: out of prefs.js.
        keys=$(printf '%s\n' "$oldKeys" | grep -vxF -f <(printf '%s\n' "$wantKeys") | grep .)
        if [ -n "$keys" ]; then
          if inUse "$prof"; then
            echo "firefox: $name is in use; its old user.js stays until the next switch or launch with Firefox closed"
            continue
          fi
          grep -vF "$(sed 's/.*/user_pref(&,/' <<< "$keys")" "$prof/prefs.js" > "$prof/prefs.js.sfn" || true
          if cmp -s "$prof/prefs.js" "$prof/prefs.js.sfn"; then rm "$prof/prefs.js.sfn"
          else cat "$prof/prefs.js.sfn" > "$prof/prefs.js"; rm "$prof/prefs.js.sfn"; echo "firefox: $name: removed from prefs.js:" $keys
          fi
        fi
        rm -f "$userJs"
      fi
      if [ -n "$want" ]; then ln -s "$want" "$userJs"; fi
    done
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
    ${profileSync} >&2 || true
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
        Default full-screen-api.ignore-widgets to true (except in the desktop
        profile), so fullscreen fills the window instead of freezing in the
        Steam session.
      '';
    };
    disableAv1 = lib.mkOption {
      type = lib.types.bool;
      default = true;
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
        Profile used in the nested desktop, so both sessions can run Firefox at
        once; null = default profile in both.
      '';
    };
  };

  config = lib.mkMerge [
    {
      # Always, so disabling removes our user.js links (and old copies).
      home.activation.firefoxProfiles =
        lib.hm.dag.entryAfter [ "writeBoundary" ] "run ${profileSync}\n";
    }
    (lib.mkIf cfg.enable {
      # stable: the branch the launcher runs (the extension point has no
      # version, so it takes the app's branch).
      xdg.dataFile = lib.optionalAttrs (defaultPrefs != { } || desktopFix) {
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
    })
  ];
}
