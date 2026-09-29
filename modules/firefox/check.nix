# Checks of the Firefox wrapper's desktop profile user.js (wrapper.nix)
# against a fake flatpak: the link exists only while Firefox runs, a second
# launch that hands over to the running Firefox doesn't remove it, the value
# Firefox stored from it leaves prefs.js once the profile is unlocked, a
# user.js of the user's own is never touched, the profile manager action and
# the Steam session get no --profile.
{ pkgs }:
let
  # Fake `flatpak run … org.mozilla.firefox --profile DIR …`: with the
  # profile locked by another process it "forwards" and returns; otherwise it
  # holds .parentlock, records user.js and stores the pref like Firefox does,
  # and runs until $FAKE/release exists.
  fakeFlatpak = pkgs.writeShellScript "flatpak" ''
    while [ $# -gt 0 ] && [ "$1" != --profile ]; do shift; done
    [ $# -gt 0 ] || { echo "default profile" >> $FAKE/log; exit 0; }
    prof=$2
    if find /proc/[0-9]*/fd -lname "$prof/.parentlock" -print -quit 2>/dev/null | grep -q .; then
      echo forwarded >> $FAKE/log; exit 0
    fi
    touch "$prof/.parentlock"; exec 9< "$prof/.parentlock"
    echo "started $(readlink "$prof/user.js" || echo none)" >> $FAKE/log
    [ -L "$prof/user.js" ] && echo 'user_pref("full-screen-api.ignore-widgets", false);' >> "$prof/prefs.js"
    while [ ! -e $FAKE/release ]; do sleep 0.1; done
    exit 3
  '';
  wrapper = pkgs.callPackage ./wrapper.nix {
    profileDir = "$HOME/ff/desktop";
    desktopFix = true;
  };
  # What the launcher's Exec= runs: the wrapper, then the Flatpak's command.
  launcher = "${wrapper} ${fakeFlatpak} run --branch=stable --arch=aarch64 --command=firefox --file-forwarding org.mozilla.firefox";
in
pkgs.runCommand "firefox-check" { nativeBuildInputs = [ pkgs.findutils pkgs.gnugrep ]; } ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; cat $FAKE/log >&2 || true; exit 1; }
  export HOME=$PWD/home FAKE=$PWD/fake XDG_CURRENT_DESKTOP=KDE
  mkdir -p $HOME $FAKE; : > $FAKE/log
  p=$HOME/ff/desktop

  # first launch: link made, Firefox runs
  ${launcher} @@u https://example.org @@ & first=$!
  for i in $(seq 100); do grep -q started $FAKE/log && break; sleep 0.1; done
  grep -qx 'started /app/etc/firefox/steam-frame-nix-desktop-user.js' $FAKE/log || fail "not linked at start"
  echo 'user_pref("other", 1);' >> $p/prefs.js
  # second launch: hands over, returns, cleans nothing
  ${launcher} https://example.com
  grep -qx forwarded $FAKE/log || fail "no forward"
  [ -L $p/user.js ] || fail "second launch removed the link"
  # Firefox exits: link and value gone, exit status passed on
  touch $FAKE/release
  status=0; wait $first || status=$?
  [ $status = 3 ] || fail "status $status"
  [ ! -e $p/user.js ] && [ ! -L $p/user.js ] || fail "link left"
  [ "$(cat $p/prefs.js)" = 'user_pref("other", 1);' ] || fail "prefs.js: $(cat $p/prefs.js)"

  # a user.js of the user's own: untouched
  echo 'user_pref("mine", 1);' > $p/user.js
  echo 'user_pref("full-screen-api.ignore-widgets", false);' >> $p/prefs.js
  ${launcher} || true
  [ "$(cat $p/user.js)" = 'user_pref("mine", 1);' ] || fail "own user.js changed"
  grep -q ignore-widgets $p/prefs.js || fail "prefs.js changed with an own user.js"
  rm $p/user.js

  # profile manager action: no --profile, no link
  : > $FAKE/log
  ${launcher} --ProfileManager || true
  grep -qx 'default profile' $FAKE/log || fail "--profile with --ProfileManager"
  [ ! -e $p/user.js ] || fail "linked for the profile manager"

  # Steam session: default profile, no link
  : > $FAKE/log
  XDG_CURRENT_DESKTOP=gamescope ${launcher} || true
  grep -qx 'default profile' $FAKE/log || fail "used --profile in the Steam session"
  [ ! -e $p/user.js ] || fail "linked in the Steam session"
  echo ok
  touch $out
''
