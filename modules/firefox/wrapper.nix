# The Firefox Flatpak wrapper (firefox.nix, a steamFrame.launchers wrapper):
# gets the entry's full command line (`flatpak run … org.mozilla.firefox …`)
# as its arguments. Outside the nested desktop it just runs it. In the nested
# desktop (KDE) it adds `--profile <desktop profile>` (not to the profile
# manager action, --ProfileManager); with the fullscreen fix it links that
# profile's user.js to the sandbox path desktopJs (undoing the fix there)
# right before Firefox starts, and once Firefox has exited and the profile is
# no longer in use (a second launch that only hands its URL to the running
# Firefox returns at once) removes the link and the value Firefox stored from
# it in prefs.js. A user.js of the user's own is never touched. After a crash
# the next launch or steam-frame-nix-cleanup finishes the removal.
{ lib, writeShellScript, coreutils, findutils, gnugrep
, profileDir             # shell word, e.g. "$HOME/.var/app/…/desktop"
, desktopFix ? false
, desktopJs ? "/app/etc/firefox/steam-frame-nix-desktop-user.js"
, desktopKeys ? [ "full-screen-api.ignore-widgets" ]
}:
writeShellScript "firefox-wrapper" (''
  PATH=${lib.makeBinPath [ coreutils findutils gnugrep ]}:$PATH
  if [ "$XDG_CURRENT_DESKTOP" != KDE ]; then exec "$@"; fi
  for a; do [ "$a" = --ProfileManager ] && exec "$@"; done
  prof="${profileDir}"
  # Firefox exits (status 1) if the --profile dir doesn't exist yet.
  mkdir -p "$prof"
'' + lib.optionalString desktopFix ''
  js=${lib.escapeShellArg desktopJs}
  u=$prof/user.js
  pats=${lib.escapeShellArg (lib.concatMapStringsSep "\n" (k: "user_pref(${builtins.toJSON k},") desktopKeys)}
  # Firefox holds .parentlock open while it uses a profile (the sandbox sees
  # the profile at the same path).
  inUse() { find /proc/[0-9]*/fd -lname "$prof/.parentlock" -print -quit 2>/dev/null | grep -q .; }
  ours() { [ -L "$u" ] && [ "$(readlink "$u")" = "$js" ]; }
  sfn_unlink() {
    ours && ! inUse || return 0
    if [ -f "$prof/prefs.js" ] && grep -qF "$pats" "$prof/prefs.js"; then
      grep -vF "$pats" "$prof/prefs.js" > "$prof/prefs.js.sfn" || true
      cat "$prof/prefs.js.sfn" > "$prof/prefs.js"
      rm -f "$prof/prefs.js.sfn"
    fi
    rm -f "$u"
  }
  if [ -e "$u" ] || [ -L "$u" ]; then
    ours || echo "firefox: $u is not steam-frame-nix's; fullscreen stays inside the window in this profile" >&2
  else
    ln -s "$js" "$u"
  fi
  "$@" --profile "$prof"
  status=$?
  sfn_unlink
  exit $status
'' + lib.optionalString (!desktopFix) ''
  exec "$@" --profile "$prof"
'')
